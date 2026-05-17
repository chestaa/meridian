// scripts/test-drawdown-recovery.js
// Andromeda PR-A — verify max-drawdown-recovery exit.
//
// Per Bro Dikta external-operator insight: "track behavior from max drawdown
// — the clue is recovery." Trailing TP requires peak >= trailingTriggerPct
// (default +3%); positions that never made a peak but recovered from a deep
// underwater move otherwise get NOTHING. DRAWDOWN_RECOVERY fills that gap.

import assert from "node:assert/strict";

const { evaluatePaperExit } = await import("../paper-trades.js");
const { config } = await import("../config.js");

const MGMT = {
  stopLossPct: -50,           // intentionally loose so deep dip does not SL
  takeProfitPct: 50,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  outOfRangeWaitMinutes: 30,
  drawdownRecoveryArmPct: 10,
  drawdownRecoveryDeltaPct: 5,
};

function mkTrade(overrides = {}) {
  return {
    id: "paper_test_dd_recovery",
    status: "open",
    opened_at: new Date().toISOString(),
    pool_name: "TEST-SOL",
    pool_address: "TESTpool1111111111111111111111111111111111",
    amount_sol: 0.05,
    entry_price: 1.0,
    peak_pnl_pct: null,
    out_of_range_since: null,
    min_pnl_pct: 0,
    max_drawdown_pct: 0,
    drawdown_recovery_armed_at: null,
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

console.log("test-drawdown-recovery.js — Andromeda DRAWDOWN_RECOVERY exit");

// Ensure the flag is ON for the main scenario set (matches default config).
config.internalAgents.drawdownRecoveryEnabled = true;

// ─── Scenario 1 — full DD → recovery sequence (positive path) ───────
{
  const trade = mkTrade();

  // Refresh 1: pnl=0% — fields init untouched
  let exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 0, price: 1.0 }, MGMT);
  check("R1 pnl=0 no exit, fields stay at 0", () => {
    assert.equal(exit, null);
    assert.equal(trade.min_pnl_pct, 0);
    assert.equal(trade.max_drawdown_pct, 0);
    assert.equal(trade.drawdown_recovery_armed_at, null);
  });

  // Refresh 2: pnl=-5% — min tracks down, dd=5 (not yet armed)
  exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -5, price: 0.95 }, MGMT);
  check("R2 pnl=-5: min=-5 dd=5, not armed yet (< 10)", () => {
    assert.equal(exit, null);
    assert.equal(trade.min_pnl_pct, -5);
    assert.equal(trade.max_drawdown_pct, 5);
    assert.equal(trade.drawdown_recovery_armed_at, null);
  });

  // Refresh 3: pnl=-12% — armed (dd=12 >= 10)
  exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -12, price: 0.88 }, MGMT);
  check("R3 pnl=-12: dd=12 — armed, no fire (still declining)", () => {
    assert.equal(exit, null);
    assert.equal(trade.min_pnl_pct, -12);
    assert.equal(trade.max_drawdown_pct, 12);
    assert.ok(trade.drawdown_recovery_armed_at, "expected armed timestamp");
  });

  // Refresh 4: pnl=-15% — lower trough, still below armPct recovery window
  exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -15, price: 0.85 }, MGMT);
  check("R4 pnl=-15: min=-15 dd=15, still no fire", () => {
    assert.equal(exit, null);
    assert.equal(trade.min_pnl_pct, -15);
    assert.equal(trade.max_drawdown_pct, 15);
  });

  // Refresh 5: pnl=-5% — recovery delta = -5 - (-15) = 10 >= 5 → FIRE
  exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -5, price: 0.95 }, MGMT);
  check("R5 pnl=-5: recovery 10 >= 5 → DRAWDOWN_RECOVERY fires", () => {
    assert.ok(exit, "expected exit");
    assert.equal(exit.action, "DRAWDOWN_RECOVERY");
    assert.match(exit.reason, /max_dd=15\.00%/);
    assert.match(exit.reason, /recovered to -5\.00%/);
  });
}

// ─── Scenario 2 — never dropped below armPct → no DRAWDOWN_RECOVERY ──
{
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -3, price: 0.97 }, MGMT);
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -5, price: 0.95 }, MGMT);
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 1, price: 1.01 }, MGMT);
  check("never dropped past armPct → no DD_RECOVERY fire", () => {
    assert.equal(exit, null);
    assert.equal(trade.drawdown_recovery_armed_at, null);
    assert.ok(trade.max_drawdown_pct < 10);
  });
}

