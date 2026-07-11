/**
 * deploy-gas-ledger.js — Vega 2026-07-11, deploy-gas visibility (FIX #2, option b).
 *
 * PROBLEM: the per-trade realized-SOL formula (realized-sol.js) captures IL +
 * exit slippage + CLOSE-leg gas, but NOT the DEPLOY-leg gas paid when the
 * position was opened (~0.003 SOL / tx; ~0.042 SOL/day at 14 deploys — roughly
 * HALF the daily tuition, and currently INVISIBLE in every report).
 *
 * WHY NOT fold deploy gas into each close's realized figure (option a): that
 * would require threading a per-position deploy-gas value from deploy all the way
 * through to close (money-path state surgery in state.js + double-count risk if
 * the modal/gas accounting ever shifts). The SMALLEST CORRECT option is instead
 * to expose a DAILY DEPLOY-GAS AGGREGATE that the audit (Lyra) reads ALONGSIDE
 * realized SOL — no per-trade formula change, no double-count, purely additive
 * reporting.
 *
 * HONESTY: this is an ESTIMATE (DEFAULT_DEPLOY_GAS_SOL × tx-count), not a measured
 * on-chain fee. We never claim precision we don't have. Anti-pattern #2: garbage
 * inputs are dropped, never coerced to a fake number.
 *
 * SCOPE: pure accounting/reporting. It does NOT touch deploy/close/TX/DRY_RUN or
 * any risk constant. It only records + sums an estimate for the audit to read.
 *
 * PERSISTENCE CAVEAT: like its sibling deploy-outflow-ledger.js, the store is a
 * module-local, in-memory array — a process restart clears it. That is fine for a
 * rolling daily aggregate consulted by the running audit; the authoritative
 * long-horizon record remains the per-deploy action log. No I/O, no clock baked
 * in (callers pass `now`).
 */

// Conservative per-transaction deploy-gas estimate. A DLMM open is typically 1 tx
// (single position) but a wide bin range can span multiple; callers multiply by
// the observed tx-count. Solana base fee is ~0.000005 SOL/sig, but priority fees +
// bin-array init + ATA rent churn push a realistic open leg toward ~0.003 SOL/tx.
export const DEFAULT_DEPLOY_GAS_SOL = 0.003;

// Rolling window for the "daily" aggregate.
const DEFAULT_DEPLOY_GAS_WINDOW_MS = 24 * 60 * 60 * 1000;

let _deployGas = []; // [{ sol: number, at: ms }]

/**
 * Record an estimated deploy-leg gas cost for a successful LIVE deploy.
 * @param {number} sol  estimated SOL spent on deploy-leg gas (>0)
 * @param {number} [at] timestamp ms (defaults to Date.now())
 */
export function recordDeployGas(sol, at = Date.now()) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return; // never record garbage (anti-pattern #2)
  _deployGas.push({ sol: n, at });
}

/**
 * Sum estimated deploy-leg gas within `windowMs` ending at `now`. Prunes entries
 * older than the window so the aggregate stays a rolling total.
 * @param {number} [now]      current time ms
 * @param {number} [windowMs] window (default 24h)
 * @returns {number} SOL of estimated deploy gas in-window (>= 0)
 */
export function getDeployGasTotalSol(now = Date.now(), windowMs = DEFAULT_DEPLOY_GAS_WINDOW_MS) {
  _deployGas = _deployGas.filter((g) => (now - g.at) <= windowMs);
  return round8(_deployGas.reduce((s, g) => s + g.sol, 0));
}

/** Rolling last-24h deploy-gas estimate the audit can read. */
export function getDeployGasDailySol(now = Date.now()) {
  return getDeployGasTotalSol(now, DEFAULT_DEPLOY_GAS_WINDOW_MS);
}

/** Count of recorded deploys in-window (for a per-deploy average, observability). */
export function getDeployGasCount(now = Date.now(), windowMs = DEFAULT_DEPLOY_GAS_WINDOW_MS) {
  return _deployGas.filter((g) => (now - g.at) <= windowMs).length;
}

export function __resetDeployGasLedgerForTest() { _deployGas = []; }
export function __getDeployGasLedgerForTest() { return _deployGas.slice(); }

function round8(n) {
  return Number.isFinite(n) ? Number(n.toFixed(8)) : 0;
}
