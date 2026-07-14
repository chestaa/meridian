// scripts/test-two-sided-paper.js
// Vega 🔥 — Two-sided PAPER-only path (flag-gated foundation for $1-2/trade LP).
//
// Pure unit test of tools/two-sided.js gate + accounting helpers, PLUS the
// flag-safety semantics that protect the LIVE money path:
//
//   SAFETY INVARIANTS PROVEN HERE:
//   1. Flag OFF (default) → amount_x>0 refused with the ORIGINAL single-side
//      message (byte-for-byte). Live single-side path unchanged.
//   2. twoSidedEnabled + DRY_RUN → paper two-sided ALLOWED.
//   3. twoSidedEnabled + LIVE (DRY_RUN != "true") → HARD-REFUSED by BOTH belts:
//        - paperOnly TRUE (default)   → paper-only-belt refusal
//        - paperOnly EXPLICIT false   → still refused (live path not authorized)
//   4. paperOnly belt is fail-safe TRUE unless EXPLICITLY false (cannot be
//      disabled by leaving the key unset/null/undefined).
//   5. Notional + swap-sim helpers are fail-CLOSED (bad input → null, never 0).
//
// No LLM, no RPC, no on-chain. Pure functions only.

import {
  strictNum,
  resolveTwoSidedMode,
  twoSidedGateDecision,
  computeTwoSidedNotionalSol,
  simulatePaperEntrySwap,
} from "../tools/two-sided.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}  ${detail}`);
    process.exitCode = 1;
  }
}

const ORIGINAL_SINGLE_SIDE_MSG =
  "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.";

function cfg(overrides = {}) {
  return { strategy: { ...overrides } };
}

// ── strictNum (fail-closed numeric) ─────────────────────────────────────────
check("strictNum(5) === 5", strictNum(5) === 5);
check("strictNum('2.5') === 2.5", strictNum("2.5") === 2.5);
check("strictNum(null) === null (NOT 0)", strictNum(null) === null, `got ${strictNum(null)}`);
check("strictNum('') === null (NOT 0)", strictNum("") === null, `got ${strictNum("")}`);
check("strictNum(false) === null (NOT 0)", strictNum(false) === null, `got ${strictNum(false)}`);
check("strictNum(NaN) === null", strictNum(NaN) === null);
check("strictNum(Infinity) === null", strictNum(Infinity) === null);
check("strictNum(undefined) === null", strictNum(undefined) === null);

// ── resolveTwoSidedMode ──────────────────────────────────────────────────────
{
  const m = resolveTwoSidedMode(cfg(), "true");
  check("default: enabled=false", m.enabled === false);
  check("default: paperOnly=true (fail-safe)", m.paperOnly === true);
  check("default: paperTwoSidedAllowed=false (flag off)", m.paperTwoSidedAllowed === false);
  check("default: liveTwoSidedAllowed=false", m.liveTwoSidedAllowed === false);
}
{
  const m = resolveTwoSidedMode(cfg({ twoSidedEnabled: true }), "true");
  check("enabled+dry: paperTwoSidedAllowed=true", m.paperTwoSidedAllowed === true);
  check("enabled+dry: liveTwoSidedAllowed=false", m.liveTwoSidedAllowed === false);
}
{
  // paperOnly fail-safe: only an EXPLICIT false lowers the belt.
  check(
    "paperOnly TRUE when key missing",
    resolveTwoSidedMode(cfg({ twoSidedEnabled: true }), "false").paperOnly === true,
  );
  check(
    "paperOnly TRUE when null",
    resolveTwoSidedMode(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: null }), "false").paperOnly === true,
  );
  check(
    "paperOnly FALSE only when explicit false",
    resolveTwoSidedMode(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false }), "false").paperOnly === false,
  );
}

// ── twoSidedGateDecision — THE SAFETY GATE ───────────────────────────────────

// Invariant 1: flag OFF → original message, byte-for-byte, in every env.
for (const dry of ["true", "false", undefined, "1", "TRUE"]) {
  const d = twoSidedGateDecision(cfg(), dry);
  check(`flag OFF (DRY_RUN=${dry}) → refused`, d.allowed === false);
  check(
    `flag OFF (DRY_RUN=${dry}) → ORIGINAL single-side message`,
    d.refuseReason === ORIGINAL_SINGLE_SIDE_MSG,
    `got: ${d.refuseReason}`,
  );
}

