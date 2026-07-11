/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

// Vega — entry_features normalizer (data-collection mode, 2026-07-10). Guarantees
// every position record carries a well-shaped 5-field entry_features object. Raw
// data for direction-gating (#2). FAIL-SAFE (anti-pattern #2): each field is coerced
// to a finite number or null — NEVER fabricated. buy_sell_flow_ratio is threaded
// pre-computed by the deploy path (dlmm.buildEntryFeatures); here we only coerce.
function normalizeEntryFeatures(ef) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const src = ef && typeof ef === "object" ? ef : {};
  return {
    sol_regime_24h_pct: num(src.sol_regime_24h_pct),
    token_price_change_1h: num(src.token_price_change_1h),
    token_price_change_24h: num(src.token_price_change_24h),
    buy_sell_flow_ratio: num(src.buy_sell_flow_ratio),
    mcap: num(src.mcap),
  };
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  is_bluechip = false,
  signal_snapshot = null,
  entry_features = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    // Vega — bluechip flag (LST-SOL income-engine). Persisted at deploy so the
    // OOR handler can apply patient-OOR-UP handling (single-side SOL slot-Y
    // goes OOR-UP on the first up-tick = thesis, not a stop). Default false →
    // memecoin path unchanged. bluechipPatientOorEnabled gates the live effect.
    is_bluechip: is_bluechip === true,
    signal_snapshot: signal_snapshot || null,
    // Vega — entry_features (data-collection mode). Snapshot of the market/token
    // context at deploy for later direction-gating (#2). Threaded from the in-cycle
    // screening enrichment + market-regime read (NO new API call). Null fields where
    // a value was unavailable at deploy (fail-safe, never fabricated).
    entry_features: normalizeEntryFeatures(entry_features),
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    // Vega Item 2B — partial-TP scale-out fires ONCE per position. This flag
    // is the idempotency guard: once true, updatePnlAndCheckExits never returns
    // PARTIAL_TP again for this position. Survives restarts (persisted).
    partial_tp_done: false,
    partial_tp_at: null,
    // Vega EXIT-3 #1 — break-even stop arm flag (idempotent, persisted). Once a
    // position peaks >= breakEvenArmPct (fee-inclusive), be_armed flips true and
    // the effective stop ratchets UP from the fixed SL to break-even — it NEVER
    // ratchets back down (a later dip cannot disarm it). Mirrors the
    // partial_tp_done / trailing_active idempotency pattern. Default false = the
    // fixed SL is the only floor (legacy).
    be_armed: false,
    be_armed_at: null,
    // Vega EXIT-3 #2 — fee-decay baseline. The fee-accrual rate at deploy
    // (initial_fee_tvl_24h, set above) IS the baseline; this records the
    // earliest in-window snapshot rate so a collapse is measured against a real
    // early reading, not the entry estimate alone. Populated lazily on the first
    // post-warmup tick; null until then (fail-safe: no baseline → no decay exit).
    fee_decay_baseline: null,
    fee_decay_baseline_at: null,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Vega Item 2B — mark a position's partial TP as executed (idempotent guard).
 * Returns true if it flipped false→true, false if it was already done (so the
 * caller can detect a double-fire attempt and skip the on-chain TX).
 */
export function markPartialTpDone(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  if (pos.partial_tp_done) return false; // already done — refuse to re-arm
  pos.partial_tp_done = true;
  pos.partial_tp_at = new Date().toISOString();
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  pos.notes.push(`Partial TP executed at ${pos.partial_tp_at}`);
  save(state);
  log("state", `Position ${position_address} partial TP marked done`);
  return true;
}

/**
 * Vega Item 9 — record a successful re-center (rebalance-on-OOR).
 * Increments rebalance_count, clears the OOR timer (the position just
 * re-centered on the current active bin, so it is in-range again), and
 * appends a note. Returns the NEW rebalance_count, or null if the position
 * is missing/closed (caller should treat that as "do not proceed").
 */
