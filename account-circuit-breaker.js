import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "circuit-breaker-state.json");
const TMP_FILE = STATE_FILE + ".tmp";

export const DAILY_LOSS_CAP_SOL = 0.10;
export const DAILY_LOSS_CAP_PCT = 30.0;

export class CircuitBreakerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CircuitBreakerError";
    this.details = details;
  }
}

// Single-shot override: honoured once per process lifetime
let _overrideConsumed = false;

// One-time Telegram import (lazy to avoid circular deps)
let _notify = null;
async function fireAlert(state) {
  try {
    if (!_notify) {
      const mod = await import("./telegram.js");
      _notify = mod.notifyCircuitBreaker;
    }
    await _notify(state);
  } catch (e) {
    log("circuit_error", `Telegram alert failed: ${e.message}`);
  }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return "CORRUPT";
  }
}

function persistState(state) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(state, null, 2));
  fs.renameSync(TMP_FILE, STATE_FILE);
}

function freshState(startingBalanceSol) {
  return {
    date: todayUtc(),
    starting_balance_sol: startingBalanceSol,
    realized_loss_sol: 0,
    realized_loss_pct: 0,
    positions_closed_today: 0,
    losing_closes_today: 0,
    winning_closes_today: 0,
    halted: false,
    halt_reason: null,
    halted_at: null,
    last_alert_sent_at: null,
    override_consumed_at: null,
    schema_version: 1,
  };
}

// Returns current state, handling first-run and rollover.
// walletBalanceSol required only on first call of the day.
function getOrInitState(walletBalanceSol) {
  const raw = loadState();
  if (raw === "CORRUPT") {
    log("circuit_warn", "State file corrupt — fail-safe halt");
    return null; // caller treats null as halted
  }
  const today = todayUtc();
  if (!raw || raw.date !== today) {
    if (walletBalanceSol == null || !Number.isFinite(walletBalanceSol)) {
      log("circuit_warn", "Cannot init circuit breaker — wallet balance unreadable");
      return null; // fail-safe halt
    }
    const state = freshState(walletBalanceSol);
    persistState(state);
    log("circuit", `Daily reset — new day ${today}, starting balance ${walletBalanceSol} SOL`);
    return state;
  }
  return raw;
}

// Test-only injection hook: lets test harness mock wallet.getWalletBalances
// without touching real RPC. Production code never sets this.
let _walletFetchOverride = null;
export function __setWalletFetchForTest(fn) { _walletFetchOverride = fn; }

// Async wrapper around getOrInitState that, on day-rollover with a null/non-finite
// walletBalanceSol, performs ONE internal retry via tools/wallet.js before
// falling back to the existing fail-safe (null = halt).
async function getOrInitStateAsync(walletBalanceSol) {
  // Fast path: caller supplied a usable balance — no retry needed.
  if (walletBalanceSol != null && Number.isFinite(walletBalanceSol)) {
    return getOrInitState(walletBalanceSol);
  }
  // Only attempt retry if we're actually on the day-rollover branch.
  const raw = loadState();
  const today = todayUtc();
  const onRolloverBranch = raw === "CORRUPT" ? false : (!raw || raw.date !== today);
  if (!onRolloverBranch) {
    // Existing day — no balance needed; delegate to sync path.
    return getOrInitState(walletBalanceSol);
  }
  // Day-rollover + null balance → attempt one self-fetch.
  let fetched = null;
  try {
    const fetcher = _walletFetchOverride
      ? _walletFetchOverride
      : (await import("./tools/wallet.js")).getWalletBalances;
    const result = await fetcher();
    const sol = result?.sol;
    if (sol != null && Number.isFinite(sol)) {
      fetched = sol;
      log("circuit_recover", `Self-fetched balance=${sol} SOL during day-rollover init`);
    }
  } catch (e) {
    log("circuit_warn", `Self-fetch failed during day-rollover init: ${e.message}`);
  }
  // Either the retry produced a usable balance (seed state) or it failed
  // (fall through to existing null fail-safe behavior).
  return getOrInitState(fetched);
}

/**
 * Throws CircuitBreakerError if today's realized loss has hit either cap.
 * Call BEFORE deploy_position (inside runSafetyChecks).
 * @param {number} walletBalanceSol - current live SOL balance (used for first-of-day seed)
 */
export async function assertCircuitOK(walletBalanceSol) {
  const state = await getOrInitStateAsync(walletBalanceSol);

  if (!state) {
    throw new CircuitBreakerError(
      "Circuit breaker state unreadable — manual intervention required before deploy",
      { reason: "state_unreadable" }
    );
  }

  if (!state.halted) return; // fast path — not halted

  // Check single-shot override
  const overrideEnv = process.env.CIRCUIT_BREAKER_OVERRIDE === "true";
  if (overrideEnv && !_overrideConsumed) {
    _overrideConsumed = true;
    state.override_consumed_at = new Date().toISOString();
    persistState(state);
    log("circuit_override", `Override consumed — single deploy permitted. Halt reason was: ${state.halt_reason}`);
    return; // allow this one deploy
  }

  throw new CircuitBreakerError(
    `Circuit breaker tripped: ${state.halt_reason}. Realized loss: ${state.realized_loss_sol.toFixed(4)} SOL (${state.realized_loss_pct.toFixed(1)}%). Use CIRCUIT_BREAKER_OVERRIDE=true for one manual deploy.`,
    { state }
  );
}

/**
 * Record a closed position's realized P&L toward the daily cap.
 * Positive closes increment winning_closes but do NOT offset losses (one-way ratchet).
 * @param {{ pnl_pct: number, amount_sol: number, pool: string, pool_name: string, reason: string }} closeEvent
 */