// Invariant 2: flag ON + DRY_RUN → ALLOWED (paper two-sided).
{
  const d = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "true");
  check("flag ON + DRY_RUN → ALLOWED", d.allowed === true);
  check("flag ON + DRY_RUN → no refuse reason", d.refuseReason === null);
}

// Invariant 3: flag ON + LIVE → HARD-REFUSED by both belts.
{
  // Belt 2: paperOnly TRUE (default) — refuse LIVE.
  const d = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "false");
  check("flag ON + LIVE + paperOnly TRUE → REFUSED", d.allowed === false);
  check(
    "flag ON + LIVE + paperOnly TRUE → paper-only-belt reason",
    /paper/i.test(d.refuseReason) && /REFUSED/i.test(d.refuseReason),
    `got: ${d.refuseReason}`,
  );
}
{
  // Belt 3: even paperOnly EXPLICIT false is STILL refused live (path not built).
  const d = twoSidedGateDecision(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false }), "false");
  check("flag ON + LIVE + paperOnly=false → STILL REFUSED (belt 3)", d.allowed === false);
  check(
    "flag ON + LIVE + paperOnly=false → not-implemented/authorized reason",
    /not implemented|not authorized|paper-simulation only/i.test(d.refuseReason),
    `got: ${d.refuseReason}`,
  );
}
// DRY_RUN must be EXACTLY "true" to enable paper — any other truthy string is live.
{
  const d = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "1");
  check('flag ON + DRY_RUN="1" (not "true") → treated LIVE → REFUSED', d.allowed === false);
}

// ── computeTwoSidedNotionalSol — exposure groundwork, fail-closed ────────────
{
  const n = computeTwoSidedNotionalSol({ amountYSol: 0.5, amountXTokens: 100, priceSolPerToken: 0.002 });
  check("notional: y_leg_sol = 0.5", n.y_leg_sol === 0.5);
  check("notional: x_leg_sol = 100*0.002 = 0.2", n.x_leg_sol === 0.2, `got ${n.x_leg_sol}`);
  check("notional: total = 0.7 (Y + X-in-SOL)", n.total_notional_sol === 0.7, `got ${n.total_notional_sol}`);
}
check(
  "notional fail-closed: null price → null (NOT 0 exposure)",
  computeTwoSidedNotionalSol({ amountYSol: 0.5, amountXTokens: 100, priceSolPerToken: null }) === null,
);
check(
  "notional fail-closed: negative token amount → null",
  computeTwoSidedNotionalSol({ amountYSol: 0.5, amountXTokens: -1, priceSolPerToken: 0.002 }) === null,
);
check(
  "notional fail-closed: empty-string price → null (Number('')===0 trap)",
  computeTwoSidedNotionalSol({ amountYSol: 0.5, amountXTokens: 100, priceSolPerToken: "" }) === null,
);

// ── simulatePaperEntrySwap — SIMULATION only, fail-closed ────────────────────
{
  const s = simulatePaperEntrySwap({ amountXTokens: 100, priceSolPerToken: 0.002, slippageBps: 100 });
  check("swap sim: simulated=true", s.simulated === true);
  check("swap sim: token_x_out = 100", s.token_x_out === 100);
  check("swap sim: sol_in_notional = 0.2", s.sol_in_notional === 0.2, `got ${s.sol_in_notional}`);
  check("swap sim: est cost = 0.2*0.01 = 0.002", s.est_swap_cost_sol === 0.002, `got ${s.est_swap_cost_sol}`);
  check("swap sim: total est = 0.202", s.sol_in_total_est === 0.202, `got ${s.sol_in_total_est}`);
  check("swap sim: note flags PAPER", /PAPER/.test(s.note));
}
check(
  "swap sim fail-closed: null price → null",
  simulatePaperEntrySwap({ amountXTokens: 100, priceSolPerToken: null, slippageBps: 100 }) === null,
);
{
  // Missing/negative slippage → treated as 0 (no fabricated cost), sim still valid.
  const s = simulatePaperEntrySwap({ amountXTokens: 100, priceSolPerToken: 0.002 });
  check("swap sim: missing slippage → 0 cost", s.est_swap_cost_sol === 0);
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log("\n──────────────────────");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed === 0) console.log("TWO-SIDED PAPER TEST OK");
else console.error("TWO-SIDED PAPER TEST FAILED");
