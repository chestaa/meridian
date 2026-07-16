// scripts/test-oor-directional-exit.js
// Vega FIX#1 — OOR DIRECTIONAL exit test suite (live state.js + paper parallel).
//
// Root-cause fix for the win+$0.04 / loss-$1.33 asymmetry: single-side SOL
// deploys (bins_above=0) go OOR-UP on ANY up-move; legacy OOR closed pump and
// dump identically. With oorDirectionalExitEnabled:
//   (a) OOR-UP + in-profit → trailing ARMED, NOT hard-closed; exits on reversal
//       at a LARGER gain than the legacy +sliver close.
//   (b) OOR-DOWN → cut faster via outOfRangeWaitMinutesDown.
//   (c) OOR-UP NOT in-profit → normal timer.
//   (d) REBALANCE_OOR never re-centers an OOR-UP pump (guard).
//   (e) bin data missing → direction UNKNOWN → normal timer (no crash).
//   (f) SL still caps downside regardless of direction.
//   (g) paper + live parallel (same UP/DOWN semantics).
// Regressions: flag OFF → legacy behavior byte-for-byte.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.oordir-bak");
if (!fs.existsSync(path.join(ROOT, "state.js"))) {
  console.error("ERROR: run this test from the Meridian repo root (cwd has no state.js).");
  process.exit(1);
}

let hadState = false;
if (fs.existsSync(STATE_FILE)) {
  fs.copyFileSync(STATE_FILE, STATE_BACKUP);
  hadState = true;
}
function writeState(positions) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions, recentEvents: [], lastUpdated: null }, null, 2));
}
function readPos(addr) {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  return s.positions[addr];
}
function cleanup() {
  if (hadState) fs.copyFileSync(STATE_BACKUP, STATE_FILE);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(STATE_BACKUP)) fs.unlinkSync(STATE_BACKUP);
}

const { updatePnlAndCheckExits, oorDirection } = await import("../state.js");
const { evaluatePaperExit } = await import("../paper-trades.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

// 25m ago → past both the normal (20) and down (8) timers.
const oorSince = () => new Date(Date.now() - 25 * 60000).toISOString();

const BASE_MGMT = {
  stopLossPct: -8,
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: false,        // isolate OOR path from partial TP
  velocityExitEnabled: false,     // isolate from velocity
  rebalanceOnOorEnabled: false,
  rebalanceOnOorMinOrganic: 80,
  maxRebalances: 3,
  outOfRangeWaitMinutes: 20,
  outOfRangeWaitMinutesDown: 8,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
};
const DIR_ON = { ...BASE_MGMT, oorDirectionalExitEnabled: true };
const DIR_OFF = { ...BASE_MGMT, oorDirectionalExitEnabled: false };

function trackedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "TEST-SOL",
    closed: false,
    out_of_range_since: oorSince(),
    peak_pnl_pct: 0,
    trailing_active: false,
    partial_tp_done: true,
    organic_score: 90,
    notes: [],
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    confirmed_trailing_exit_until: null,
    confirmed_trailing_exit_reason: null,
    pending_peak_pnl_pct: null,
    ...overrides,
  };
}

// Bin shapes: active outside [lower,upper] = OOR. UP: active>upper. DOWN: active<lower.
const BINS_UP = { lower_bin: 100, upper_bin: 110, active_bin: 130, in_range: false };
const BINS_DOWN = { lower_bin: 100, upper_bin: 110, active_bin: 80, in_range: false };
const BINS_IN = { lower_bin: 100, upper_bin: 110, active_bin: 105, in_range: true };
const BINS_MISSING = { in_range: false }; // no bin fields

