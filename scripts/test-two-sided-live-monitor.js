// scripts/test-two-sided-live-monitor.js
// Andromeda 🌌 Track-C — LIVE two-sided monitoring + exit (BUILT, DORMANT).
//
// Live mirror of the paper two-sided exit (evaluateTwoSidedPaperExit). A LIVE
// two-sided position is a REAL on-chain DLMM position holding a token-X leg (upper
// bins, appreciates on price-up) + a SOL-Y leg. Payoff is INVERTED vs single-side:
//   - price UP → token-X leg appreciates → UPSIDE CAPTURE (bank it)
//   - price DOWN → both legs bleed → DOWN CUT (cut, SL-equivalent floor)
//
// Proves:
//   (1) trackPosition records a two-sided position with the two-leg shape.
//   (2) computeTwoSidedLivePnl marks the two-asset PnL via the on-chain net minus
//       the entry-swap-cost drag; fail-safe on missing data.
//   (3) DOWN-CUT fires on net floor AND on OOR-DOWN timer (highest precedence).
//   (4) UPSIDE-CAPTURE fires on net target AND on OOR-UP-in-profit timer.
//   (5) SINGLE-SIDE monitoring is byte-for-byte unchanged (two_sided !== true
//       skips the branch entirely).
//   (6) Close routes through the exit-decision return (action/reason), NOT a
//       direct close_position call.
//   (7) Missing leg / uncomputable PnL → HOLD (no exit, no crash).
//
// State.js harness pattern (writes/reads a real state.json, restores after).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.2slive-bak");
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

