// scripts/test-oor-up-fast-giveback.js
// Andromeda Track-B PROFIT — Fast OOR-UP harvest + Give-back protection.
//
// Covers BOTH the live path (state.js#updatePnlAndCheckExits) and the paper
// mirror (paper-trades.js#evaluatePaperExit):
//
//   FAST OOR-UP HARVEST (oorUpFastExitEnabled / oorUpFastExitMinutes)
//     An OOR-UP single-side-SOL position is 100% idle SOL (zero fee accrual).
//     Instead of parking it for the generic 30m timer, harvest it fast (default
//     3m) to free capital. Own flag (independent of oorDirectionalExitEnabled);
//     takes PRECEDENCE over the "ride the pump" hold; CLOSES (never holds) so it
//     cannot shield a loss (SL/break-even ran above). Distinct close reason
//     `oor_up_fast_harvest`. FAIL-SAFE: direction UNKNOWN / non-finite timer →
//     skip → legacy timer owns it. Default OFF.
//
//   GIVE-BACK PROTECTION (giveBackProtectEnabled / giveBackPeakPct / giveBackDropPct)
//     Once a CONFIRMED peak >= giveBackPeakPct (4%) but BELOW the trailing arm
//     (trailingTriggerPct), a decay of >= giveBackDropPct (2%) from that peak
//     closes in profit — locks the gain instead of round-tripping. Complements
//     trailing (owns [giveBackPeakPct, trailingTriggerPct); ceiling ∞ when
//     trailing off). HARD-guarded to net PnL > 0 → mutually exclusive with
//     STOP_LOSS → SL untouched. Distinct close reason `give_back_protect`.
//     FAIL-SAFE: peak/PnL missing/non-finite/suspicious → skip. Default OFF.
//
// Also asserts: healthy in-range positions are UNTOUCHED; missing data →
// legacy behavior; both flags OFF → byte-for-byte legacy.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.oorfast-bak");
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
function cleanup() {
  if (hadState) fs.copyFileSync(STATE_BACKUP, STATE_FILE);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(STATE_BACKUP)) fs.unlinkSync(STATE_BACKUP);
}

const { updatePnlAndCheckExits } = await import("../state.js");
const { evaluatePaperExit } = await import("../paper-trades.js");

let assertions = 0;
let failures = 0;
function check(label, fn) {
  try {
    fn();
    assertions += 1;
    console.log(`  PASS ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${label}\n        ${e.message}`);
  }
}

const oorAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

// ── Live mgmt config (Andromeda flags default OFF; overridden per test) ──────
const BASE_MGMT = {
  stopLossPct: -8,
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: false,
  velocityExitEnabled: false,
  breakEvenStopEnabled: false,
  rebalanceOnOorEnabled: false,
  feeDecayExitEnabled: false,
  oorDirectionalExitEnabled: false,
  outOfRangeWaitMinutes: 30,
  // Andromeda Track-B keys
  giveBackProtectEnabled: false,
  giveBackPeakPct: 4,
  giveBackDropPct: 2,
  oorUpFastExitEnabled: false,
  oorUpFastExitMinutes: 3,
};

// Bin shapes (mirror state.js#oorDirection). UP: active>upper, DOWN: active<lower.
const BINS_UP = { lower_bin: 100, upper_bin: 110, active_bin: 130, in_range: false };
const BINS_DOWN = { lower_bin: 100, upper_bin: 110, active_bin: 80, in_range: false };
const BINS_IN = { lower_bin: 100, upper_bin: 110, active_bin: 105, in_range: true };
const BINS_MISSING = { in_range: false }; // no bin fields → direction UNKNOWN

function trackedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "TEST-SOL",
    closed: false,
    out_of_range_since: null,
    peak_pnl_pct: 0,
    trailing_active: false,
    partial_tp_done: true,
    be_armed: false,
    organic_score: 90,
    notes: [],
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    confirmed_trailing_exit_until: null,
    confirmed_trailing_exit_reason: null,
    pending_peak_pnl_pct: null,
    ...overrides,
  };
}
// positionData helper: fee-inclusive == price so currentPnlPct is deterministic.
const pd = (bins, pnl) => ({ ...bins, pnl_pct: pnl, pnl_pct_fee_inclusive: pnl, pnl_pct_suspicious: false });

