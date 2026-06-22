// scripts/test-bluechip-lstsol-range.js
// Vega — Bluechip LST-SOL single-side RANGE-DEGENERATE fix (money-path, Opsi 1).
//
// ROOT CAUSE of masalah #2 (instant-close ~40s on bluechip): single-side SOL
// deploy into a wSOL=tokenY pool MUST set maxBinId = activeBin (0 headroom above)
// because a bin ABOVE the active bin in a tokenY pool holds tokenX (the LST) ONLY
// — funding it would require depositing the LST, i.e. break single-side SOL and
// become two-sided (Opsi A, OUT OF SCOPE here). So a bin-buffer above active is
// NOT SDK-valid for single-side SOL slot-Y. The CORRECT fix is OOR-HANDLING:
//
//   On a near-peg LST-SOL pool with a small bin_step, the FIRST up-tick moves the
//   active bin above upper_bin → OOR-UP within seconds. The legacy OOR-UP ride-pump
//   path (oorDirectionalExitEnabled) only HOLDS when already in-profit; a fresh
//   near-peg position is ~flat/slightly-negative (conversion-edge IL) at that
//   moment, so it fell through to the normal/down OOR timer and got cut at the
//   worst spot. OOR-UP for a single-side SOL slot-Y is the THESIS playing out (SOL
//   converting into the appreciating LST), NOT a stop signal.
//
// FIX (bluechipPatientOorEnabled, default OFF, gated on pos.is_bluechip):
//   - A bluechip near-peg position that is OOR-UP and ABOVE the stop loss is HELD
//     patiently (no instant close, no rebalance-up) even when not-yet-in-profit.
//   - SL still owns true downside (a real de-peg dump = OOR-DOWN / net <= SL fires).
//   - Memecoin path (flag OFF OR pos.is_bluechip falsey) is BYTE-FOR-FOR unchanged.
//
// Single-side SOL is PRESERVED: this test asserts the deploy path keeps amount_x=0
// and maxBinId=activeBin (no bin-buffer hack). Two-sided is NOT introduced here.
//
// Run: node scripts/test-bluechip-lstsol-range.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.lstsol-bak");
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