// ─── Scenario 3 — full recovery to new peak → no DD_RECOVERY ─────────
{
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: 2, price: 1.02 }, MGMT);   // peak=2
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -10, price: 0.9 }, MGMT);  // dd=12 (armed)
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -12, price: 0.88 }, MGMT); // min=-12
  // Recovery all the way to a NEW peak (3 > prior peak 2) — stillBelowPeak FALSE
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 3, price: 1.03 }, MGMT);
  check("recovery to new peak → DD_RECOVERY suppressed by stillBelowPeak guard", () => {
    assert.equal(exit, null);
    assert.equal(trade.peak_pnl_pct, 3);
  });
}

// ─── Scenario 4 — flag OFF → DD_RECOVERY does not fire ───────────────
{
  config.internalAgents.drawdownRecoveryEnabled = false;
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -15, price: 0.85 }, MGMT);
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -5, price: 0.95 }, MGMT);
  check("flag OFF → DD_RECOVERY silently disabled (legacy behavior)", () => {
    assert.equal(exit, null);
  });
  config.internalAgents.drawdownRecoveryEnabled = true; // restore
}

// ─── Scenario 5 — SL precedence: SL still fires when both would trigger ─
{
  const trade = mkTrade();
  // Drive max_drawdown into armed territory first
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -25, price: 0.75 }, MGMT);
  // Tight SL config — pnl=-30 with stopLossPct=-20 should SL, not DD_RECOVERY
  const tightMgmt = { ...MGMT, stopLossPct: -20 };
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -30, price: 0.7 }, tightMgmt);
  check("SL precedence: SL fires before DRAWDOWN_RECOVERY can even arm path", () => {
    assert.ok(exit);
    assert.equal(exit.action, "STOP_LOSS");
  });
}

// ─── Scenario 6 — TP precedence over DD_RECOVERY ─────────────────────
{
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -12, price: 0.88 }, MGMT); // armed
  // pnl jumps to 8% — exceeds takeProfitPct (we'll set tight TP). TP must win.
  const tpMgmt = { ...MGMT, takeProfitPct: 5 };
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 8, price: 1.08 }, tpMgmt);
  check("TP precedence over DD_RECOVERY", () => {
    assert.ok(exit);
    assert.equal(exit.action, "TAKE_PROFIT");
  });
}

// ─── Scenario 7 — old trade missing new fields still works (?? 0 fallbacks) ─
{
  const legacyTrade = {
    id: "legacy_no_new_fields",
    status: "open",
    opened_at: new Date().toISOString(),
    pool_name: "LEGACY-SOL",
    pool_address: "LEGACYpool11111111111111111111111111111111",
    amount_sol: 0.05,
    entry_price: 1.0,
    peak_pnl_pct: null,
    out_of_range_since: null,
    notes: [],
    // intentionally NO min_pnl_pct / max_drawdown_pct / drawdown_recovery_armed_at
  };
  const exit = evaluatePaperExit(legacyTrade, { price_proxy_pnl_pct: -8, price: 0.92 }, MGMT);
  check("legacy trade w/o new fields evaluates without throwing", () => {
    assert.equal(exit, null);
    assert.equal(legacyTrade.min_pnl_pct, -8);
    // peak_pnl_pct seeds to -8 on first refresh (existing logic), so
    // max_drawdown = peak − current = -8 − (-8) = 0. Just assert finiteness.
    assert.ok(Number.isFinite(legacyTrade.max_drawdown_pct));
  });
}

// ─── Scenario 8 — armed_at sticky once set ───────────────────────────
{
  const trade = mkTrade();
  evaluatePaperExit(trade, { price_proxy_pnl_pct: 2, price: 1.02 }, MGMT);   // seed peak=2
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -10, price: 0.9 }, MGMT);  // dd=12 → armed
  const armedAt = trade.drawdown_recovery_armed_at;
  evaluatePaperExit(trade, { price_proxy_pnl_pct: -11, price: 0.89 }, MGMT);
  check("drawdown_recovery_armed_at is sticky after first arm", () => {
    assert.ok(armedAt, "should have armed timestamp after dd >= 10");
    assert.equal(trade.drawdown_recovery_armed_at, armedAt);
  });
}

console.log(`\nALL ${assertions} assertions PASS`);
