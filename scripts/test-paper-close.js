// scripts/test-paper-close.js
// Andromeda — verify paper trades close on SL / TP / trailing TP / OOR conditions.
// No real LLM, no real RPC. Uses evaluatePaperExit() pure logic + snapshot fixtures.

import assert from "node:assert/strict";

const { evaluatePaperExit } = await import("../paper-trades.js");

const MGMT = {
  stopLossPct: -20,
  takeProfitPct: 5,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  outOfRangeWaitMinutes: 30,
};

function mkTrade(overrides = {}) {
  return {
    id: "paper_test_1",
    status: "open",
    opened_at: new Date().toISOString(),
    pool_name: "TEST-SOL",
    pool_address: "TESTpool1111111111111111111111111111111111",
    amount_sol: 0.05,
    entry_price: 1.0,
    peak_pnl_pct: null,
    out_of_range_since: null,
    notes: [],
    ...overrides,
  };
}

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

console.log("test-paper-close.js — paper trade exit logic");

// 1. Stop loss fires at -25%
{
  const trade = mkTrade();
  const snap = { price_proxy_pnl_pct: -25, price: 0.75 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("SL fires when pnl <= stopLossPct", () => {
    assert.ok(exit, "expected exit");
    assert.equal(exit.action, "STOP_LOSS");
  });
}

// 2. Stop loss does NOT fire at -15%
{
  const trade = mkTrade();
  const snap = { price_proxy_pnl_pct: -15, price: 0.85 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("SL does NOT fire above stopLossPct", () => {
    assert.equal(exit, null);
  });
}

// 3. Take profit fires at +6%
{
  const trade = mkTrade();
  const snap = { price_proxy_pnl_pct: 6, price: 1.06 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("TP fires when pnl >= takeProfitPct", () => {
    assert.ok(exit);
    assert.equal(exit.action, "TAKE_PROFIT");
  });
}

// 4. Trailing TP: arm at peak 3.5%, then fire when drops to 1.8% (drop 1.7% >= 1.5%)
{
  const trade = mkTrade();
  // First refresh — peak 3.5%, not yet triggered (peak >= 3 but no drop)
  let snap = { price_proxy_pnl_pct: 3.5, price: 1.035 };
  let exit = evaluatePaperExit(trade, snap, MGMT);
  check("trailing TP: no fire while at peak", () => {
    assert.equal(exit, null);
    assert.equal(trade.peak_pnl_pct, 3.5);
  });
  // Second refresh — drops to 1.8%
  snap = { price_proxy_pnl_pct: 1.8, price: 1.018 };
  exit = evaluatePaperExit(trade, snap, MGMT);
  check("trailing TP: fires when drop from peak >= trailingDropPct", () => {
    assert.ok(exit);
    assert.equal(exit.action, "TRAILING_TP");
    assert.match(exit.reason, /peak 3\.50%/);
  });
}

// 5. Trailing TP: does NOT fire if drop < 1.5%
{
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: 4, price: 1.04 }, MGMT); // arm peak=4
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 3.2, price: 1.032 }, MGMT);
  check("trailing TP: no fire when drop < trailingDropPct", () => {
    assert.equal(exit, null);
  });
}

// 6. OOR detection: large price deviation marks out_of_range_since
{
  const trade = mkTrade();
  const snap = { price_proxy_pnl_pct: -10, price: 0.6 }; // 40% below entry
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("OOR: out_of_range_since set on >25% deviation", () => {
    assert.ok(trade.out_of_range_since, "out_of_range_since should be set");
    // Should not yet fire (just-now timestamp)
    assert.equal(exit, null);
  });
}

// 7. OOR timeout: fires after >= outOfRangeWaitMinutes
{
  const longAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const trade = mkTrade({ out_of_range_since: longAgo });
  const snap = { price_proxy_pnl_pct: -10, price: 0.6 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("OOR: fires after timeout elapsed", () => {
    assert.ok(exit);
    assert.equal(exit.action, "OUT_OF_RANGE");
    assert.match(exit.reason, /Out of range for 3\dm/);
  });
}

// 8. OOR clears when price returns in band
{
  const trade = mkTrade({ out_of_range_since: new Date().toISOString() });
  const snap = { price_proxy_pnl_pct: 2, price: 1.02 }; // 2% — within band
  evaluatePaperExit(trade, snap, MGMT);
  check("OOR: out_of_range_since clears when back in band", () => {
    assert.equal(trade.out_of_range_since, null);
  });
}

// 9. Closed trades not re-evaluated
{
  const trade = mkTrade({ status: "closed" });
  const snap = { price_proxy_pnl_pct: -50, price: 0.5 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("closed trades skipped", () => {
    assert.equal(exit, null);
  });
}

// 10. SL takes precedence over OOR
{
  const longAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const trade = mkTrade({ out_of_range_since: longAgo });
  const snap = { price_proxy_pnl_pct: -25, price: 0.5 };
  const exit = evaluatePaperExit(trade, snap, MGMT);
  check("SL precedence over OOR", () => {
    assert.equal(exit.action, "STOP_LOSS");
  });
}

console.log(`\nALL ${assertions} assertions PASS`);