export function recordRebalance(position_address, detail = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;
  pos.rebalance_count = Number(pos.rebalance_count ?? 0) + 1;
  pos.out_of_range_since = null; // re-centered → back in range
  pos.notes = Array.isArray(pos.notes) ? pos.notes : [];
  const at = new Date().toISOString();
  const bits = [];
  if (detail.new_active_bin != null) bits.push(`bin ${detail.new_active_bin}`);
  if (detail.amount_sol != null) bits.push(`${detail.amount_sol} SOL`);
  if (detail.new_position) bits.push(`new ${String(detail.new_position).slice(0, 8)}`);
  pos.notes.push(`Re-centered (#${pos.rebalance_count}) at ${at}${bits.length ? ` — ${bits.join(", ")}` : ""}`);
  pushEvent(state, { action: "rebalance", position: position_address, pool_name: pos.pool_name || pos.pool, count: pos.rebalance_count });
  save(state);
  log("state", `Position ${position_address} re-centered — rebalance_count=${pos.rebalance_count}`);
  return pos.rebalance_count;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Vega FIX#1 — pure OOR direction classifier.
 * Single-side SOL deploys (bins_above=0) go OOR-UP on any up-move (token pumped,
 * position holding appreciating token) and OOR-DOWN on a dump (depreciation, fees
 * dead). The legacy OOR path closed both identically. This fn reads the bin fields
 * getMyPositions already exposes (active_bin/upper_bin/lower_bin) and returns:
 *   "UP"   — active_bin > upper_bin (pumped above range)
 *   "DOWN" — active_bin < lower_bin (dumped below range)
 *   "IN"   — active_bin within [lower_bin, upper_bin] (still in range)
 *   "UNKNOWN" — any bin field missing/non-finite (FAIL-SAFE: caller uses normal timer)
 * Pure: no I/O, no state read. Exported for unit tests.
 */
export function oorDirection(positionData) {
  const active = Number(positionData?.active_bin);
  const upper = Number(positionData?.upper_bin);
  const lower = Number(positionData?.lower_bin);
  if (!Number.isFinite(active) || !Number.isFinite(upper) || !Number.isFinite(lower)) {
    return "UNKNOWN";
  }
  if (active > upper) return "UP";
  if (active < lower) return "DOWN";
  return "IN";
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h, active_bin/upper_bin/lower_bin
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const {
    pnl_pct: reportedPnlPct,
    pnl_pct_fee_inclusive,
    pnl_pct_suspicious,
    in_range,
    fee_per_tvl_24h,
    price_change_1h_pct,
    net_buyers_1h,
    age_minutes,
  } = positionData;
  // Vega fix #1 — exit DECISION metric is the fee-inclusive net economic
  // position (current value + fees − deposit, REAL IL embedded in current
  // value), mirroring the paper side. Root-cause fix for the 1:2 loss/win
  // asymmetry: SL/TP/trailing/partial/velocity all now read where the position
  // TRULY sits net of accrued fees instead of raw price.
  // FAIL-SAFE (anti-pattern #2): when pnl_pct_fee_inclusive is missing/null we
  // fall back to the SDK-reported pnl_pct — never assume fees are large, and the
  // stop loss still fires. Downside stays capped: SL measures the true net
  // position, which is <= price-only only when IL exceeds fees (the loss is
  // real). Reversibility: feeInclusiveExitEnabled=false → revert to reported.
  const feeInclusiveOn =
    config.internalAgents?.feeInclusiveExitEnabled !== false &&
    pnl_pct_fee_inclusive != null &&
    Number.isFinite(Number(pnl_pct_fee_inclusive));
  const currentPnlPct = feeInclusiveOn ? Number(pnl_pct_fee_inclusive) : reportedPnlPct;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  // ── Max-hold-time forced exit (Vega EXIT-3 #3, HIGHEST PRECEDENCE) ──────
  // Live mirror of paper-trades.js evaluatePaperExit's MAX_HOLD gate, now with
  // an IN-RANGE GUARD so a winner that is still parking the active bin (the
  // ZINC-type 11h+ tail) is NOT clipped at the old 12h hard cap.
  //   - age >= maxHoldOorMinutes (720m) AND OUT OF RANGE → close (max_hold_oor):
  //     a stale OOR position earns no fees; do not babysit it past 12h.
  //   - age >= maxHoldMinutes (1440m) → close (max_hold_hard) REGARDLESS of
  //     range: the entry thesis is structurally dead past 24h.
  //   - age in [720, 1440) AND IN RANGE → allowed to keep running (winner tail).
  // Runs BEFORE the confirmed-trailing pickup + every PnL rule so a stuck
  // position cannot dodge the time gate via PnL fluctuation.
  // BLUECHIP-AWARE: a longer/exempt window is a one-line override here once the
  // bluechip path is live (pos.is_bluechip → use maxHoldMinutesBluechip). For
  // now every deploy is a memecoin so the memecoin window applies.
  // FAIL-SAFE (anti-pattern #2): age unknown (no age_minutes AND no parseable
  // deployed_at) → skip the gate entirely (never force-close on a guessed age).
  // Reversibility: maxHoldMinutes=0 → silent revert (no time gate, legacy).
  {
    const hardLimit = Number(mgmtConfig.maxHoldMinutes);
    if (Number.isFinite(hardLimit) && hardLimit > 0) {
      let ageMin = Number(age_minutes);
      if (!Number.isFinite(ageMin) && pos.deployed_at) {
        const ms = Date.now() - new Date(pos.deployed_at).getTime();
        ageMin = Number.isFinite(ms) ? Math.floor(ms / 60000) : NaN;
      }
      if (Number.isFinite(ageMin)) {
        // OOR window: default to hardLimit/2 (=720m at the 1440m default) but
        // honor an explicit maxHoldOorMinutes; clamp so it can never exceed the
        // hard limit (an OOR position must never get a LONGER leash).
        const oorLimit = Math.min(
          Number.isFinite(Number(mgmtConfig.maxHoldOorMinutes))
            ? Number(mgmtConfig.maxHoldOorMinutes)
            : hardLimit / 2,
          hardLimit,
        );
        if (ageMin >= hardLimit) {
          return {
            action: "MAX_HOLD_EXPIRED",
            reason: `held ${ageMin}m exceeds maxHold ${hardLimit}m — forced close (max_hold_hard)`,
          };
        }
        // OOR past the OOR window but under the hard limit → cut now. We read the
        // live range flag directly (in_range === false) so a position OOR right
        // now is cut even before the OOR timer below would have fired.
        const isOor = in_range === false || !!pos.out_of_range_since;
        if (ageMin >= oorLimit && isOor) {
          return {
            action: "MAX_HOLD_EXPIRED",
            reason: `held ${ageMin}m >= ${oorLimit}m AND out-of-range — forced close (max_hold_oor)`,
          };
        }
        // age in [oorLimit, hardLimit) AND in-range → fall through (winner tail
        // allowed to keep running; trailing/SL still govern its exit).
      }
    }
  }

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // ── Break-even stop ARM (Vega EXIT-3 #1) ───────────────────────────────
  // Once a position has peaked >= breakEvenArmPct (fee-inclusive), lock the
  // modal: be_armed flips true (idempotent, persisted, NEVER disarms). The
  // effective stop then ratchets UP from the fixed SL to break-even
  // (breakEvenStopPct, default 0% = exit at flat, +1% optional to lock a sliver
  // of gain). This is the "winner gives it all back to -8%" fix: a +6% pump that
  // round-trips now exits at break-even, not at the -8% floor. Pure ADD — does
  // NOT touch trailing/partial/velocity. Default OFF (breakEvenStopEnabled).
  // FAIL-SAFE: peak unknown/non-finite → never arms. We use peak_pnl_pct (the
  // confirmed high-water mark) so a single noisy tick can't arm it spuriously.
  if (
    mgmtConfig.breakEvenStopEnabled === true &&
    !pos.be_armed &&
    Number.isFinite(Number(pos.peak_pnl_pct)) &&
    Number(pos.peak_pnl_pct) >= Number(mgmtConfig.breakEvenArmPct ?? 5)
  ) {
    pos.be_armed = true;
    pos.be_armed_at = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} break-even stop ARMED (peak ${Number(pos.peak_pnl_pct).toFixed(2)}% >= ${mgmtConfig.breakEvenArmPct ?? 5}%) — floor ratcheted to ${mgmtConfig.breakEvenStopPct ?? 0}%`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Give-back protection (Andromeda Track-B PROFIT) ─────────────────────
  // Confirmed short-gamma reality: peaks cluster ~+4.7–5.4% then round-trip
  // (reptilecoin peaked +5.43%, gave it ALL back to the −0.96% break-even stop).
  // The +18% trailing trigger NEVER arms on this instrument, so a modest pump
  // that fades is otherwise caught only at break-even (0%) or worse. Give-back is
  // a LOW-trigger trailing harvest that OWNS the sub-trailing zone: once the
  // CONFIRMED peak >= giveBackPeakPct (4%) — but BELOW where trailing takes over
  // (trailingTriggerPct) — a decay of >= giveBackDropPct (2%) from that peak
  // closes the position, locking ~+3% instead of round-tripping.
  //
  // COMPLEMENTS trailing TP (does NOT touch trailingTriggerPct/trailingDropPct):
  // give-back owns [giveBackPeakPct, trailingTriggerPct); trailing owns the rest.
  // If trailing is disabled the ceiling is ∞ (give-back owns all peaks >= arm).
  //
  // SL UNTOUCHED / never shields a loss: HARD-guarded to currentPnlPct > 0, so it
  // is mutually exclusive with STOP_LOSS (fires only on negative PnL) — give-back
  // can only ever HARVEST a profitable position. Runs BEFORE break-even so it
  // captures the gain higher up (at peak − drop) instead of riding to the 0%
  // break-even floor; break-even + SL remain the backstop when give-back is off or
  // the drop overshoots the zone between cycles. Uses pos.peak_pnl_pct (the
  // confirmed high-water mark, de-noised by the 15s peak recheck) like trailing TP.
  //
  // FAIL-SAFE (anti-pattern #2): peak/PnL missing/non-finite/suspicious → skip
  // (legacy trailing/break-even/SL own it). Default OFF (giveBackProtectEnabled).
  if (
    mgmtConfig.giveBackProtectEnabled === true &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    Number.isFinite(Number(currentPnlPct)) &&
    Number(currentPnlPct) > 0 &&
    Number.isFinite(Number(pos.peak_pnl_pct))
  ) {
    const peak = Number(pos.peak_pnl_pct);
    const armPct = Number(mgmtConfig.giveBackPeakPct ?? 4);
    const dropPct = Number(mgmtConfig.giveBackDropPct ?? 2);
    const ceil =
      mgmtConfig.trailingTakeProfit && Number.isFinite(Number(mgmtConfig.trailingTriggerPct))
        ? Number(mgmtConfig.trailingTriggerPct)
        : Infinity;
    const gaveBack = peak - Number(currentPnlPct);
    if (
      Number.isFinite(armPct) &&
      Number.isFinite(dropPct) &&
      dropPct > 0 &&
      peak >= armPct &&
      peak < ceil &&
      gaveBack >= dropPct
    ) {
      return {
        action: "GIVE_BACK_PROTECT",
        reason: `give_back_protect: peak ${peak.toFixed(2)}% → current ${Number(currentPnlPct).toFixed(2)}% (gave back ${gaveBack.toFixed(2)}% >= ${dropPct}%, below trailing arm ${ceil === Infinity ? "∞" : ceil + "%"}) — harvesting before round-trip`,
        peak_pnl_pct: peak,
        current_pnl_pct: Number(currentPnlPct),
        drop_from_peak_pct: gaveBack,
      };
    }
  }

  // ── Break-even stop (Vega EXIT-3 #1) ───────────────────────────────────
  // Runs BEFORE the fixed SL so the HIGHER floor wins (anti-pattern guard: a
  // ratcheted break-even at 0% must pre-empt the -8% SL — else the position
  // would ride all the way back down to -8% and the lock would be meaningless).
  // Only fires when armed (peak crossed breakEvenArmPct earlier) AND the net
  // fee-inclusive PnL has fallen to/through the break-even floor. This NEVER
  // loosens downside protection: it only TIGHTENS the stop upward on a winner;
  // the fixed SL below still catches a position that was never armed.
  // FAIL-SAFE: pnl suspicious / null → skip (SL still owns the floor).
  if (
    mgmtConfig.breakEvenStopEnabled === true &&
    pos.be_armed &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    Number.isFinite(Number(currentPnlPct)) &&
    Number(currentPnlPct) <= Number(mgmtConfig.breakEvenStopPct ?? 0)
  ) {
    return {
      action: "BREAK_EVEN_STOP",
      reason: `Break-even stop: net PnL ${Number(currentPnlPct).toFixed(2)}% <= ${mgmtConfig.breakEvenStopPct ?? 0}% after arming at peak ${Number(pos.peak_pnl_pct ?? 0).toFixed(2)}% — modal locked, NOT round-tripping to ${mgmtConfig.stopLossPct}%`,
      peak_pnl_pct: pos.peak_pnl_pct ?? 0,
      current_pnl_pct: currentPnlPct,
    };
  }

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Partial TP scale-out (Vega Item 2B) ────────────────────────
  // Fires ONCE: peak >= partialTpTriggerPct AND not already done. Returns a
  // PARTIAL_TP action that the caller executes via partial_close_position
  // (pull partialTpPct%, keep account open). Idempotency is enforced by the
  // partial_tp_done flag (set via markPartialTpDone after a confirmed TX) AND
  // re-checked here. A stop loss (above) always pre-empts a partial — if we're
  // crashing we close fully, never scale out.
  if (
    !pnl_pct_suspicious &&
    mgmtConfig.partialTpEnabled !== false &&
    !pos.partial_tp_done &&
    currentPnlPct != null &&
    (pos.peak_pnl_pct ?? 0) >= (mgmtConfig.partialTpTriggerPct ?? Infinity)
  ) {
    const pct = Number(mgmtConfig.partialTpPct ?? 50);
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      return {
        action: "PARTIAL_TP",
        reason: `Partial TP: peak ${(pos.peak_pnl_pct ?? 0).toFixed(2)}% >= ${mgmtConfig.partialTpTriggerPct}% — scaling out ${pct}% (rest runs with trailing)`,
        partial_pct: pct,
        peak_pnl_pct: pos.peak_pnl_pct ?? 0,
        current_pnl_pct: currentPnlPct,
      };
    }
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Velocity-drop exit (Vega Item 6) ───────────────────────────
  // Momentum reversal capture BEFORE trailing drop fully hits. Requires the
  // position to be IN PROFIT (don't double-punish a losing position; stop loss
  // owns the downside) AND a hard 1h reversal: price_change_1h < -velocityDropPct
  // AND net_buyers_1h < 0 (sellers winning). Precedence: after partial TP,
  // before OOR. Reversibility: velocityExitEnabled=false → silent skip.
  if (
    !pnl_pct_suspicious &&
    mgmtConfig.velocityExitEnabled !== false &&
    currentPnlPct != null &&
    currentPnlPct > 0 &&
    price_change_1h_pct != null &&
    net_buyers_1h != null &&
    Number.isFinite(Number(price_change_1h_pct)) &&
    Number.isFinite(Number(net_buyers_1h)) &&
    Number(price_change_1h_pct) < -(mgmtConfig.velocityDropPct ?? 15) &&
    Number(net_buyers_1h) < 0
  ) {
    return {
      action: "VELOCITY_EXIT",
      reason: `Velocity exit: 1h price ${Number(price_change_1h_pct).toFixed(2)}% < -${mgmtConfig.velocityDropPct ?? 15}% AND net_buyers_1h ${net_buyers_1h} < 0 while in profit (${currentPnlPct.toFixed(2)}%) — momentum reversal`,
    };
  }

  // ── Fee-decay exit (Vega EXIT-3 #2, the BIGGEST gap) ───────────────────
  // Community trigger #1: "exit when fees start slowing down." We track the
  // fee-accrual rate (fee_per_tvl_24h) against a per-position BASELINE captured
  // early in the position's life, and exit when the current rate COLLAPSES below
  // feeDecayThreshold × baseline (default 0.30 = a 70% drop in fee velocity). At
  // that point the position is no longer earning its keep, so we take profit
  // while we still have it — this is a PROFIT-TAKING rule, NOT a cut-loss.
  //
  // HARD GUARD — fires ONLY when net IN-PROFIT (currentPnlPct > 0). A loser is
  // owned by SL / break-even / OOR; fee-decay must never close a position
  // underwater (that would realize the loss early — the opposite of intent).
  //
  // Baseline: prefer the lazily-captured fee_decay_baseline (first post-warmup
  // reading), else the deploy-time initial_fee_tvl_24h. Captured only once age
  // >= feeDecayWarmupMinutes so the first-tick spike doesn't poison the baseline.
  // Exit only after age >= feeDecayMinAgeMinutes so a momentary early dip can't
  // false-fire before the position has had time to actually accrue.
  //
  // Coordinated with VELOCITY_EXIT (above): velocity reads PRICE reversal, this
  // reads FEE-rate collapse. Different inputs, can't double-fire on the same tick
  // (velocity returns first if both hit; either way the position closes once).
  //
  // FAIL-SAFE (anti-pattern #2): missing/non-finite current rate OR no usable
  // baseline (null/<=0) → SKIP (never assume decay, never false-exit). Default
  // OFF (feeDecayExitEnabled). Reversibility: flag false → rule never runs.
  if (
    mgmtConfig.feeDecayExitEnabled === true &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    Number.isFinite(Number(currentPnlPct)) &&
    Number(currentPnlPct) > 0
  ) {
    const warmupMin = Number(mgmtConfig.feeDecayWarmupMinutes ?? 30);
    const minAgeMin = Number(mgmtConfig.feeDecayMinAgeMinutes ?? 60);
    const threshold = Number(mgmtConfig.feeDecayThreshold ?? 0.30);
    const curRate = Number(fee_per_tvl_24h);
    // Resolve age (same robust derivation as the max-hold gate).
    let feeAgeMin = Number(age_minutes);
    if (!Number.isFinite(feeAgeMin) && pos.deployed_at) {
      const ms = Date.now() - new Date(pos.deployed_at).getTime();
      feeAgeMin = Number.isFinite(ms) ? Math.floor(ms / 60000) : NaN;
    }

    // Resolve baseline: the deploy-time initial_fee_tvl_24h is the PRIMARY
    // baseline (a real early reading). Only when it is missing/<=0 do we fall
    // back to a lazily-captured first post-warmup rate. Capturing only when no
    // entry baseline exists prevents the capture from poisoning the same-tick
    // check (capturing curRate then comparing curRate against it would never fire).
    const entryBaseline =
      Number.isFinite(Number(pos.initial_fee_tvl_24h)) && Number(pos.initial_fee_tvl_24h) > 0
        ? Number(pos.initial_fee_tvl_24h)
        : null;

    if (
      entryBaseline == null &&
      pos.fee_decay_baseline == null &&
      Number.isFinite(curRate) &&
      curRate > 0 &&
      Number.isFinite(feeAgeMin) &&
      feeAgeMin >= warmupMin
    ) {
      pos.fee_decay_baseline = curRate;
      pos.fee_decay_baseline_at = new Date().toISOString();
      save(state);
      log("state", `Position ${position_address} fee-decay baseline captured: ${curRate}% fee/TVL at ${feeAgeMin}m`);
    }

    const baseline =
      entryBaseline != null
        ? entryBaseline
        : Number.isFinite(Number(pos.fee_decay_baseline)) && Number(pos.fee_decay_baseline) > 0
          ? Number(pos.fee_decay_baseline)
          : null;

    if (
      baseline != null &&
      Number.isFinite(curRate) &&
      Number.isFinite(threshold) &&
      threshold > 0 &&
      Number.isFinite(minAgeMin) &&
      Number.isFinite(feeAgeMin) &&
      feeAgeMin >= minAgeMin &&
      curRate < baseline * threshold
    ) {
      return {
        action: "FEE_DECAY_EXIT",
        reason: `Fee-decay exit: fee/TVL ${curRate}% < ${(threshold * 100).toFixed(0)}% of baseline ${baseline}% (= ${(baseline * threshold).toFixed(3)}%) while in profit (${Number(currentPnlPct).toFixed(2)}%) — fees slowed, taking profit`,
        baseline_fee_tvl: baseline,
        current_fee_tvl: curRate,
        current_pnl_pct: currentPnlPct,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);

    // ── Fast OOR-UP harvest (Andromeda Track-B PROFIT) ────────────────────
    // Confirmed short-gamma reality: a single-side-SOL position goes OOR-UP the
    // instant price ticks up through the deploy bin — it is then 100% idle SOL
    // (the quote leg), accruing ZERO fees. The generic outOfRangeWaitMinutes
    // (30m) just parks dead capital while it earns nothing. Harvest FAST (default
    // 3m ≈ one management cycle of whipsaw tolerance) to lock the ~+3% winners
    // realize here and FREE the capital for redeploy — velocity is the edge.
    //
    // Direction read via oorDirection() INDEPENDENT of oorDirectionalExitEnabled
    // (this rule has its own flag). When enabled it takes PRECEDENCE over the
    // directional "ride the pump" hold below — real 12-trade data refuted that
    // hold for this instrument (OOR-UP is idle SOL, not an appreciating token). It
    // CLOSES (never holds), so it can never shield a loss: STOP_LOSS + break-even
    // already ran ABOVE this block on the fee-inclusive net PnL, so we are strictly
    // above the stop floor here. Freeing idle capital even at a small PnL beats
    // babysitting it for 30m.
    //
    // FAIL-SAFE (anti-pattern #2): direction UNKNOWN (bin fields missing/
    // non-finite) or non-finite timer → SKIP → the legacy timer / directional
    // path owns it. Default OFF (oorUpFastExitEnabled).
    if (mgmtConfig.oorUpFastExitEnabled === true) {
      const fastMin = Number(mgmtConfig.oorUpFastExitMinutes ?? 3);
      const fastDir = oorDirection(positionData);
      if (fastDir === "UP" && Number.isFinite(fastMin) && fastMin >= 0 && minutesOOR >= fastMin) {
        return {
          action: "OOR_UP_FAST_HARVEST",
          reason: `oor_up_fast_harvest: OOR-UP ${minutesOOR}m >= ${fastMin}m — 100% idle SOL (zero fee accrual), harvesting to free capital`,
          minutes_out_of_range: minutesOOR,
          current_pnl_pct: currentPnlPct ?? null,
        };
      }
    }

    // Vega FIX#1 — OOR DIRECTIONAL handling. Only active when the flag is on AND
    // we can read the bin fields. FAIL-SAFE: direction UNKNOWN (missing bins) →
    // behaves EXACTLY like legacy (normal timer, no early arm). Downside stays
    // capped — SL already fired above this block on the fee-inclusive net pnl.
    const directionalOn = mgmtConfig.oorDirectionalExitEnabled === true;
    const direction = directionalOn ? oorDirection(positionData) : "UNKNOWN";

    if (directionalOn && direction === "UP") {
      // OOR-UP = token pumped through our single-side range; we now hold
      // appreciating token with fees stopped. If in-profit (fee-inclusive),
      // DO NOT hard-close on the OOR timer — ARM TRAILING so we ride the pump
      // and exit on the trailing-drop / SL instead of dumping a thin +sliver.
      const inProfit = currentPnlPct != null && Number.isFinite(currentPnlPct) && currentPnlPct > 0;
      if (inProfit) {
        let changedUp = false;
        if (!pos.trailing_active) {
          pos.trailing_active = true;
          changedUp = true;
          log("state", `Position ${position_address} OOR-UP in-profit (${currentPnlPct.toFixed(2)}%) — trailing armed, NOT hard-closing on OOR timer (Vega FIX#1)`);
        }
        // Track the peak on EVERY OOR-UP-in-profit tick (not just the arming
        // tick) so the trailing-drop block measures against the true high-water
        // mark of the pump. Without this, peak would freeze at the arm value and
        // a 6% drop from a higher pump would never be detected.
        if (currentPnlPct > (pos.peak_pnl_pct ?? 0)) {
          pos.peak_pnl_pct = currentPnlPct;
          changedUp = true;
        }
        if (changedUp) save(state);
        // No exit: the trailing-drop block (runs above next cycle) and SL govern
        // the exit. The pump is captured instead of clipped at +sliver.
        return null;
      }
      // ── Patient OOR-UP for bluechip near-peg single-side SOL (Vega Opsi 1) ──
      // ROOT-CAUSE FIX for masalah #2 (instant-close ~40s). A single-side SOL
      // deploy into a wSOL=tokenY (LST-SOL) pool MUST end at the SDK active bin
      // (maxBinId=activeBin) — a bin ABOVE active holds tokenX (the LST) only, so
      // funding headroom would require depositing the LST = two-sided (Opsi A,
      // out of scope). A bin-buffer above active is therefore NOT SDK-valid here;
      // the correct lever is OOR-HANDLING. On a near-peg pool with a small
      // bin_step the FIRST up-tick pushes active above upper → OOR-UP in seconds,
      // while net pnl is still ~flat (conversion-edge IL) so the in-profit ride
      // path above does not catch it and the position was being cut at the worst
      // spot. But OOR-UP on a single-side SOL slot-Y position is the THESIS
      // playing out (SOL converting into the appreciating LST), NOT a stop. So we
      // HOLD it patiently instead of instant-closing or rebalancing-up.
      //
      // SAFETY (money-path, non-negotiable): this branch is reached ONLY after
      // the STOP_LOSS and break-even blocks ABOVE have already passed — i.e. the
      // net fee-inclusive PnL is strictly ABOVE the SL floor. A genuine de-peg
      // dump shows as OOR-DOWN (handled by the fast-cut below) or as net <= SL
      // (stopped out above). Patient hold can therefore NEVER shield a real loss
      // and can NEVER hold forever (SL/max-hold still own the exit). It also
      // applies to UP only, so it cannot block the OOR-DOWN cut. Gated on
      // bluechipPatientOorEnabled (default OFF) AND pos.is_bluechip — a memecoin
      // position is byte-for-byte unchanged (the flag is a no-op for it).
      if (
        mgmtConfig.bluechipPatientOorEnabled === true &&
        pos.is_bluechip === true
      ) {
        if (!pos.bluechip_patient_oor_logged) {
          pos.bluechip_patient_oor_logged = true;
          save(state);
          log(
            "state",
            `Position ${position_address} bluechip OOR-UP (net ${currentPnlPct != null ? Number(currentPnlPct).toFixed(2) : "?"}%) — patient hold, NOT instant-closing (single-side SOL slot-Y converting to LST; SL still owns downside)`,
          );
        }
        // No exit: SOL is converting into the appreciating LST exactly as
        // intended. SL (above) caps a real loss; max-hold (above) caps duration.
        return null;
      }
      // OOR-UP but NOT in-profit → normal OOR timer (fall through below).
    }

    // OOR-DOWN = token dumped below range; pure depreciation, fees dead. Cut on
    // the FASTER outOfRangeWaitMinutesDown timer. UNKNOWN/IN/UP-not-profit use
    // the normal timer (legacy behavior). outOfRangeWaitMinutesDown is clamped to
    // never exceed the normal limit (a dump should never wait LONGER).
    const downLimit = Math.min(
      Number(mgmtConfig.outOfRangeWaitMinutesDown ?? mgmtConfig.outOfRangeWaitMinutes),
      Number(mgmtConfig.outOfRangeWaitMinutes),
    );
    const effectiveLimit =
      directionalOn && direction === "DOWN" && Number.isFinite(downLimit)
        ? downLimit
        : mgmtConfig.outOfRangeWaitMinutes;

    if (minutesOOR >= effectiveLimit) {
      // Vega FIX#1 — REBALANCE GUARD. Re-centering an OOR-UP pump would buy the
      // token at the top (the OPPOSITE of intent) — but OOR-UP+profit already
      // returned above via the trailing path, so a re-center here can only be an
      // OOR-DOWN (or UNKNOWN/IN) position. We additionally HARD-BLOCK rebalance
      // for direction UP (defensive: OOR-UP-not-profit must not re-center either).
      const rebalanceAllowed = !(directionalOn && direction === "UP");
      // Vega Item 9 — Rebalance-on-OOR for high-organic tokens. DEFAULT OFF.
      // When enabled AND organic >= threshold AND under the maxRebalances churn
      // cap, signal REBALANCE_OOR (re-center on the current active bin, keep
      // earning fees) instead of a hard close. Live execution lives in
      // agents/rebalance.js, dispatched from index.js#runManagementCycle.
      //
      // Gates (ALL must hold, else fall through to legacy hard close):
      //   - flag rebalanceOnOorEnabled === true (Vega gates live activation)
      //   - organic >= rebalanceOnOorMinOrganic (high-organic only — these are
      //     the tokens worth keeping fee exposure on)
      //   - rebalance_count < maxRebalances (anti-churn cap; once hit, the
      //     position has re-centered too many times → hard close instead)
      //
      // The friction guard (fees earned vs re-center cost) is enforced at
      // execution time in agents/rebalance.js, where live fee figures exist.
      // We do NOT duplicate it here — this function is pure and has no wallet.
      const organic = Number(pos.organic_score);
      const rebalanceCount = Number(pos.rebalance_count ?? 0);
      const maxRebalances = Number(mgmtConfig.maxRebalances ?? 3);
      if (
        rebalanceAllowed &&
        mgmtConfig.rebalanceOnOorEnabled === true &&
        Number.isFinite(organic) &&
        organic >= (mgmtConfig.rebalanceOnOorMinOrganic ?? 80) &&
        Number.isFinite(rebalanceCount) &&
        Number.isFinite(maxRebalances) &&
        rebalanceCount < maxRebalances
      ) {
        return {
          action: "REBALANCE_OOR",
          reason: `OOR ${minutesOOR}m (limit ${effectiveLimit}m) but organic ${organic} >= ${mgmtConfig.rebalanceOnOorMinOrganic ?? 80} and rebalance_count ${rebalanceCount} < ${maxRebalances} — re-center candidate`,
          organic_score: organic,
          rebalance_count: rebalanceCount,
          max_rebalances: maxRebalances,
          minutes_out_of_range: minutesOOR,
        };
      }
      return {
        action: "OUT_OF_RANGE",
        reason: directionalOn && direction === "DOWN"
          ? `Out of range DOWN for ${minutesOOR}m (down-limit: ${effectiveLimit}m) — token dumped, cutting fast (Vega FIX#1)`
          : `Out of range for ${minutesOOR}m (limit: ${effectiveLimit}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