export async function recordRealizedLoss({ pnl_pct, amount_sol, pool, pool_name, reason } = {}) {
  const state = getOrInitState(null); // no wallet needed after first init of the day
  if (!state) return; // fail-safe: already halted or corrupt, nothing to update

  const pct = Number(pnl_pct ?? 0);
  const sol = Number(amount_sol ?? 0);

  state.positions_closed_today += 1;

  if (pct < 0 && sol > 0) {
    const lossSol = sol * (-pct / 100);
    state.realized_loss_sol = parseFloat((state.realized_loss_sol + lossSol).toFixed(6));
    state.realized_loss_pct = state.starting_balance_sol > 0
      ? parseFloat(((state.realized_loss_sol / state.starting_balance_sol) * 100).toFixed(2))
      : 0;
    state.losing_closes_today += 1;
    log("circuit", `Loss recorded: ${lossSol.toFixed(4)} SOL (${pct.toFixed(2)}%) — pool ${pool_name || pool}. Running loss: ${state.realized_loss_sol.toFixed(4)} SOL`);
  } else {
    state.winning_closes_today += 1;
  }

  // Evaluate caps
  const wasHalted = state.halted;
  const solCapHit = state.realized_loss_sol >= DAILY_LOSS_CAP_SOL;
  const pctCapHit = state.realized_loss_pct >= DAILY_LOSS_CAP_PCT;

  if (!wasHalted && (solCapHit || pctCapHit)) {
    state.halted = true;
    state.halt_reason = solCapHit
      ? `Daily SOL loss cap hit (${state.realized_loss_sol.toFixed(4)} SOL ≥ ${DAILY_LOSS_CAP_SOL} SOL)`
      : `Daily % loss cap hit (${state.realized_loss_pct.toFixed(1)}% ≥ ${DAILY_LOSS_CAP_PCT}%)`;
    state.halted_at = new Date().toISOString();
    state.last_alert_sent_at = new Date().toISOString();
    log("circuit_halt", state.halt_reason);
    persistState(state);
    await fireAlert(state);
    return;
  }

  persistState(state);
}

/**
 * Read-only circuit status snapshot.
 *
 * IMPORTANT: this is DISPLAY/STATUS ONLY — it does NOT gate deploys.
 * It reads state directly (loadState) rather than going through
 * getOrInitState(null), because getOrInitState collapses two very
 * different conditions into the same null:
 *   (1) benign "not-yet-seeded-today" — no state for the current UTC day
 *       yet (fresh install, or day-rollover before the first balance read).
 *       The breaker is ARMED and will seed on the next deploy check; this is
 *       NOT a halt and must not surface as one.
 *   (2) real "corrupt/unreadable file" — the state file exists but cannot be
 *       parsed. This IS a genuine problem → halt / state_unreadable.
 * Deploy safety is unchanged: assertCircuitOK() still fail-closes on BOTH
 * conditions (a null from getOrInitStateAsync blocks the deploy). This
 * function only fixes the STATUS reporting so a benign day-rollover no
 * longer shows a false "HALTED — state_unreadable".
 */
export function getCircuitStatus() {
  const raw = loadState();

  // (2) Real problem: file present but unparseable → genuine halt.
  if (raw === "CORRUPT") {
    return {
      halted: true,
      halt_reason: "state_unreadable",
      realized_loss_sol: 0,
      realized_loss_pct: 0,
      cap_sol: DAILY_LOSS_CAP_SOL,
      cap_pct: DAILY_LOSS_CAP_PCT,
      pct_to_cap_sol: 0,
      pct_to_cap_pct: 0,
      positions_closed_today: 0,
      date: todayUtc(),
    };
  }

  const today = todayUtc();

  // (1) Benign: no state for today yet (fresh install or UTC-day rollover
  // before the first balance read). Breaker is armed, not halted. On the
  // next deploy check the daily cap resets fresh anyway (new UTC day), so
  // reporting not-halted here is consistent with actual deploy behavior.
  if (!raw || raw.date !== today) {
    return {
      halted: false,
      pending_seed: true,
      halt_reason: null,
      status: "armed_pending_seed",
      realized_loss_sol: 0,
      realized_loss_pct: 0,
      cap_sol: DAILY_LOSS_CAP_SOL,
      cap_pct: DAILY_LOSS_CAP_PCT,
      pct_to_cap_sol: 0,
      pct_to_cap_pct: 0,
      positions_closed_today: 0,
      date: today,
    };
  }

  const state = raw;
  return {
    date: state.date,
    starting_balance_sol: state.starting_balance_sol,
    realized_loss_sol: state.realized_loss_sol,
    realized_loss_pct: state.realized_loss_pct,
    cap_sol: DAILY_LOSS_CAP_SOL,
    cap_pct: DAILY_LOSS_CAP_PCT,
    pct_to_cap_sol: Math.min(100, (state.realized_loss_sol / DAILY_LOSS_CAP_SOL) * 100),
    pct_to_cap_pct: Math.min(100, (state.realized_loss_pct / DAILY_LOSS_CAP_PCT) * 100),
    positions_closed_today: state.positions_closed_today,
    losing_closes_today: state.losing_closes_today,
    winning_closes_today: state.winning_closes_today,
    halted: state.halted,
    halt_reason: state.halt_reason,
    halted_at: state.halted_at,
  };
}

/**
 * Manual re-arm for current UTC day. Bro Dikta only via /circuit reset.
 */
export function manualReset(reason = "manual override") {
  const state = getOrInitState(null);
  const base = state || freshState(0);
  base.halted = false;
  base.halt_reason = null;
  base.halted_at = null;
  _overrideConsumed = false;
  persistState(base);
  log("circuit_reset", `Manual reset: ${reason}`);
  return { reset: true, reason };
}