try {
  console.log("test-oor-directional-exit.js — Vega FIX#1\n");

  // ─────────────────────────────────────────────────────────────
  // Pure fn: oorDirection
  // ─────────────────────────────────────────────────────────────
  console.log("oorDirection pure classifier");
  check("active>upper → UP", () => assert.equal(oorDirection(BINS_UP), "UP"));
  check("active<lower → DOWN", () => assert.equal(oorDirection(BINS_DOWN), "DOWN"));
  check("in range → IN", () => assert.equal(oorDirection(BINS_IN), "IN"));
  check("missing bins → UNKNOWN", () => assert.equal(oorDirection(BINS_MISSING), "UNKNOWN"));
  check("active==upper boundary → IN (not UP)", () =>
    assert.equal(oorDirection({ lower_bin: 100, upper_bin: 110, active_bin: 110 }), "IN"));
  check("NaN active → UNKNOWN", () =>
    assert.equal(oorDirection({ lower_bin: 100, upper_bin: 110, active_bin: "x" }), "UNKNOWN"));

  // ─────────────────────────────────────────────────────────────
  // (a) OOR-UP + in-profit → trailing armed, NOT hard-closed; bigger exit
  // ─────────────────────────────────────────────────────────────
  console.log("\n(a) OOR-UP + in-profit → trailing armed (capture pump)");
  {
    const addr = "OORUP11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 0 }) });
    // Pump: fee-inclusive +12% while OOR-up. Legacy would hard-close at +12 sliver.
    const r1 = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: 12, pnl_pct_fee_inclusive: 12 }, DIR_ON);
    check("OOR-UP+profit → NO exit (rode pump), trailing armed", () => {
      assert.equal(r1, null);
      assert.equal(readPos(addr).trailing_active, true);
      assert.equal(readPos(addr).peak_pnl_pct, 12);
    });
    // Price runs higher, peak tracks 25%.
    const r2 = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: 25, pnl_pct_fee_inclusive: 25 }, DIR_ON);
    check("pump continues → still no exit, peak 25%", () => {
      assert.equal(r2, null);
      assert.equal(readPos(addr).peak_pnl_pct, 25);
    });
    // Reversal: drop 6% from peak (25→19) → trailing TP fires at a FAR bigger gain
    // than the legacy +12 OOR close.
    const r3 = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: 19, pnl_pct_fee_inclusive: 19 }, DIR_ON);
    check("reversal 6% from peak → TRAILING_TP at +19% (>> legacy +12 sliver)", () => {
      assert.ok(r3 && r3.action === "TRAILING_TP", `got ${JSON.stringify(r3)}`);
    });
  }
  // Legacy contrast: flag OFF → OOR-up hard-closes at the timer (the +sliver bug).
  {
    const addr = "OORUPLEG111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 12 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: 12, pnl_pct_fee_inclusive: 12 }, DIR_OFF);
    check("flag OFF: OOR-up+profit → OUT_OF_RANGE hard close (legacy bug preserved)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (b) OOR-DOWN → cut faster (down-limit 8 < normal 20)
  // ─────────────────────────────────────────────────────────────
  console.log("\n(b) OOR-DOWN → fast cut on down-limit");
  {
    // 10m OOR: past down-limit(8) but UNDER normal(20).
    const addr = "OORDN11111111111111111111111111111111111111";
    const since10 = new Date(Date.now() - 10 * 60000).toISOString();
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: since10, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct: -3, pnl_pct_fee_inclusive: -3 }, DIR_ON);
    check("OOR-DOWN 10m >= down-limit 8 → OUT_OF_RANGE (cut fast)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
      assert.match(r.reason, /DOWN/);
    });
  }
  {
    // Same 10m DOWN but flag OFF → still in-range vs normal timer(20) → NO close.
    const addr = "OORDNLEG111111111111111111111111111111111111";
    const since10 = new Date(Date.now() - 10 * 60000).toISOString();
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: since10, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct: -3, pnl_pct_fee_inclusive: -3 }, DIR_OFF);
    check("flag OFF: OOR-DOWN 10m < normal 20 → NO exit (legacy waits longer)", () =>
      assert.equal(r, null));
  }
  {
    // down-limit clamp: if down > normal, never wait longer than normal.
    const addr = "OORDNCLAMP1111111111111111111111111111111111";
    const since10 = new Date(Date.now() - 10 * 60000).toISOString();
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: since10, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(
      addr, { ...BINS_DOWN, pnl_pct: -3, pnl_pct_fee_inclusive: -3 },
      { ...DIR_ON, outOfRangeWaitMinutesDown: 99 }, // misconfigured longer-than-normal
    );
    check("down-limit clamped to normal(20): 10m < 20 → NO exit", () => assert.equal(r, null));
  }

  // ─────────────────────────────────────────────────────────────
  // (c) OOR-UP NOT in-profit → normal timer (no special handling)
  // ─────────────────────────────────────────────────────────────
  console.log("\n(c) OOR-UP not-in-profit → normal timer");
  {
    const addr = "OORUPNP111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 50 }) });
    // 25m OOR, UP, but pnl negative → no trailing arm; normal timer (20) reached → close.
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: -2, pnl_pct_fee_inclusive: -2 }, DIR_ON);
    check("OOR-UP not-profit 25m >= normal 20 → OUT_OF_RANGE, trailing NOT armed", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
      assert.equal(readPos(addr).trailing_active, false);
    });
  }
  {
    // OOR-UP not-profit at 10m → normal timer 20 not reached → NO close (no fast cut).
    const addr = "OORUPNP211111111111111111111111111111111111";
    const since10 = new Date(Date.now() - 10 * 60000).toISOString();
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: since10, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: -2, pnl_pct_fee_inclusive: -2 }, DIR_ON);
    check("OOR-UP not-profit 10m < normal 20 → NO exit (NOT fast-cut like DOWN)", () =>
      assert.equal(r, null));
  }

  // ─────────────────────────────────────────────────────────────
  // (d) REBALANCE_OOR guard — never re-center an OOR-UP pump
  // ─────────────────────────────────────────────────────────────
  console.log("\n(d) Rebalance guard — no re-center on OOR-UP");
  {
    // OOR-UP not-profit, high-organic, rebalance ON. Without the guard this would
    // REBALANCE_OOR (buy token at top). Guard must force OUT_OF_RANGE instead.
    const addr = "REBUP11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, rebalance_count: 0 }) });
    const r = updatePnlAndCheckExits(
      addr, { ...BINS_UP, pnl_pct: -1, pnl_pct_fee_inclusive: -1 },
      { ...DIR_ON, rebalanceOnOorEnabled: true },
    );
    check("OOR-UP high-organic + rebalance ON → guard blocks, OUT_OF_RANGE (no re-center)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // OOR-DOWN high-organic + rebalance ON → re-center IS allowed (intended path).
    const addr = "REBDN11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, rebalance_count: 0 }) });
    const r = updatePnlAndCheckExits(
      addr, { ...BINS_DOWN, pnl_pct: -3, pnl_pct_fee_inclusive: -3 },
      { ...DIR_ON, rebalanceOnOorEnabled: true },
    );
    check("OOR-DOWN high-organic + rebalance ON → REBALANCE_OOR (allowed)", () => {
      assert.ok(r && r.action === "REBALANCE_OOR", `got ${JSON.stringify(r)}`);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (e) bin data missing → UNKNOWN → normal timer, no crash
  // ─────────────────────────────────────────────────────────────
  console.log("\n(e) bin missing → fail-safe normal timer");
  {
    const addr = "OORMISS111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 50 }) });
    let r;
    assert.doesNotThrow(() => {
      r = updatePnlAndCheckExits(addr, { ...BINS_MISSING, pnl_pct: 5, pnl_pct_fee_inclusive: 5 }, DIR_ON);
    });
    check("missing bins (25m OOR) → OUT_OF_RANGE on NORMAL timer, no crash", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // Missing bins at 10m → normal timer 20 NOT reached → NO close (NOT fast-cut).
    const addr = "OORMISS211111111111111111111111111111111111";
    const since10 = new Date(Date.now() - 10 * 60000).toISOString();
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: since10, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_MISSING, pnl_pct: 5, pnl_pct_fee_inclusive: 5 }, DIR_ON);
    check("missing bins 10m < normal 20 → NO exit (fail-safe uses normal, not down)", () =>
      assert.equal(r, null));
  }

  // ─────────────────────────────────────────────────────────────
  // (f) SL still caps downside regardless of direction
  // ─────────────────────────────────────────────────────────────
  console.log("\n(f) SL caps downside (direction-agnostic)");
  {
    const addr = "SLDOWN1111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct: -9, pnl_pct_fee_inclusive: -9 }, DIR_ON);
    check("OOR-DOWN net -9% <= SL -8% → STOP_LOSS (pre-empts OOR)", () => {
      assert.ok(r && r.action === "STOP_LOSS", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // Critical: a deeply-underwater OOR-UP must STILL stop-loss (a pump that
    // reversed below entry net of IL). UP must never shield a real loss.
    const addr = "SLUP11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90 }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: -10, pnl_pct_fee_inclusive: -10 }, DIR_ON);
    check("OOR-UP but net -10% <= SL -8% → STOP_LOSS (UP never shields a loss)", () => {
      assert.ok(r && r.action === "STOP_LOSS", `got ${JSON.stringify(r)}`);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (g) Paper parallel — same UP/DOWN semantics via price-vs-entry sign
  // ─────────────────────────────────────────────────────────────
  console.log("\n(g) Paper parallel (price-sign direction proxy)");
  function paperTrade(overrides = {}) {
    return {
      status: "open",
      opened_at: new Date(Date.now() - 120 * 60000).toISOString(),
      pool_name: "PTEST-SOL",
      pool_address: "PPOOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      entry_price: 1.0,
      amount_sol: 0.2,
      peak_pnl_pct: 0,
      partial_tp_done: true,
      entry_organic_score: 90,
      rebalance_count: 0,
      out_of_range_since: new Date(Date.now() - 25 * 60000).toISOString(),
      notes: [],
      ...overrides,
    };
  }
  // Paper OOR-UP + profit: price +40% (above 25% band → OOR), fee-inclusive +40.
  {
    const trade = paperTrade();
    const snap = { price: 1.4, price_proxy_pnl_pct: 40, fee_inclusive_pnl_pct: 40 };
    const r = evaluatePaperExit(trade, snap, { ...DIR_ON, maxHoldMinutes: 0 });
    check("paper OOR-UP+profit → NO exit (trailing armed), peak tracked", () => {
      assert.equal(r, null);
      assert.equal(trade.peak_pnl_pct, 40);
      assert.ok(trade.notes.includes("oor_up_trailing_armed"));
    });
  }
  // Paper OOR-DOWN: price -40% (below band → OOR), 10m past down-limit 8.
  {
    const trade = paperTrade({
      out_of_range_since: new Date(Date.now() - 10 * 60000).toISOString(),
      entry_organic_score: 50,
    });
    const snap = { price: 0.6, price_proxy_pnl_pct: -40, fee_inclusive_pnl_pct: -40 };
    // -40 <= SL -8 would stop-loss first; raise SL out of the way to isolate OOR-DOWN.
    const r = evaluatePaperExit(trade, snap, { ...DIR_ON, maxHoldMinutes: 0, stopLossPct: -90 });
    check("paper OOR-DOWN 10m >= down-limit 8 → OUT_OF_RANGE (fast cut)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
      assert.match(r.reason, /DOWN/);
    });
  }
  // Paper flag OFF: OOR-DOWN 10m < normal 20 → no exit (legacy parallel to live).
  {
    const trade = paperTrade({
      out_of_range_since: new Date(Date.now() - 10 * 60000).toISOString(),
      entry_organic_score: 50,
    });
    const snap = { price: 0.6, price_proxy_pnl_pct: -40, fee_inclusive_pnl_pct: -40 };
    const r = evaluatePaperExit(trade, snap, { ...DIR_OFF, maxHoldMinutes: 0, stopLossPct: -90 });
    check("paper flag OFF: OOR-DOWN 10m < normal 20 → NO exit (matches live legacy)", () =>
      assert.equal(r, null));
  }
  // Paper rebalance guard: OOR-UP not-profit + rebalance ON → no re-center.
  {
    const trade = paperTrade({ entry_organic_score: 90 });
    // price +40 (UP, OOR) but fee-inclusive negative → not-profit branch.
    const snap = { price: 1.4, price_proxy_pnl_pct: -2, fee_inclusive_pnl_pct: -2 };
    const r = evaluatePaperExit(trade, snap, { ...DIR_ON, maxHoldMinutes: 0, stopLossPct: -90, rebalanceOnOorEnabled: true });
    check("paper OOR-UP not-profit + rebalance ON → guard → OUT_OF_RANGE (no re-center)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
      assert.equal(trade.rebalance_count, 0);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Live config — S4a: directional exit ACTIVATED (2026-07-17, staged on branch,
  // Bro-gated for live). down-timer present. NOTE: code DEFAULT stays false
  // (config.js) — this asserts the user-config VALUE is now the intended ON state.
  // ─────────────────────────────────────────────────────────────
  console.log("\nLive config (S4a activation)");
  const { config } = await import("../config.js");
  check("config.management.oorDirectionalExitEnabled ON (S4a — separates OOR-up ride vs OOR-down fast-cut)", () =>
    assert.equal(config.management.oorDirectionalExitEnabled, true));
  check("config.management.outOfRangeWaitMinutesDown present (<= normal)", () => {
    assert.ok(Number.isFinite(config.management.outOfRangeWaitMinutesDown));
    assert.ok(config.management.outOfRangeWaitMinutesDown <= config.management.outOfRangeWaitMinutes);
  });
  check("config.management.stopLossPct === -8 (Vega FIX#2 decision)", () =>
    assert.equal(config.management.stopLossPct, -8));

  console.log(`\n✅ ALL ${assertions} assertions passed.`);
} finally {
  cleanup();
}
