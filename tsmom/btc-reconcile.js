// tsmom/btc-reconcile.js — chain-truth vs book reconciliation for v3-btc-long.
//
// VEGA 🔥 — the pre-trade integrity gate. Before any order, our BOOK position
// (btc-position.js) must match CHAIN TRUTH within a tight tolerance. A drift means
// one of: an un-booked fill, a manual transfer, a partial/failed swap we mis-recorded,
// or a wrong wallet. In ALL of those we do NOT know our true exposure — and an
// unknown exposure is a NO-TRADE (anti-pattern #2/#3: fail-closed, never trade on
// a guessed balance). Drift => alert + halt; the operator reconciles manually.
//
// TOLERANCE: cbBTC is 8-decimal; tiny dust/rounding from swap fills is expected.
// We compare against a RELATIVE tolerance (fraction of held units) with an absolute
// floor so a near-flat book isn't tripped by sub-dust noise. USDC similar.
//
// NO MONEY MOVES HERE. Read-only + decision. The halt is advisory to the executor.

import { log } from "../logger.js";
import { loadPosition, readChainPosition } from "./btc-position.js";

// Default tolerances. cbBTC ~ $60k/unit so 0.5% of a $300 probe ≈ tiny; we allow a
// modest relative drift plus an absolute dust floor (swap fees/rounding).
export const CBBTC_REL_TOL = 0.01;     // 1% of held cbBTC units
export const CBBTC_ABS_FLOOR = 1e-6;   // ~$0.06 dust at $60k
export const USDC_REL_TOL = 0.01;      // 1% of held USDC
export const USDC_ABS_FLOOR = 0.5;     // $0.50 dust floor

/**
 * Pure drift check between book and chain for one leg. Returns {ok, drift, tol}.
 * Fail-closed: either side non-finite => ok:false (we can't prove a match).
 */
export function legReconcile(bookUnits, chainUnits, relTol, absFloor) {
  const b = Number(bookUnits);
  const c = Number(chainUnits);
  if (!Number.isFinite(b) || !Number.isFinite(c)) {
    return { ok: false, drift: null, tol: null, reason: "non_finite_leg_fail_closed" };
  }
  const drift = Math.abs(b - c);
  const tol = Math.max(absFloor, Math.abs(b) * relTol, Math.abs(c) * relTol);
  return { ok: drift <= tol, drift: +drift.toFixed(10), tol: +tol.toFixed(10), reason: drift <= tol ? null : "drift_exceeds_tol" };
}

/**
 * Reconcile book state vs chain truth. Reads chain (injectable), compares both legs.
 * Returns {ok, halt, legs, reason}. ok=false => halt=true (fail-closed). On a chain
 * READ failure we ALSO halt (unknown chain = can't trade). NEVER throws for a normal
 * mismatch — that's a returned halt; throwing is reserved for programmer error.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.book]          book state (defaults to loadPosition())
 * @param {function} [opts.getBalances]   injected chain balance reader (for tests)
 * @param {boolean}  [opts.alert=true]    send a Telegram halt-alert on drift
 */
export async function reconcile({ book = undefined, getBalances = undefined, alert = true } = {}) {
  const bookState = book !== undefined ? book : loadPosition();
  // No book yet (cold) is fine ONLY if chain is also flat; we still read chain.
  const chain = await readChainPosition(getBalances);
  if (!chain.ok) {
    const reason = `chain_read_failed:${chain.reason || "unknown"}`;
    log("btc_reconcile", `HALT — ${reason}`);
    if (alert) await alertHalt(`BTC TSMOM reconcile: chain read failed (${chain.reason}). HALT — cannot verify exposure.`);
    return { ok: false, halt: true, reason, legs: null };
  }

  const bookCb = bookState ? Number(bookState.cbbtc_units) || 0 : 0;
  const bookUsdc = bookState ? Number(bookState.usdc_units) || 0 : 0;

  const cbLeg = legReconcile(bookCb, chain.cbbtc_units, CBBTC_REL_TOL, CBBTC_ABS_FLOOR);
  const usdcLeg = legReconcile(bookUsdc, chain.usdc_units, USDC_REL_TOL, USDC_ABS_FLOOR);

  const legs = {
    cbbtc: { book: bookCb, chain: chain.cbbtc_units, ...cbLeg },
    usdc: { book: bookUsdc, chain: chain.usdc_units, ...usdcLeg },
  };

  if (!cbLeg.ok || !usdcLeg.ok) {
    const which = [!cbLeg.ok ? "cbBTC" : null, !usdcLeg.ok ? "USDC" : null].filter(Boolean).join("+");
    const reason = `drift_${which}`;
    log("btc_reconcile",
      `HALT — drift ${which}: cbBTC book=${bookCb} chain=${chain.cbbtc_units} (drift ${cbLeg.drift}/tol ${cbLeg.tol}); ` +
      `USDC book=${bookUsdc} chain=${chain.usdc_units} (drift ${usdcLeg.drift}/tol ${usdcLeg.tol})`);
    if (alert) {
      await alertHalt(
        `BTC TSMOM reconcile DRIFT (${which}). cbBTC book ${bookCb} vs chain ${chain.cbbtc_units}; ` +
        `USDC book ${bookUsdc} vs chain ${chain.usdc_units}. HALT — manual reconcile required.`
      );
    }
    return { ok: false, halt: true, reason, legs };
  }

  log("btc_reconcile", `OK — cbBTC ${chain.cbbtc_units}, USDC ${chain.usdc_units} match book within tol`);
  return { ok: true, halt: false, reason: null, legs };
}

async function alertHalt(message) {
  try {
    const tg = await import("../telegram.js");
    if (typeof tg.sendMessage === "function") await tg.sendMessage(`🔴 ${message}`);
  } catch (e) {
    log("btc_reconcile_alert_fail", `alert failed (non-fatal): ${e.message}`);
  }
}
