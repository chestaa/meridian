// tsmom/btc-guards.js — CROWN-JEWEL money safety layer for v3-btc-long live execution.
//
// VEGA 🔥 — this is the FIRST module built (safety before execution). Every
// money-touching path in btc-order.js / btc-executor.js MUST pass through these
// guards. They are deliberately PARANOID and FAIL-CLOSED (anti-pattern #2/#3):
// missing/ambiguous data => refuse, never default to "safe-looking" and proceed.
//
// WHAT THIS ENFORCES (Bro-locked package, 2026-06-25):
//   * BTC_TSMOM_MAX_EQUITY_USD  — probe-equity hard cap ($200–300; exact at funding).
//   * BTC_TSMOM_MAX_LEVERAGE    — 1.0, leverage OFF. sig.weight (up to 2.0 from the
//                                 vol-scaler) is CLAMPED to 1.0 before any sizing.
//   * BTC_TSMOM_DAILY_LOSS_HALT — −8% / 24h => halt (circuit breaker).
//   * BTC_TSMOM_MAX_SLIPPAGE    — 0.5% slippage cap on every swap.
//   * DRY_RUN gate              — must be the literal string 'true' or 'false';
//                                 anything else (unset, 'TRUE', '1', '') => THROW.
//   * Burner-only               — live signing wallet must be the burner, never the
//                                 main wallet (delegated to wallet-loader's blacklist).
//   * Kill switch               — a file-flag OR env flag halts all execution.
//
// PURE where possible: the clamp / circuit / DRY_RUN decision fns take inputs and
// return decisions with NO I/O, so they are exhaustively unit-testable. The wallet
// assertion is the only one that touches the loader.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── HARD-LOCKED CONSTANTS (Bro-confirmed package — NEVER auto-modify) ──────────
// These mirror the Phase-1 hardcoded-parameters contract. A change here is a
// money-risk change and requires Bro's explicit override, not a code review.
export const BTC_TSMOM_MAX_EQUITY_USD = 300;   // probe cap; exact figure ($200–300) confirmed at funding.
export const BTC_TSMOM_MAX_LEVERAGE = 1.0;     // leverage OFF — clamp live weight to 1.0.
export const BTC_TSMOM_DAILY_LOSS_HALT = 0.08; // −8% / 24h => halt.
export const BTC_TSMOM_MAX_SLIPPAGE = 0.005;   // 0.5% slippage cap.

// cbBTC (Coinbase Wrapped BTC on Solana) — verified via Jupiter price v3:
// usdPrice present, 8 decimals, ~$21.5M liquidity (2026-06-25). USDC is the cash leg.
export const CBBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
export const CBBTC_DECIMALS = 8;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

// Kill-switch flag file (Draco can `touch` this on the VPS to halt execution
// without a code change). Env BTC_TSMOM_KILL=1 is the same halt, for CI/tests.
export const KILL_SWITCH_FILE = path.resolve(__dirname, "data", "BTC_TSMOM_HALT");

// ── strict numeric (anti-pattern #2): Number(null)===0 would FABRICATE a value ──
function strictNumeric(x) {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "boolean") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * DRY_RUN gate. The ONLY accepted values are the literal strings 'true' or 'false'.
 * Anything else — unset, 'TRUE', 'True', '1', 'yes', '' — THROWS. We never infer
 * "probably means false" (that's how a silent live deploy happens). Returns a
 * boolean: true = dry-run (no money), false = LIVE.
 *
 * @param {string|undefined} raw  process.env.DRY_RUN (pass explicitly for testability)
 * @returns {boolean} isDryRun
 */
export function assertDryRunGate(raw = process.env.DRY_RUN) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `DRY_RUN must be exactly 'true' or 'false' (got ${JSON.stringify(raw)}). ` +
    `Refusing to run money path with an ambiguous DRY_RUN. (btc-guards)`
  );
}

/**
 * Clamp a strategy weight to the leverage cap. The vol-scaler in tsmom-signal can
 * emit weight up to maxLeverage=2.0; live trading is leverage-OFF, so we hard-clamp
 * |weight| to BTC_TSMOM_MAX_LEVERAGE (1.0). Sign preserved (but v3-btc-long is
 * long/flat so sign is 0 or +1 anyway). FAIL-CLOSED: a non-finite weight clamps to
 * 0 (flat / no exposure) — we NEVER pass an unknown weight into sizing.
 *
 * @returns {{ weight:number, clamped:boolean, reason:string|null }}
 */