try {
  console.log("test-oor-up-fast-giveback.js — Andromeda Track-B PROFIT\n");

  // ═════════════════════════════════════════════════════════════════
  // LIVE — Give-back protection
  // ═════════════════════════════════════════════════════════════════
  console.log("LIVE give-back protection (state.js)");

  // (1) peak 5% (in [4,18)), decay to 3% → gave back 2% >= 2% → FIRES.
  {
    const addr = "GB1111111111111111111111111111111111111111A";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 3), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("peak 5% → 3% (gave back 2% >= 2%) → GIVE_BACK_PROTECT", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "GIVE_BACK_PROTECT");
      assert.match(r.reason, /^give_back_protect:/);
      assert.equal(r.drop_from_peak_pct, 2);
    });
  }

  // (2) decay too small (peak 5% → 3.5%, gave back 1.5% < 2%) → does NOT fire.
  {
    const addr = "GB2222222222222222222222222222222222222222B";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 3.5), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("gave back 1.5% < 2% → no give-back (null)", () => assert.equal(r, null));
  }

  // (3) peak below arm (peak 3% < 4%) → does NOT fire.
  {
    const addr = "GB3333333333333333333333333333333333333333C";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 3 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 1), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("peak 3% below arm 4% → no give-back (null)", () => assert.equal(r, null));
  }

  // (4) peak ABOVE trailing ceiling (peak 20% >= 18%) → give-back yields to trailing.
  {
    const addr = "GB4444444444444444444444444444444444444444D";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 20, trailing_active: true }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 10), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("peak 20% >= trailing arm 18% → NOT give-back (trailing owns it)", () => {
      assert.ok(r, "expected trailing to fire");
      assert.notEqual(r.action, "GIVE_BACK_PROTECT");
    });
  }

  // (5) never shields a loss — peak 5% but current -10% → SL fires, give-back skipped.
  {
    const addr = "GB5555555555555555555555555555555555555555E";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, -10), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("net -10% (loss) → STOP_LOSS, give-back never shields", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "STOP_LOSS");
    });
  }

  // (6) missing peak (non-finite) → skip → legacy (null in-range).
  {
    const addr = "GB6666666666666666666666666666666666666666F";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: null }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 3), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("peak null (missing) → skip give-back → legacy null", () => assert.equal(r, null));
  }

  // (7) flag OFF → no give-back (legacy). Same shape as (1).
  {
    const addr = "GB7777777777777777777777777777777777777777G";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 3), { ...BASE_MGMT, giveBackProtectEnabled: false });
    check("giveBackProtectEnabled=false → no give-back (legacy null)", () => assert.equal(r, null));
  }

  // ═════════════════════════════════════════════════════════════════
  // LIVE — Fast OOR-UP harvest
  // ═════════════════════════════════════════════════════════════════
  console.log("\nLIVE fast OOR-UP harvest (state.js)");

  // (8) OOR-UP 5m >= 3m fast, flag on → OOR_UP_FAST_HARVEST.
  {
    const addr = "FU1111111111111111111111111111111111111111A";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(5) }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_UP, 2), { ...BASE_MGMT, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3 });
    check("OOR-UP 5m >= 3m → OOR_UP_FAST_HARVEST", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "OOR_UP_FAST_HARVEST");
      assert.match(r.reason, /^oor_up_fast_harvest:/);
      assert.equal(r.minutes_out_of_range, 5);
    });
  }

  // (9) OOR-UP only 1m < 3m fast → no fast exit; legacy 30m timer not hit → null.
  {
    const addr = "FU2222222222222222222222222222222222222222B";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(1) }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_UP, 2), { ...BASE_MGMT, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3 });
    check("OOR-UP 1m < 3m → no fast exit, under legacy timer → null", () => assert.equal(r, null));
  }

  // (10) precedence: directional ON + in-profit (would ride pump) but fast ON → fast wins.
  {
    const addr = "FU3333333333333333333333333333333333333333C";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(5), peak_pnl_pct: 8 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_UP, 8), {
      ...BASE_MGMT, oorDirectionalExitEnabled: true, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3,
    });
    check("fast OOR-UP takes PRECEDENCE over ride-the-pump hold", () => {
      assert.ok(r, "expected an exit (not a hold)");
      assert.equal(r.action, "OOR_UP_FAST_HARVEST");
    });
  }

  // (11) missing bins → direction UNKNOWN → skip fast → legacy timer (30m) not hit → null.
  {
    const addr = "FU4444444444444444444444444444444444444444D";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(5) }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_MISSING, 2), { ...BASE_MGMT, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3 });
    check("missing bins → UNKNOWN dir → fast skipped → legacy null", () => assert.equal(r, null));
  }

  // (12) OOR-DOWN → fast-UP must NOT fire (direction DOWN). Under legacy timer → null.
  {
    const addr = "FU5555555555555555555555555555555555555555E";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(5) }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_DOWN, 2), { ...BASE_MGMT, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3 });
    check("OOR-DOWN → fast-UP does NOT fire (null under legacy timer)", () => assert.equal(r, null));
  }

  // (13) flag OFF → legacy OOR behavior (30m timer), 5m → null.
  {
    const addr = "FU6666666666666666666666666666666666666666F";
    writeState({ [addr]: trackedFixture(addr, { out_of_range_since: oorAgo(5) }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_UP, 2), { ...BASE_MGMT, oorUpFastExitEnabled: false });
    check("oorUpFastExitEnabled=false → legacy OOR timer (null at 5m)", () => assert.equal(r, null));
  }

  // (14) healthy in-range → untouched (null) even with BOTH flags on.
  {
    const addr = "HL1111111111111111111111111111111111111111A";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 2 }) });
    const r = updatePnlAndCheckExits(addr, pd(BINS_IN, 2), {
      ...BASE_MGMT, giveBackProtectEnabled: true, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3,
    });
    check("healthy in-range (+2%, peak 2%) → untouched (null)", () => assert.equal(r, null));
  }

  // ═════════════════════════════════════════════════════════════════
  // PAPER MIRROR (paper-trades.js#evaluatePaperExit)
  // ═════════════════════════════════════════════════════════════════
  console.log("\nPAPER mirror (paper-trades.js)");

  const paperTrade = (o = {}) => ({
    status: "open",
    pool_name: "TEST-SOL",
    entry_price: 100,
    peak_pnl_pct: 0,
    out_of_range_since: null,
    notes: [],
    ...o,
  });
  // snapshot: fee_inclusive drives the decision metric (matches live).
  const snap = (price, pnl) => ({ price, fee_inclusive_pnl_pct: pnl, price_proxy_pnl_pct: pnl });

  // (15) paper give-back: peak 5% → 3% (gave back 2%) → GIVE_BACK_PROTECT.
  {
    const t = paperTrade({ peak_pnl_pct: 5 });
    const r = evaluatePaperExit(t, snap(101, 3), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("paper peak 5% → 3% → GIVE_BACK_PROTECT", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "GIVE_BACK_PROTECT");
      assert.match(r.reason, /^give_back_protect:/);
    });
  }

  // (16) paper give-back missing peak → skip → legacy (in range → null).
  {
    const t = paperTrade({ peak_pnl_pct: null });
    const r = evaluatePaperExit(t, snap(101, 3), { ...BASE_MGMT, giveBackProtectEnabled: true });
    check("paper peak null → skip give-back → null (in range)", () => assert.equal(r, null));
  }

  // (17) paper fast OOR-UP: price 130 (>+25% band = OOR-UP), 5m >= 3m → harvest.
  {
    const t = paperTrade({ peak_pnl_pct: 2, out_of_range_since: oorAgo(5) });
    const r = evaluatePaperExit(t, snap(130, 2), { ...BASE_MGMT, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3 });
    check("paper OOR-UP 5m >= 3m → OOR_UP_FAST_HARVEST", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "OOR_UP_FAST_HARVEST");
      assert.match(r.reason, /^oor_up_fast_harvest:/);
    });
  }

  // (18) paper precedence: directional ON + in-profit (ride) but fast ON → fast wins.
  {
    const t = paperTrade({ peak_pnl_pct: 6, out_of_range_since: oorAgo(5) });
    const r = evaluatePaperExit(t, snap(130, 6), {
      ...BASE_MGMT, oorDirectionalExitEnabled: true, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3,
    });
    check("paper fast OOR-UP takes PRECEDENCE over ride-the-pump", () => {
      assert.ok(r, "expected an exit (not a hold)");
      assert.equal(r.action, "OOR_UP_FAST_HARVEST");
    });
  }

  // (19) paper healthy in-range (price 103 = +3% < 25% band) → untouched.
  {
    const t = paperTrade({ peak_pnl_pct: 2 });
    const r = evaluatePaperExit(t, snap(103, 2), {
      ...BASE_MGMT, giveBackProtectEnabled: true, oorUpFastExitEnabled: true, oorUpFastExitMinutes: 3,
    });
    check("paper healthy in-range → untouched (null)", () => assert.equal(r, null));
  }

  // (20) paper both flags OFF → legacy OOR timer (30m), 5m → null.
  {
    const t = paperTrade({ peak_pnl_pct: 2, out_of_range_since: oorAgo(5) });
    const r = evaluatePaperExit(t, snap(130, 2), { ...BASE_MGMT, oorUpFastExitEnabled: false, giveBackProtectEnabled: false });
    check("paper flags OFF → legacy OOR timer (null at 5m)", () => assert.equal(r, null));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : "SOME FAILED"} — ${assertions} assertions, ${failures} failure(s)`);
} finally {
  cleanup();
}

process.exit(failures === 0 ? 0 : 1);