const { updatePnlAndCheckExits } = await import("../state.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

// 25m ago → past both the normal (20) and down (8) timers (so any "no exit" result
// is genuinely the patient-hold, not just an unreached timer).
const oorSince = () => new Date(Date.now() - 25 * 60000).toISOString();

const BASE_MGMT = {
  stopLossPct: -8,
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: false,
  velocityExitEnabled: false,
  feeDecayExitEnabled: false,
  breakEvenStopEnabled: false,
  rebalanceOnOorEnabled: false,
  rebalanceOnOorMinOrganic: 80,
  maxRebalances: 3,
  outOfRangeWaitMinutes: 20,
  outOfRangeWaitMinutesDown: 8,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
  maxHoldMinutes: 0,                 // disable max-hold so it doesn't pre-empt OOR
  oorDirectionalExitEnabled: true,   // directional OOR is the substrate for this fix
};
// Patient-OOR ON vs OFF
const PATIENT_ON = { ...BASE_MGMT, bluechipPatientOorEnabled: true };
const PATIENT_OFF = { ...BASE_MGMT, bluechipPatientOorEnabled: false };

function trackedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "LST-SOL",
    closed: false,
    is_bluechip: true,
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

// Bin shapes. UP = active above range (the near-peg first-uptick instant-OOR).
const BINS_UP = { lower_bin: 100, upper_bin: 110, active_bin: 111, in_range: false };   // ONE bin above → instant OOR-UP on a small bin_step
const BINS_UP_FAR = { lower_bin: 100, upper_bin: 110, active_bin: 130, in_range: false };
const BINS_DOWN = { lower_bin: 100, upper_bin: 110, active_bin: 90, in_range: false };

try {
  console.log("test-bluechip-lstsol-range.js — Vega range-degenerate fix\n");

  // ──────────────────────────────────────────────────────────────
  // (1) THE BUG REPRO + FIX: near-peg bluechip OOR-UP not-yet-profit
  //     must NOT instant-close (the ~40s churn). Held patiently.
  // ──────────────────────────────────────────────────────────────
  console.log("(1) Near-peg bluechip OOR-UP not-profit → patient hold (no instant close)");
  {
    const addr = "LSTUP11111111111111111111111111111111111111";
    // Position one bin above range (instant OOR-UP), net ~flat (conversion-edge),
    // 25m OOR (past normal+down timers). Legacy: OUT_OF_RANGE. Patient: NO exit.
    writeState({ [addr]: trackedFixture(addr) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP, pnl_pct: -0.5, pnl_pct_fee_inclusive: -0.5 },
      PATIENT_ON,
    );
    check("OOR-UP near-peg not-profit, above SL → NO exit (patient hold, NOT instant-close)", () => {
      assert.equal(r, null, `expected no-exit, got ${JSON.stringify(r)}`);
    });
  }
  // Contrast: flag OFF → legacy instant-close (the bug) is preserved/reproduced.
  {
    const addr = "LSTUPOFF111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP, pnl_pct: -0.5, pnl_pct_fee_inclusive: -0.5 },
      PATIENT_OFF,
    );
    check("flag OFF: OOR-UP near-peg not-profit 25m >= timer → OUT_OF_RANGE (legacy churn reproduced)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // (2) Non-bluechip position is NEVER affected (memecoin unchanged).
  // ──────────────────────────────────────────────────────────────
  console.log("\n(2) Non-bluechip memecoin → patient flag is a no-op (byte-for-byte legacy)");
  {
    const addr = "MEMEUP1111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { is_bluechip: false, organic_score: 50 }) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP, pnl_pct: -0.5, pnl_pct_fee_inclusive: -0.5 },
      PATIENT_ON, // flag ON but pos is NOT bluechip → must behave like legacy
    );
    check("non-bluechip OOR-UP not-profit, flag ON → OUT_OF_RANGE (memecoin untouched)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // (3) SL STILL caps downside on a bluechip OOR-UP (UP never shields a loss).
  //     A real de-peg that drove the net below SL must STILL stop out even
  //     with patient-OOR on. Money-path: downside protection is non-negotiable.
  // ──────────────────────────────────────────────────────────────
  console.log("\n(3) SL caps downside even with patient-OOR on (no infinite hold)");
  {
    const addr = "LSTSL11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP, pnl_pct: -10, pnl_pct_fee_inclusive: -10 },
      PATIENT_ON,
    );
    check("bluechip OOR-UP net -10% <= SL -8% → STOP_LOSS (patient hold NEVER shields a real loss)", () => {
      assert.ok(r && r.action === "STOP_LOSS", `got ${JSON.stringify(r)}`);
    });
  }
  {
    // OOR-DOWN (genuine de-peg dump) on a bluechip → patient hold must NOT apply;
    // a dump below range is depreciation, fees dead → cut on the timer as normal.
    const addr = "LSTDN11111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 50 }) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_DOWN, pnl_pct: -3, pnl_pct_fee_inclusive: -3 },
      PATIENT_ON,
    );
    check("bluechip OOR-DOWN dump → OUT_OF_RANGE (patient hold is UP-only, dump still cut)", () => {
      assert.ok(r && r.action === "OUT_OF_RANGE", `got ${JSON.stringify(r)}`);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // (4) In-profit OOR-UP still rides the pump via the existing trailing path
  //     (patient-OOR must not regress the directional in-profit behavior).
  // ──────────────────────────────────────────────────────────────
  console.log("\n(4) In-profit OOR-UP still arms trailing (no regression of FIX#1)");
  {
    const addr = "LSTPRO1111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 0 }) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP_FAR, pnl_pct: 12, pnl_pct_fee_inclusive: 12 },
      PATIENT_ON,
    );
    check("OOR-UP in-profit → trailing armed, NO exit (FIX#1 path intact)", () => {
      assert.equal(r, null);
      assert.equal(readPos(addr).trailing_active, true);
      assert.equal(readPos(addr).peak_pnl_pct, 12);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // (5) Patient hold does NOT block rebalance-up into a guard violation:
  //     a bluechip OOR-UP must never re-center (buy LST at the top). With
  //     patient-OOR returning early, rebalance can't fire on UP anyway.
  // ──────────────────────────────────────────────────────────────
  console.log("\n(5) No rebalance-up on bluechip OOR-UP (re-center guard preserved)");
  {
    const addr = "LSTREB1111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 95, rebalance_count: 0 }) });
    const r = updatePnlAndCheckExits(
      addr,
      { ...BINS_UP, pnl_pct: -0.5, pnl_pct_fee_inclusive: -0.5 },
      { ...PATIENT_ON, rebalanceOnOorEnabled: true },
    );
    check("bluechip OOR-UP + rebalance ON → patient hold returns null (NOT REBALANCE_OOR up)", () => {
      assert.equal(r, null, `expected patient no-exit, got ${JSON.stringify(r)}`);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // (6) SINGLE-SIDE SOL PRESERVED: deploy path keeps amount_x=0 and
  //     maxBinId=activeBin (NO bin-buffer hack introduced). Asserted via
  //     the dlmm DRY_RUN deploy contract.
  // ──────────────────────────────────────────────────────────────
  console.log("\n(6) Single-side SOL deploy contract preserved (amount_x=0, no bin-buffer)");
  {
    // Drive the real deployPosition logic via the _testHooks.getPool seam so the
    // single-side guards (amount_x>0 refuse + bins_above-on-single-side refuse)
    // are exercised WITHOUT a live RPC/wallet. wSOL is tokenY (slot-Y LST-SOL).
    const WSOL = "So11111111111111111111111111111111111111112";
    const dlmm = await import("../tools/dlmm.js");
    const stubPool = {
      lbPair: {
        tokenXMint: { toString: () => "LSTxMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
        tokenYMint: { toString: () => WSOL },
        binStep: 1, // small bin_step — the near-peg LST-SOL profile
        parameters: { baseFactor: 0 },
      },
      getActiveBin: async () => ({ binId: 1000 }),
    };
    dlmm.__setForTests({ getPool: async () => stubPool });
    try {
      // amount_x > 0 still refused (Opsi A two-sided NOT introduced here).
      let threwX = null;
      try {
        await dlmm.deployPosition({
          pool_address: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          bins_below: 40,
          amount_y: 0.05,
          amount_x: 0.01, // ← attempt two-sided
        });
      } catch (e) {
        threwX = e;
      }
      check("amount_x>0 still REFUSED (single-side only; Opsi A not introduced)", () => {
        assert.ok(threwX && /single-side SOL/i.test(threwX.message), `got ${threwX && threwX.message}`);
      });

      // bins_above > 0 on a single-side SOL deploy still refused (no headroom hack:
      // the fix is OOR-handling, NOT a bin-buffer above active).
      let threwB = null;
      try {
        await dlmm.deployPosition({
          pool_address: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          bins_below: 40,
          bins_above: 5, // ← attempt a bin-buffer above active
          amount_y: 0.05,
          amount_x: 0,
        });
      } catch (e) {
        threwB = e;
      }
      check("bins_above>0 on single-side SOL still REFUSED (bin-buffer hack NOT the fix)", () => {
        assert.ok(threwB && /bins_above|upper bin/i.test(threwB.message), `got ${threwB && threwB.message}`);
      });

      // DRY_RUN happy path: single-side SOL (amount_x=0, bins_below only) returns a
      // would_deploy with amount_x=0 and bins_above=0 (maxBinId=activeBin upheld).
      process.env.DRY_RUN = "true";
      const dry = await dlmm.deployPosition({
        pool_address: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        bins_below: 40,
        amount_y: 0.05,
        amount_x: 0,
      });
      check("single-side SOL DRY_RUN → amount_x=0 AND bins_above=0 (maxBinId=activeBin upheld)", () => {
        assert.equal(dry?.would_deploy?.amount_x, 0, `got ${JSON.stringify(dry)}`);
        assert.equal(dry?.would_deploy?.bins_above, 0, `got ${JSON.stringify(dry)}`);
      });
    } finally {
      dlmm.__resetTests();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // (7) Config default OFF (Bro+Vega enable after paper-soak; bluechip PAUSED).
  // ──────────────────────────────────────────────────────────────
  console.log("\n(7) Config default OFF");
  {
    const { config } = await import("../config.js");
    check("config.management.bluechipPatientOorEnabled default false", () =>
      assert.equal(config.management.bluechipPatientOorEnabled, false));
  }

  console.log(`\nALL ${assertions} assertions passed.`);
} finally {
  cleanup();
}
