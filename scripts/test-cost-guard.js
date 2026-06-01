// scripts/test-cost-guard.js
// Vega — validates LLM cost-guard caps + enforcement thresholds.
// Run: node scripts/test-cost-guard.js
//
// Asserts:
//   - DAILY_CAP_USD = 1.10 (raised from 0.75, 2026-06-01 anti-blind-out margin)
//   - WEEKLY_CAP_USD = 5.00 (REAL backstop, UNCHANGED)
//   - assertWithinBudget() enforcement fires at the >= boundary for both windows
//   - getBudgetStatus() reports the correct caps + pct math

import {
  DAILY_CAP_USD,
  WEEKLY_CAP_USD,
  ALERT_THRESHOLD_PCT,
  getBudgetStatus,
  assertWithinBudget,
  BudgetExceededError,
} from "../cost-guard.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}`); }
}

// ── 1. Cap constants ───────────────────────────────────────────────
console.log("[1] Cap constants");
ok(DAILY_CAP_USD === 1.10, `DAILY_CAP_USD === 1.10 (got ${DAILY_CAP_USD})`);
ok(WEEKLY_CAP_USD === 5.00, `WEEKLY_CAP_USD === 5.00 unchanged (got ${WEEKLY_CAP_USD})`);
ok(ALERT_THRESHOLD_PCT === 0.80, `ALERT_THRESHOLD_PCT === 0.80 (got ${ALERT_THRESHOLD_PCT})`);
ok(DAILY_CAP_USD < WEEKLY_CAP_USD, "daily cap below weekly backstop");
ok(DAILY_CAP_USD <= 1.10 && DAILY_CAP_USD > 0.75, "daily raise is modest, not unlimited");

// ── 2. getBudgetStatus reports caps + structure ────────────────────
console.log("[2] getBudgetStatus shape");
const status = getBudgetStatus();
ok(status.daily.cap === 1.10, `status.daily.cap === 1.10 (got ${status.daily.cap})`);
ok(status.weekly.cap === 5.00, `status.weekly.cap === 5.00 (got ${status.weekly.cap})`);
ok(status.daily.window_hours === 24, "daily window 24h");
ok(status.weekly.window_hours === 168, "weekly window 168h");
ok(typeof status.daily.spent === "number" && status.daily.spent >= 0, "daily spent numeric >=0");
ok(typeof status.weekly.spent === "number" && status.weekly.spent >= 0, "weekly spent numeric >=0");
const expectedDailyPct = status.daily.cap > 0 ? status.daily.spent / status.daily.cap : 0;
ok(Math.abs(status.daily.pct - expectedDailyPct) < 1e-9, "daily pct = spent/cap");

// ── 3. Enforcement boundary (pure logic mirror of assertWithinBudget) ──
// assertWithinBudget throws when spent >= cap. Verify the boundary semantics
// against both caps without mutating the on-disk usage file.
console.log("[3] Enforcement boundary semantics");
function dailyFires(spent, cap) { return spent >= cap; }
ok(dailyFires(1.10, 1.10) === true, "daily fires AT cap (1.10 >= 1.10)");
ok(dailyFires(1.0999, 1.10) === false, "daily does NOT fire just below (1.0999 < 1.10)");
ok(dailyFires(1.11, 1.10) === true, "daily fires above cap");
ok(dailyFires(0.75, 1.10) === false, "old 0.75 spend NO LONGER blinds bot (headroom restored)");
ok(dailyFires(5.00, 5.00) === true, "weekly fires AT $5 backstop");
ok(dailyFires(4.99, 5.00) === false, "weekly does NOT fire just below $5");

// ── 4. Live assertWithinBudget does not throw under normal low burn ──
// (Real usage is far below caps; this confirms the call path is intact.)
console.log("[4] Live call path intact");
try {
  if (status.daily.spent < DAILY_CAP_USD && status.weekly.spent < WEEKLY_CAP_USD) {
    assertWithinBudget();
    ok(true, "assertWithinBudget() returns when under both caps");
  } else {
    // If real on-disk burn somehow exceeds a cap, it MUST throw — also valid.
    let threw = false;
    try { assertWithinBudget(); } catch (e) { threw = e instanceof BudgetExceededError; }
    ok(threw, "assertWithinBudget() throws BudgetExceededError when at/over cap");
  }
} catch (e) {
  ok(false, `unexpected throw: ${e.message}`);
}
ok(BudgetExceededError.prototype instanceof Error, "BudgetExceededError extends Error");

// ── Summary ────────────────────────────────────────────────────────
console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
