// scripts/test-max-hold-exit.js
// Andromeda X2 — verify max-hold-time forced exit precedence.
//
// MAX_HOLD_EXPIRED is the HIGHEST-precedence gate in evaluatePaperExit:
// inserted before SL / TP / Trailing / DRAWDOWN_RECOVERY. A paper trade older
// than mgmt.maxHoldMinutes is force-closed regardless of PnL state — Sirius's
// entry signal is structurally stale past the holding window.
//
// Reversibility: maxHoldMinutes=0 or undefined → legacy behavior preserved.

import assert from "node:assert/strict";

const { evaluatePaperExit } = await import("../paper-trades.js");

const MGMT_BASE = {
  stopLossPct: -50,
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 40,
  trailingDropPct: 10,
  outOfRangeWaitMinutes: 30,
  drawdownRecoveryArmPct: 10,
  drawdownRecoveryDeltaPct: 5,
  maxHoldMinutes: 720, // 12h
};

const REAL_NOW = Date.now;
function setNow(ms) {
  Date.now = () => ms;
}
function restoreNow() {
  Date.now = REAL_NOW;
}

function mkTrade(openedAtMs, overrides = {}) {
  return {
    id: "paper_test_maxhold",
    status: "open",
    opened_at: new Date(openedAtMs).toISOString(),
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

console.log("test-max-hold-exit.js — Andromeda X2 MAX_HOLD_EXPIRED");

// ─── Scenario 1 — 13h old + healthy PnL → MAX_HOLD_EXPIRED fires ─────
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 13 * 60 * 60 * 1000; // 13h ago
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 8, price: 1.08 }, MGMT_BASE);
  check("13h old + healthy +8% PnL → MAX_HOLD_EXPIRED fires", () => {
    assert.ok(exit, "expected exit");
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
    assert.match(exit.reason, /exceeds maxHold 720m/);
    assert.match(exit.reason, /forced close/);
  });
  restoreNow();
}

// ─── Scenario 2 — 6h old + SL hit → SL fires (max hold NOT reached) ──
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 6 * 60 * 60 * 1000; // 6h ago
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const tightSL = { ...MGMT_BASE, stopLossPct: -10 };
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -15, price: 0.85 }, tightSL);
  check("6h old + pnl=-15 (SL=-10) → SL fires, NOT MAX_HOLD_EXPIRED", () => {
    assert.ok(exit, "expected exit");
    assert.equal(exit.action, "STOP_LOSS");
  });
  restoreNow();
}

// ─── Scenario 3 — 13h old + losing → MAX_HOLD_EXPIRED fires (overrides PnL) ──
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 13 * 60 * 60 * 1000;
  setNow(anchor);
  const trade = mkTrade(openedAt);
  // pnl=-30 would normally trigger SL=-50? No, SL=-50 so this doesn't SL.
  // But it IS losing — MAX_HOLD should still fire (time gate is highest).
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -30, price: 0.7 }, MGMT_BASE);
  check("13h old + losing -30% (within SL band) → MAX_HOLD_EXPIRED fires", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
  });
  restoreNow();
}

// ─── Scenario 4 — 13h old + losing past SL → SL fires (SL is even higher precedence... no wait) ──
// Per spec: max-hold is HIGHEST precedence (inserted FIRST). So even if SL also triggers,
// MAX_HOLD wins because the time check runs before the PnL block.
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 13 * 60 * 60 * 1000;
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const tightSL = { ...MGMT_BASE, stopLossPct: -20 };
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: -50, price: 0.5 }, tightSL);
  check("13h old + pnl=-50 (SL=-20) → MAX_HOLD precedence wins over SL", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
  });
  restoreNow();
}

// ─── Scenario 5 — maxHoldMinutes=0 → behavior unchanged (no time gate) ───
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 13 * 60 * 60 * 1000;
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const noMaxHold = { ...MGMT_BASE, maxHoldMinutes: 0 };
  // pnl healthy, no SL/TP/Trailing match → null
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 2, price: 1.02 }, noMaxHold);
  check("maxHoldMinutes=0 disables gate → no MAX_HOLD even after 13h", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

// ─── Scenario 6 — maxHoldMinutes undefined → behavior unchanged ──────
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 13 * 60 * 60 * 1000;
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const noField = { ...MGMT_BASE };
  delete noField.maxHoldMinutes;
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 2, price: 1.02 }, noField);
  check("maxHoldMinutes undefined → no MAX_HOLD gate (silent legacy)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

// ─── Scenario 7 — exactly at boundary (720m) → fires ─────────────────
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 720 * 60 * 1000; // exactly 720m
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 1, price: 1.01 }, MGMT_BASE);
  check("exactly 720m held → MAX_HOLD_EXPIRED fires (>=)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
  });
  restoreNow();
}

// ─── Scenario 8 — just under boundary (719m) → no MAX_HOLD ───────────
{
  const anchor = 1_800_000_000_000;
  const openedAt = anchor - 719 * 60 * 1000; // 719m
  setNow(anchor);
  const trade = mkTrade(openedAt);
  const exit = evaluatePaperExit(trade, { price_proxy_pnl_pct: 1, price: 1.01 }, MGMT_BASE);
  check("719m held (under 720) → no MAX_HOLD fire", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

console.log(`\nALL ${assertions} assertions PASS`);
