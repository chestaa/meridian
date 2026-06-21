/**
 * deploy-outflow-ledger.js — Vega honesty-audit 2026-06-21, FIX #2.
 *
 * PROBLEM: the burner balance-drain monitor (index.js) samples wallet SOL each
 * management cycle and alerts on a large drop. A successful deploy_position moves
 * the modal (e.g. 0.45 SOL) OUT of the wallet and INTO the LP position. The next
 * drain sample then sees balance fall 0.78 → 0.27 (≈65%) and FALSELY fires a
 * "DRAIN" alert every single deploy — eroding trust in the alert and masking a
 * real drain if one ever coincides.
 *
 * FIX: make the drain monitor DEPLOY-AWARE. Whenever deploy_position succeeds we
 * record the modal as a KNOWN, EXPECTED outflow here. The drain monitor consults
 * `consumeKnownOutflowSol(windowMs)` and credits the expected outflow back into
 * the observed drop before deciding — so a balance drop fully explained by a known
 * deploy is NOT flagged.
 *
 * FAIL-SAFE (drain protection MUST stay live):
 *  - Only deploy outflows are suppressed. A drop with NO matching known outflow —
 *    a real drain — still computes the full drop and alerts.
 *  - Outflows EXPIRE after `windowMs` (default = the drain sample window), so a
 *    stale recorded deploy can never permanently suppress a later real drain.
 *  - We credit AT MOST the recorded outflow; any drop BEYOND the known deploy is
 *    still measured and can still trip the alert. A deploy can never mask a
 *    simultaneous larger real drain.
 *  - Each recorded outflow is consumed (matched) at most once, so two cycles after
 *    one deploy do not both get a free pass.
 *
 * Pure + side-effect-isolated: the store is a module-local array; tests reset it
 * via __resetOutflowLedgerForTest. No I/O, no clock baked in (callers pass now).
 */

const DEFAULT_OUTFLOW_TTL_MS = 60 * 60 * 1000; // mirror BALANCE_DRAIN_WINDOW_MS

let _outflows = []; // [{ sol: number, at: ms, consumed: boolean }]

/**
 * Record a known, expected SOL outflow (a successful deploy modal).
 * @param {number} sol  amount of SOL that left the wallet into the LP
 * @param {number} [at] timestamp ms (defaults to Date.now())
 */
export function recordDeployOutflow(sol, at = Date.now()) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n <= 0) return; // never record garbage
  _outflows.push({ sol: n, at, consumed: false });
}

/**
 * Total un-consumed known outflow within the window, ending at `now`. Marks the
 * matched outflows consumed (each is credited at most once) and prunes expired
 * ones. Returns the SOL sum the drain monitor may credit back into an observed
 * drop. Pure aside from mutating the module-local ledger.
 *
 * @param {number} now       current time ms
 * @param {number} [windowMs] outflow validity window
 * @returns {number} SOL of known outflow to credit (>= 0)
 */
export function consumeKnownOutflowSol(now = Date.now(), windowMs = DEFAULT_OUTFLOW_TTL_MS) {
  // Prune anything older than the window — a stale deploy must never suppress a
  // later real drain.
  _outflows = _outflows.filter((o) => (now - o.at) <= windowMs);

  let credit = 0;
  for (const o of _outflows) {
    if (!o.consumed && (now - o.at) <= windowMs) {
      credit += o.sol;
      o.consumed = true;
    }
  }
  return credit;
}

/** Peek without consuming (observability/tests). */
export function peekKnownOutflowSol(now = Date.now(), windowMs = DEFAULT_OUTFLOW_TTL_MS) {
  return _outflows
    .filter((o) => !o.consumed && (now - o.at) <= windowMs)
    .reduce((s, o) => s + o.sol, 0);
}

export function __resetOutflowLedgerForTest() { _outflows = []; }
export function __getOutflowLedgerForTest() { return _outflows.slice(); }