export function clampLeverage(rawWeight, cap = BTC_TSMOM_MAX_LEVERAGE) {
  const w = strictNumeric(rawWeight);
  if (w === null) {
    return { weight: 0, clamped: true, reason: "non_finite_weight_clamped_to_flat" };
  }
  const sign = w < 0 ? -1 : 1;
  const mag = Math.abs(w);
  if (mag > cap) {
    return { weight: +(sign * cap).toFixed(6), clamped: true, reason: "leverage_cap" };
  }
  return { weight: +w.toFixed(6), clamped: false, reason: null };
}

/**
 * Target USD notional from a (clamped) weight against the probe equity, hard-capped
 * by BTC_TSMOM_MAX_EQUITY_USD. FAIL-CLOSED: non-finite equity or weight => notional 0.
 * The cap is applied to the ABSOLUTE notional so a buggy large equity can never
 * exceed the probe ceiling.
 *
 * @returns {{ notionalUsd:number, capped:boolean, reason:string|null }}
 */
export function targetNotionalUsd(weight, equityUsd, cap = BTC_TSMOM_MAX_EQUITY_USD) {
  const w = strictNumeric(weight);
  const eq = strictNumeric(equityUsd);
  if (w === null || eq === null || eq < 0) {
    return { notionalUsd: 0, capped: true, reason: "non_finite_input_flat" };
  }
  let notional = w * eq;
  const sign = notional < 0 ? -1 : 1;
  let capped = false;
  let reason = null;
  if (Math.abs(notional) > cap) {
    notional = sign * cap;
    capped = true;
    reason = "equity_cap";
  }
  return { notionalUsd: +notional.toFixed(6), capped, reason };
}

/**
 * Slippage refusal. Given a quoted out amount vs the expected out (from price), the
 * realized slippage must be within BTC_TSMOM_MAX_SLIPPAGE. FAIL-CLOSED: missing /
 * non-finite / non-positive expected => REFUSE (we cannot prove slippage is in
 * bounds, so we refuse rather than assume). Returns {ok, slippage, reason}.
 *
 * slippage is signed: positive = we received LESS than expected (the bad direction).
 * Only adverse slippage beyond the cap refuses; receiving MORE than expected is fine.
 *
 * @param {number} expectedOut  out amount implied by oracle/quote price (pre-trade)
 * @param {number} quotedOut    out amount the route actually offers
 */
export function assertSlippage(expectedOut, quotedOut, cap = BTC_TSMOM_MAX_SLIPPAGE) {
  const exp = strictNumeric(expectedOut);
  const got = strictNumeric(quotedOut);
  if (exp === null || got === null || exp <= 0 || got < 0) {
    return { ok: false, slippage: null, reason: "slippage_unknown_fail_closed" };
  }
  // adverse slippage = how much LESS than expected we'd receive, as a fraction.
  const slippage = (exp - got) / exp;
  if (slippage > cap) {
    return {
      ok: false,
      slippage: +slippage.toFixed(6),
      reason: `slippage_${(slippage * 100).toFixed(3)}pct_exceeds_cap_${(cap * 100).toFixed(2)}pct`,
    };
  }
  return { ok: true, slippage: +slippage.toFixed(6), reason: null };
}

/**
 * Daily-loss circuit breaker. Given start-of-window equity and current equity over a
 * trailing 24h window, halt if the drawdown is at/below −BTC_TSMOM_DAILY_LOSS_HALT.
 * FAIL-CLOSED: missing/non-finite/non-positive baseline => HALT (we cannot prove
 * we're inside the loss budget, so we stop — a circuit breaker that fails open is
 * worse than useless). Returns {halt, drawdown, reason}.
 *
 * drawdown is signed: negative = a loss. We halt when drawdown <= -threshold.
 */
export function checkDailyLossCircuit(windowStartEquity, currentEquity, threshold = BTC_TSMOM_DAILY_LOSS_HALT) {
  const start = strictNumeric(windowStartEquity);
  const cur = strictNumeric(currentEquity);
  if (start === null || cur === null || start <= 0 || cur < 0) {
    return { halt: true, drawdown: null, reason: "equity_unknown_fail_closed_halt" };
  }
  const drawdown = cur / start - 1; // e.g. -0.08 = down 8%
  // Epsilon at the boundary: 230/250-1 = -0.07999999999999996 in IEEE-754, which is
  // a 8.0% loss that must TRIP. A tiny tolerance ensures the breaker fires AT the
  // threshold, not just strictly past it — a circuit breaker must not under-trip.
  if (drawdown <= -threshold + 1e-9) {
    return {
      halt: true,
      drawdown: +drawdown.toFixed(6),
      reason: `daily_loss_${(drawdown * 100).toFixed(2)}pct_breached_halt_${(threshold * 100).toFixed(1)}pct`,
    };
  }
  return { halt: false, drawdown: +drawdown.toFixed(6), reason: null };
}