const {
  updatePnlAndCheckExits,
  computeTwoSidedLivePnl,
  evaluateTwoSidedLiveExit,
  trackPosition,
  oorDirection,
} = await import("../state.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

const MGMT = {
  stopLossPct: -8,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: false,
  velocityExitEnabled: false,
  rebalanceOnOorEnabled: false,
  outOfRangeWaitMinutes: 20,
  outOfRangeWaitMinutesDown: 8,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
  // two-sided (reused paper keys)
  twoSidedUpsideCaptureTargetPct: 8,
  twoSidedUpsideCaptureOorMinutes: 0,
  twoSidedDownCutPct: -8,
  twoSidedOorDownCutMinutes: 8,
  twoSidedOorBandPct: 25,
};

// Bin shapes: active outside [lower,upper] = OOR. UP: active>upper. DOWN: active<lower.
const BINS_UP = { lower_bin: 100, upper_bin: 110, active_bin: 130, in_range: false };
const BINS_DOWN = { lower_bin: 100, upper_bin: 110, active_bin: 80, in_range: false };
const BINS_IN = { lower_bin: 100, upper_bin: 110, active_bin: 105, in_range: true };

function twoSidedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "JITOSOL-SOL",
    closed: false,
    two_sided: true,
    two_sided_live: {
      y_leg_sol: 0.05,
      x_leg_tokens: 0.045,
      entry_price: 1.05,        // SOL per token
      entry_swap_cost_sol: 0.001,
      notional_sol: 0.1,
    },
    out_of_range_since: null,
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
const oorSince = (min) => new Date(Date.now() - min * 60000).toISOString();

try {
  console.log("test-two-sided-live-monitor.js — Andromeda Track-C\n");

  // ─────────────────────────────────────────────────────────────
  // (1) trackPosition records a two-sided position with two-leg shape
  // ─────────────────────────────────────────────────────────────
  console.log("(1) Live state tracking — two-sided record shape");
  {
    writeState({});
    const addr = "TRK2S1111111111111111111111111111111111111";
    trackPosition({
      position: addr,
      pool: "POOL2Sxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pool_name: "JITOSOL-SOL",
      strategy: "spot",
      bin_range: { min: 90, max: 145, active: 100 },
      amount_sol: 0.05,          // Y leg
      amount_x: 0.045,           // X leg tokens
      active_bin: 100,
      bin_step: 20,
      volatility: 3,
      two_sided: true,
      entry_price: 1.05,
      entry_swap_cost_sol: 0.001,
      notional: { y_leg_sol: 0.05, x_leg_sol: 0.05, total_notional_sol: 0.1 },
    });
    const p = readPos(addr);
    check("two_sided flag persisted true", () => assert.equal(p.two_sided, true));
    check("two_sided_live.y_leg_sol recorded", () => assert.equal(p.two_sided_live.y_leg_sol, 0.05));
    check("two_sided_live.x_leg_tokens recorded", () => assert.equal(p.two_sided_live.x_leg_tokens, 0.045));
    check("two_sided_live.entry_price recorded", () => assert.equal(p.two_sided_live.entry_price, 1.05));
    check("two_sided_live.entry_swap_cost_sol recorded", () => assert.equal(p.two_sided_live.entry_swap_cost_sol, 0.001));
    check("two_sided_live.notional_sol pulled from object", () => assert.equal(p.two_sided_live.notional_sol, 0.1));
  }
  {
    // Single-side deploy → two_sided false, two_sided_live null (distinct record).
    writeState({});
    const addr = "TRK1S1111111111111111111111111111111111111";
    trackPosition({
      position: addr,
      pool: "POOL1Sxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pool_name: "MEME-SOL",
      strategy: "spot",
      bin_range: { min: 65, max: 100, active: 100 },
      amount_sol: 0.5,
      active_bin: 100,
      bin_step: 100,
      volatility: 4,
      // no two_sided
    });
    const p = readPos(addr);
    check("single-side two_sided === false", () => assert.equal(p.two_sided, false));
    check("single-side two_sided_live === null", () => assert.equal(p.two_sided_live, null));
  }

  // ─────────────────────────────────────────────────────────────
  // (2) computeTwoSidedLivePnl — on-chain net minus entry-swap drag
  // ─────────────────────────────────────────────────────────────
  console.log("\n(2) Two-asset mark-to-market");
  {
    const pos = twoSidedFixture("X");
    // on-chain fee-inclusive +10%, drag = 0.001/0.1*100 = 1% → net 9%.
    const r = computeTwoSidedLivePnl(pos, { pnl_pct_fee_inclusive: 10, pnl_pct: 9 });
    check("net = on-chain feeIncl(10) − drag(1) = 9%", () => {
      assert.equal(r.uncomputable, false);
      assert.equal(r.pnl_pct, 9);
      assert.equal(r.swap_drag_pct, 1);
    });
  }
  {
    // fee-inclusive missing → falls back to reported pnl_pct.
    const pos = twoSidedFixture("X");
    const r = computeTwoSidedLivePnl(pos, { pnl_pct_fee_inclusive: null, pnl_pct: 6 });
    check("feeIncl missing → uses reported pnl_pct (6 − 1 = 5%)", () => {
      assert.equal(r.pnl_pct, 5);
    });
  }
  {
    // both missing → uncomputable (HOLD, never fabricate 0%).
    const pos = twoSidedFixture("X");
    const r = computeTwoSidedLivePnl(pos, { pnl_pct_fee_inclusive: null, pnl_pct: null });
    check("both PnL missing → uncomputable (never fabricate 0)", () => {
      assert.equal(r.uncomputable, true);
      assert.equal(r.pnl_pct, null);
    });
  }
  {
    // missing swap cost / notional → drag 0, on-chain net used as-is (real, not faked).
    const pos = twoSidedFixture("X", { two_sided_live: { y_leg_sol: 0.05, x_leg_tokens: 0.045, entry_price: 1.05, entry_swap_cost_sol: null, notional_sol: null } });
    const r = computeTwoSidedLivePnl(pos, { pnl_pct_fee_inclusive: 7 });
    check("missing swap/notional → 0 drag, net = 7% (on-chain net honest)", () => {
      assert.equal(r.pnl_pct, 7);
      assert.equal(r.swap_drag_pct, 0);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (3) DOWN-CUT — net floor AND OOR-DOWN timer (highest precedence)
  // ─────────────────────────────────────────────────────────────
  console.log("\n(3) DOWN-CUT (both legs bleeding)");
  {
    const addr = "DC2S11111111111111111111111111111111111111";
    // on-chain -8 − 1 drag = -9% <= -8 floor → cut.
    writeState({ [addr]: twoSidedFixture(addr) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct_fee_inclusive: -8, pnl_pct: -8 }, MGMT);
    check("net -9% <= downCut -8% → TWO_SIDED_DOWN_CUT", () => {
      assert.ok(r && r.action === "TWO_SIDED_DOWN_CUT", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // OOR-DOWN 10m >= down-cut 8m, net above floor → cut on timer.
    const addr = "DCOOR11111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { out_of_range_since: oorSince(10) }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct_fee_inclusive: -3, pnl_pct: -3 }, MGMT);
    check("OOR-DOWN 10m >= 8m (net -4%) → TWO_SIDED_DOWN_CUT (timer)", () => {
      assert.ok(r && r.action === "TWO_SIDED_DOWN_CUT", `got ${JSON.stringify(r)}`);
      assert.match(r.reason, /OOR-DOWN/);
    });
  }
  {
    // OOR-DOWN only 5m < 8m, net above floor → HOLD (no premature cut).
    const addr = "DCHOLD11111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { out_of_range_since: oorSince(5) }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct_fee_inclusive: -3, pnl_pct: -3 }, MGMT);
    check("OOR-DOWN 5m < 8m (net -4%) → HOLD", () => assert.equal(r, null));
  }

  // ─────────────────────────────────────────────────────────────
  // (4) UPSIDE-CAPTURE — net target AND OOR-UP-in-profit timer
  // ─────────────────────────────────────────────────────────────
  console.log("\n(4) UPSIDE-CAPTURE (token-X leg worked)");
  {
    // net 10 − 1 = 9% >= target 8 → bank.
    const addr = "UC2S11111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { ...BINS_IN }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_IN, pnl_pct_fee_inclusive: 10, pnl_pct: 10 }, MGMT);
    check("net 9% >= target 8% → TWO_SIDED_UPSIDE_CAPTURE", () => {
      assert.ok(r && r.action === "TWO_SIDED_UPSIDE_CAPTURE", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // OOR-UP in profit, upMin 0 → immediate capture even below net target.
    const addr = "UCOOR11111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { out_of_range_since: oorSince(1) }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct_fee_inclusive: 4, pnl_pct: 4 }, MGMT);
    check("OOR-UP in-profit (net 3%) + upMin 0 → TWO_SIDED_UPSIDE_CAPTURE", () => {
      assert.ok(r && r.action === "TWO_SIDED_UPSIDE_CAPTURE", `got ${JSON.stringify(r)}`);
      assert.match(r.reason, /OOR-UP/);
    });
  }
  {
    // OOR-UP but NOT in profit (net negative) → no capture; down floor not hit → HOLD.
    const addr = "UCNOP11111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { out_of_range_since: oorSince(1) }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct_fee_inclusive: -2, pnl_pct: -2 }, MGMT);
    check("OOR-UP not-in-profit (net -3%) → HOLD (no capture)", () => assert.equal(r, null));
  }
  {
    // DOWN-CUT precedence: a bleeding position that is ALSO somehow flagged UP
    // cannot dodge the floor. net -10 <= -8 → DOWN_CUT wins.
    const addr = "PREC211111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { ...BINS_UP }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct_fee_inclusive: -10, pnl_pct: -10 }, MGMT);
    check("net -11% <= floor → DOWN_CUT pre-empts capture (safety)", () => {
      assert.ok(r && r.action === "TWO_SIDED_DOWN_CUT", `got ${JSON.stringify(r)}`);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (5) SINGLE-SIDE monitoring byte-for-byte unchanged
  // ─────────────────────────────────────────────────────────────
  console.log("\n(5) Single-side unchanged (two_sided !== true skips branch)");
  {
    // A single-side position with net -9% must still STOP_LOSS via the legacy
    // path (NOT TWO_SIDED_DOWN_CUT) — proving the branch is skipped.
    const addr = "SS2S11111111111111111111111111111111111111";
    writeState({
      [addr]: {
        position: addr, pool: "P", pool_name: "MEME-SOL", closed: false,
        two_sided: false, two_sided_live: null,
        out_of_range_since: null, peak_pnl_pct: 0, trailing_active: false,
        partial_tp_done: true, organic_score: 90, notes: [],
        deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      },
    });
    const r = updatePnlAndCheckExits(addr, { ...BINS_IN, pnl_pct: -9, pnl_pct_fee_inclusive: -9 }, MGMT);
    check("single-side net -9% → STOP_LOSS (legacy path, NOT two-sided)", () => {
      assert.ok(r && r.action === "STOP_LOSS", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // Single-side OOR-UP in-profit with directional OFF → legacy OUT_OF_RANGE at
    // the normal timer (proves two-sided upside-capture does NOT leak into it).
    const addr = "SSUP11111111111111111111111111111111111111";
    writeState({
      [addr]: {
        position: addr, pool: "P", pool_name: "MEME-SOL", closed: false,
        two_sided: false, two_sided_live: null,
        out_of_range_since: oorSince(25), peak_pnl_pct: 5, trailing_active: false,
        partial_tp_done: true, organic_score: 50, notes: [],
        deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      },
    });
    const r = updatePnlAndCheckExits(addr, { ...BINS_UP, pnl_pct: 5, pnl_pct_fee_inclusive: 5 }, MGMT);
    check("single-side OOR-UP 25m → OUT_OF_RANGE (legacy, no two-sided capture)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (6) Close routes through exit-decision return, NOT direct close
  // ─────────────────────────────────────────────────────────────
  console.log("\n(6) Close-routing — returns decision, no direct close_position");
  {
    const addr = "RTE211111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { ...BINS_DOWN, out_of_range_since: oorSince(10) }) });
    const r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct_fee_inclusive: -3, pnl_pct: -3 }, MGMT);
    check("exit is a {action,reason} decision object (caller routes to close path)", () => {
      assert.ok(r && typeof r.action === "string" && typeof r.reason === "string");
      // position is NOT mutated to closed by the evaluator (executor owns close).
      assert.equal(readPos(addr).closed, false);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // (7) Missing leg / uncomputable → HOLD, no crash
  // ─────────────────────────────────────────────────────────────
  console.log("\n(7) Fail-safe — missing data → HOLD");
  {
    const addr = "SAFE211111111111111111111111111111111111111";
    writeState({ [addr]: twoSidedFixture(addr, { ...BINS_DOWN, out_of_range_since: oorSince(10) }) });
    let r;
    assert.doesNotThrow(() => {
      // no on-chain PnL at all → uncomputable → HOLD even while OOR-DOWN past timer.
      r = updatePnlAndCheckExits(addr, { ...BINS_DOWN, pnl_pct_fee_inclusive: null, pnl_pct: null }, MGMT);
    });
    check("uncomputable PnL (OOR-DOWN past timer) → HOLD (no exit, no crash)", () => {
      assert.equal(r, null);
    });
  }
  {
    // direct evaluator on a missing position → null (no crash).
    writeState({});
    const r = evaluateTwoSidedLiveExit("NOPExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { ...BINS_DOWN, pnl_pct_fee_inclusive: -20 }, MGMT);
    check("evaluator on missing position → null", () => assert.equal(r, null));
  }

  // Config sanity — reused paper keys exist and are shared.
  console.log("\nConfig — reused paper two-sided keys");
  const { config } = await import("../config.js");
  check("twoSidedDownCutPct present", () => assert.ok(Number.isFinite(config.management.twoSidedDownCutPct)));
  check("twoSidedUpsideCaptureTargetPct present", () => assert.ok(Number.isFinite(config.management.twoSidedUpsideCaptureTargetPct)));
  check("twoSidedOorDownCutMinutes present", () => assert.ok(Number.isFinite(config.management.twoSidedOorDownCutMinutes)));

  console.log(`\n✅ ALL ${assertions} assertions passed.`);
} finally {
  cleanup();
}