/**
 * Kill switch. Halts ALL execution if either the env flag BTC_TSMOM_KILL is a
 * truthy '1'/'true', OR the kill-switch file exists on disk (Draco's no-deploy
 * halt lever). Pure-ish: file path is injectable for tests.
 *
 * @returns {{ halted:boolean, reason:string|null }}
 */
export function checkKillSwitch(envFlag = process.env.BTC_TSMOM_KILL, file = KILL_SWITCH_FILE) {
  const flag = String(envFlag || "").toLowerCase();
  if (flag === "1" || flag === "true") {
    return { halted: true, reason: "kill_switch_env_BTC_TSMOM_KILL" };
  }
  try {
    if (file && fs.existsSync(file)) {
      return { halted: true, reason: `kill_switch_file_${file}` };
    }
  } catch {
    // If we can't even stat the file, FAIL-CLOSED: treat as halted. A money path
    // that can't verify the kill switch must not run.
    return { halted: true, reason: "kill_switch_file_unreadable_fail_closed" };
  }
  return { halted: false, reason: null };
}

/**
 * Burner-only assertion for LIVE execution. Delegates to wallet-loader's
 * getSigningWallet(), which already (a) prefers BURNER_WALLET_KEY, (b) refuses
 * WALLET_PRIVATE_KEY when DRY_RUN=false, and (c) hard-refuses any pubkey present in
 * main-wallets-blacklist.json (anti-pattern #5). We import lazily so dry-run and
 * unit tests never instantiate a wallet. Returns the pubkey string on success,
 * THROWS on any violation. NEVER called on the dry-run path.
 *
 * @returns {Promise<string>} burner pubkey
 */
export async function assertBurnerWalletLive() {
  const { getSigningWallet, getWalletSource } = await import("../wallet-loader.js");
  const kp = getSigningWallet(); // throws on blacklist / phase-1 violation / bad key
  const source = getWalletSource() || "";
  if (!/BURNER_WALLET_KEY/.test(source)) {
    throw new Error(
      `Live BTC TSMOM requires BURNER_WALLET_KEY, got wallet source "${source}". ` +
      `Refusing (anti-pattern #5: burner-only). (btc-guards)`
    );
  }
  return kp.publicKey.toBase58();
}

/**
 * The single pre-trade gate every live order must clear. Returns {allow, reason,
 * detail}. NEVER throws for an expected refusal (those are returned as allow:false)
 * — it only throws on the DRY_RUN ambiguity (a config error, not a market state).
 * Pure w.r.t. the inputs you pass (equity/weight come from callers); side-effecting
 * only via checkKillSwitch's file stat.
 *
 * Order of checks is intentional: cheapest + most-fatal first (DRY_RUN gate, kill
 * switch, circuit breaker), then sizing.
 */
export function preTradeGate({
  dryRunRaw = process.env.DRY_RUN,
  windowStartEquity,
  currentEquity,
  rawWeight,
} = {}) {
  // 1) DRY_RUN must be unambiguous (throws on bad value — that's a config bug).
  const isDryRun = assertDryRunGate(dryRunRaw);

  // 2) Kill switch — halts both dry-run and live (so a halted system also stops
  //    emitting intended-orders that might be acted on downstream).
  const kill = checkKillSwitch();
  if (kill.halted) {
    return { allow: false, isDryRun, reason: kill.reason, stage: "kill_switch" };
  }

  // 3) Daily-loss circuit (fail-closed halt on unknown equity).
  const circuit = checkDailyLossCircuit(windowStartEquity, currentEquity);
  if (circuit.halt) {
    return { allow: false, isDryRun, reason: circuit.reason, stage: "circuit", drawdown: circuit.drawdown };
  }

  // 4) Leverage clamp (always applied; never a refusal, just a clamp).
  const lev = clampLeverage(rawWeight);

  // 5) Notional sizing (hard-capped by probe equity).
  const eqForSizing = strictNumeric(currentEquity);
  const notional = targetNotionalUsd(lev.weight, eqForSizing);

  return {
    allow: true,
    isDryRun,
    reason: null,
    stage: "ok",
    weight: lev.weight,
    weightClamped: lev.clamped,
    notionalUsd: notional.notionalUsd,
    notionalCapped: notional.capped,
    drawdown: circuit.drawdown,
  };
}
