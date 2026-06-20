// scripts/test-exit-3-improvements.js
// Vega EXIT-3 — break-even stop (#1), fee-decay exit (#2), maxHold 24h + in-range
// guard (#3). Money-path exit logic on BOTH the live side (state.js
// updatePnlAndCheckExits) and the paper side (paper-trades.js evaluatePaperExit).
//
// All three rules are GATED (default OFF) and run paper+live SEJAJAR. This suite
// proves: each rule fires when it should, fail-safe when data is missing, and
// flag-OFF reproduces legacy behavior (regression). Time is mocked via Date.now.

import assert from "node:assert/strict";
import fs from "node:fs";

// ── Isolate state.json so live-side tests don't touch production state ──
const STATE_FILE = "./state.json";
const BACKUP = STATE_FILE + ".exit3bak";
let hadState = false;
if (fs.existsSync(STATE_FILE)) { fs.copyFileSync(STATE_FILE, BACKUP); hadState = true; }
fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: {}, recentEvents: [], lastUpdated: null }, null, 2));

function restoreState() {
  if (hadState) fs.copyFileSync(BACKUP, STATE_FILE);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
}

const { evaluatePaperExit, recordPaperDeploy } = await import("../paper-trades.js");
const { updatePnlAndCheckExits, trackPosition, getTrackedPosition } = await import("../state.js");

const REAL_NOW = Date.now;
function setNow(ms) { Date.now = () => ms; }
function restoreNow() { Date.now = REAL_NOW; }

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

// Base mgmt config — all EXIT-3 flags ON for the firing tests; individual
// scenarios flip them off to prove regression.
const MGMT = {
  stopLossPct: -8,
  takeProfitPct: 999,            // out of the way
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: false,
  velocityExitEnabled: false,
  outOfRangeWaitMinutes: 30,
  // EXIT-3 #1
  breakEvenStopEnabled: true,
  breakEvenArmPct: 5,
  breakEvenStopPct: 0,
  // EXIT-3 #2
  feeDecayExitEnabled: true,
  feeDecayThreshold: 0.30,
  feeDecayWarmupMinutes: 30,
  feeDecayMinAgeMinutes: 60,
  // EXIT-3 #3
  maxHoldMinutes: 1440,
  maxHoldOorMinutes: 720,
};

const ANCHOR = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
console.log("test-exit-3-improvements.js — Vega break-even / fee-decay / maxHold24");

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #1 BREAK-EVEN STOP — PAPER                                            ║
// ╚═══════════════════════════════════════════════════════════════════════╝
function paperTrade(overrides = {}) {
  return {
    id: "p", status: "open",
    opened_at: new Date(ANCHOR - 2 * HOUR).toISOString(),
    pool_name: "T-SOL", pool_address: "Tpool", base_mint: "Tmint",
    amount_sol: 0.05, entry_price: 1.0,
    peak_pnl_pct: null, out_of_range_since: null,
    min_pnl_pct: 0, max_drawdown_pct: 0, drawdown_recovery_armed_at: null,
    be_armed: false, be_armed_at: null,
    fee_decay_baseline: null, fee_decay_baseline_at: null,
    partial_tp_done: false, rebalance_count: 0,
    entry_fee_tvl_ratio: null,
    notes: [], ...overrides,
  };
}
// Snapshot: feeInclusive null so decisions use price_proxy directly.
function snap(pnl, extra = {}) {
  return { ts: "x", price: 1 + pnl / 100, price_proxy_pnl_pct: pnl, fee_inclusive_pnl_pct: null, ...extra };
}

{
  setNow(ANCHOR);
  // Tick 1: peak +6% arms be. Use trailingTrigger 99 so trailing doesn't interfere.
  const t = paperTrade();
  const m = { ...MGMT, trailingTriggerPct: 99 };
  let exit = evaluatePaperExit(t, snap(6), m);
  check("#1 paper: peak +6% (>=5) arms be_armed, no exit yet", () => {
    assert.equal(exit, null);
    assert.equal(t.be_armed, true);
  });
  // Tick 2: pnl falls to 0% → BREAK_EVEN_STOP (not waiting for -8 SL)
  exit = evaluatePaperExit(t, snap(0), m);
  check("#1 paper: armed + pnl 0% → BREAK_EVEN_STOP (not -8 SL)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "BREAK_EVEN_STOP");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  // peak <5% never arms; pnl drops to -3 → no exit (still above -8 SL)
  const t = paperTrade();
  const m = { ...MGMT, trailingTriggerPct: 99 };
  let exit = evaluatePaperExit(t, snap(4), m);
  exit = evaluatePaperExit(t, snap(-3), m);
  check("#1 paper: peak +4% (<5) never arms; -3% → no BE exit (SL still owns floor)", () => {
    assert.equal(t.be_armed, false);
    assert.equal(exit, null);
  });
  // and still hits the fixed SL at -8
  exit = evaluatePaperExit(t, snap(-9), m);
  check("#1 paper: un-armed -9% → fixed STOP_LOSS still fires (downside intact)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "STOP_LOSS");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  // Flag OFF → never arms even after a big peak; rides to -8 SL (legacy)
  const t = paperTrade();
  const m = { ...MGMT, breakEvenStopEnabled: false, trailingTriggerPct: 99 };
  evaluatePaperExit(t, snap(10), m);
  let exit = evaluatePaperExit(t, snap(0), m);
  check("#1 paper REGRESSION: flag OFF → peak +10% does NOT arm; 0% → no exit", () => {
    assert.equal(t.be_armed, false);
    assert.equal(exit, null);
  });
  exit = evaluatePaperExit(t, snap(-8), m);
  check("#1 paper REGRESSION: flag OFF → -8% → legacy STOP_LOSS", () => {
    assert.ok(exit);
    assert.equal(exit.action, "STOP_LOSS");
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #1 BREAK-EVEN STOP — LIVE (state.js)                                  ║
// ╚═══════════════════════════════════════════════════════════════════════╝
function liveDeploy(addr, overrides = {}) {
  trackPosition({
    position: addr, pool: "Lpool", pool_name: "L-SOL", strategy: "bid_ask",
    bin_range: { bins_below: 40, bins_above: 0 }, amount_sol: 0.05,
    active_bin: 100, bin_step: 100, volatility: 4, fee_tvl_ratio: 0.5,
    organic_score: 70, initial_value_usd: 50, ...overrides,
  });
}
// Live positionData — fee-inclusive null → uses pnl_pct. in_range true keeps OOR out.
function lpd(pnl, extra = {}) {
  return { pnl_pct: pnl, pnl_pct_fee_inclusive: null, in_range: true, age_minutes: 120, ...extra };
}

{
  setNow(ANCHOR);
  liveDeploy("be1");
  const m = { ...MGMT, trailingTriggerPct: 99 };
  // peak must be tracked — peak comes from queuePeakConfirmation in prod; here we
  // set it directly to simulate a confirmed +6% peak.
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions.be1.peak_pnl_pct = 6;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  let exit = updatePnlAndCheckExits("be1", lpd(6), m);
  check("#1 live: confirmed peak +6% arms be_armed", () => {
    assert.equal(getTrackedPosition("be1").be_armed, true);
  });
  exit = updatePnlAndCheckExits("be1", lpd(0), m);
  check("#1 live: armed + pnl 0% → BREAK_EVEN_STOP (pre-empts -8 SL)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "BREAK_EVEN_STOP");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("be2");
  const m = { ...MGMT, trailingTriggerPct: 99 };
  // peak only +3 → never arms
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions.be2.peak_pnl_pct = 3;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  let exit = updatePnlAndCheckExits("be2", lpd(-3), m);
  check("#1 live: peak +3 (<5) → no arm; -3% → no exit", () => {
    assert.equal(getTrackedPosition("be2").be_armed, false);
    assert.equal(exit, null);
  });
  exit = updatePnlAndCheckExits("be2", lpd(-8), m);
  check("#1 live: un-armed -8% → fixed STOP_LOSS", () => {
    assert.ok(exit);
    assert.equal(exit.action, "STOP_LOSS");
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #2 FEE-DECAY EXIT — PAPER                                             ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  // opened 90m ago → past warmup(30) + minAge(60). Baseline from entry_fee_tvl_ratio.
  const t = paperTrade({
    opened_at: new Date(ANCHOR - 90 * MIN).toISOString(),
    entry_fee_tvl_ratio: 1.0,
    be_armed: false,
  });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false };
  // in profit (+4%), fee rate collapsed to 0.2 (< 0.30 * 1.0 = 0.3)
  let exit = evaluatePaperExit(t, snap(4, { fee_tvl_ratio: 0.2 }), m);
  check("#2 paper: in-profit + fee rate 0.2 < 30% of baseline 1.0 → FEE_DECAY_EXIT", () => {
    assert.ok(exit);
    assert.equal(exit.action, "FEE_DECAY_EXIT");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  const t = paperTrade({
    opened_at: new Date(ANCHOR - 90 * MIN).toISOString(),
    entry_fee_tvl_ratio: 1.0,
  });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false };
  // fee rate normal (0.8 > 0.3) → hold
  let exit = evaluatePaperExit(t, snap(4, { fee_tvl_ratio: 0.8 }), m);
  check("#2 paper: fee rate 0.8 (normal) → no fee-decay exit", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  const t = paperTrade({
    opened_at: new Date(ANCHOR - 90 * MIN).toISOString(),
    entry_fee_tvl_ratio: 1.0,
  });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false, stopLossPct: -50 };
  // LOSER (net -3%) + collapsed fee rate → fee-decay must NOT fire (SL owns loser)
  let exit = evaluatePaperExit(t, snap(-3, { fee_tvl_ratio: 0.1 }), m);
  check("#2 paper: loser (-3%) + collapsed fee → FEE_DECAY does NOT fire (SL owns loser)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  const t = paperTrade({
    opened_at: new Date(ANCHOR - 90 * MIN).toISOString(),
    entry_fee_tvl_ratio: null,  // no baseline anywhere
  });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false };
  // fee data missing on snapshot too → no baseline → skip (no false exit)
  let exit = evaluatePaperExit(t, snap(4, { fee_tvl_ratio: null }), m);
  check("#2 paper FAIL-SAFE: no baseline + missing fee data → no FEE_DECAY (skip)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  const t = paperTrade({
    opened_at: new Date(ANCHOR - 90 * MIN).toISOString(),
    entry_fee_tvl_ratio: 1.0,
  });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false, feeDecayExitEnabled: false };
  let exit = evaluatePaperExit(t, snap(4, { fee_tvl_ratio: 0.05 }), m);
  check("#2 paper REGRESSION: flag OFF → collapsed fee rate → no exit", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #2 FEE-DECAY EXIT — LIVE (state.js)                                   ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  liveDeploy("fd1", { fee_tvl_ratio: 1.0 }); // initial_fee_tvl_24h = 1.0
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false };
  // age 90m, in profit, fee rate collapsed to 0.2 < 0.3
  let exit = updatePnlAndCheckExits("fd1", lpd(4, { fee_per_tvl_24h: 0.2, age_minutes: 90 }), m);
  check("#2 live: in-profit + fee/TVL 0.2 < 30% of initial 1.0 → FEE_DECAY_EXIT", () => {
    assert.ok(exit);
    assert.equal(exit.action, "FEE_DECAY_EXIT");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("fd2", { fee_tvl_ratio: 1.0 });
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false, stopLossPct: -50 };
  // LOSER + collapsed → no fee-decay
  let exit = updatePnlAndCheckExits("fd2", lpd(-2, { fee_per_tvl_24h: 0.1, age_minutes: 90 }), m);
  check("#2 live: loser + collapsed fee → no FEE_DECAY (SL owns loser)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("fd3", { fee_tvl_ratio: 0 }); // no baseline from initial
  const m = { ...MGMT, trailingTriggerPct: 99, breakEvenStopEnabled: false };
  // age 40m < warmup-not-relevant, but no baseline AND missing current → skip
  let exit = updatePnlAndCheckExits("fd3", lpd(4, { fee_per_tvl_24h: null, age_minutes: 90 }), m);
  check("#2 live FAIL-SAFE: no usable baseline + missing fee → no FEE_DECAY", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #3 MAX-HOLD 24h + IN-RANGE GUARD — PAPER                             ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  // 13h old + OUT-of-range (price deviation > 25%) → max_hold_oor
  const t = paperTrade({ opened_at: new Date(ANCHOR - 13 * HOUR).toISOString(), entry_price: 1.0 });
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false };
  // price 0.6 → -40% dev → OOR
  let exit = evaluatePaperExit(t, snap(-40, { price: 0.6 }), m);
  check("#3 paper: 13h old + OOR → MAX_HOLD_EXPIRED (max_hold_oor)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
    assert.match(exit.reason, /max_hold_oor/);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  // 13h old + IN-RANGE (small deviation) → NOT closed (winner tail allowed)
  const t = paperTrade({ opened_at: new Date(ANCHOR - 13 * HOUR).toISOString(), entry_price: 1.0 });
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  // price 1.05 → +5% dev → in range, +5% pnl
  let exit = evaluatePaperExit(t, snap(5, { price: 1.05, fee_tvl_ratio: 0.5 }), m);
  check("#3 paper: 13h old + IN-RANGE → NOT closed (ZINC-type tail allowed)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  // 25h old + IN-RANGE → hard close regardless
  const t = paperTrade({ opened_at: new Date(ANCHOR - 25 * HOUR).toISOString(), entry_price: 1.0 });
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  let exit = evaluatePaperExit(t, snap(5, { price: 1.05 }), m);
  check("#3 paper: 25h old (>1440) + IN-RANGE → MAX_HOLD_EXPIRED (max_hold_hard)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
    assert.match(exit.reason, /max_hold_hard/);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  // 11h old + OOR → NOT yet at the 720m OOR limit → not closed by maxHold.
  // Use OOR-UP (price 1.4 = +40% dev, in profit) so no SL/normal-OOR interferes.
  const t = paperTrade({ opened_at: new Date(ANCHOR - 11 * HOUR).toISOString(), entry_price: 1.0 });
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99, trailingTakeProfit: false, outOfRangeWaitMinutes: 99999 };
  // price 1.4 → +40% dev → OOR-UP, in profit, only 660m < 720m OOR limit.
  // (new Date() in the OOR block uses the real clock, not the Date.now mock, so
  // the normal OOR timer may fire on the huge real elapsed; we only assert the
  // MAX-HOLD gate did NOT fire at 11h — the point of this scenario.)
  let exit = evaluatePaperExit(t, snap(40, { price: 1.4 }), m);
  check("#3 paper: 11h old + OOR (< 720m OOR limit) → no MAX_HOLD", () => {
    assert.ok(exit == null || exit.action !== "MAX_HOLD_EXPIRED");
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  #3 MAX-HOLD 24h + IN-RANGE GUARD — LIVE (state.js)                   ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  liveDeploy("mh1");
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false };
  // 13h old + OOR (in_range false) → max_hold_oor
  let exit = updatePnlAndCheckExits("mh1", lpd(2, { in_range: false, age_minutes: 13 * 60 }), m);
  check("#3 live: 13h old + OOR → MAX_HOLD_EXPIRED (max_hold_oor)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
    assert.match(exit.reason, /max_hold_oor/);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("mh2");
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  // 13h old + IN-RANGE → not closed
  let exit = updatePnlAndCheckExits("mh2", lpd(5, { in_range: true, age_minutes: 13 * 60, fee_per_tvl_24h: 0.5 }), m);
  check("#3 live: 13h old + IN-RANGE → NOT closed (tail allowed)", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("mh3");
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  // 25h old + IN-RANGE → hard close
  let exit = updatePnlAndCheckExits("mh3", lpd(5, { in_range: true, age_minutes: 25 * 60 }), m);
  check("#3 live: 25h old (>1440) → MAX_HOLD_EXPIRED (max_hold_hard)", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
    assert.match(exit.reason, /max_hold_hard/);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("mh4");
  // Corrupt deployed_at to null so age is GENUINELY unknown (no age_minutes AND
  // no parseable deploy timestamp) — the fail-safe must skip the gate entirely.
  {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    st.positions.mh4.deployed_at = null;
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  }
  const m = { ...MGMT, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  let exit = updatePnlAndCheckExits("mh4", lpd(5, { in_range: true, age_minutes: undefined, fee_per_tvl_24h: 0.5 }), m);
  check("#3 live FAIL-SAFE: age genuinely unknown (no age + null deployed_at) → no MAX_HOLD", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("mh5");
  const m = { ...MGMT, maxHoldMinutes: 0, breakEvenStopEnabled: false, feeDecayExitEnabled: false, trailingTriggerPct: 99 };
  // maxHoldMinutes=0 → gate off even at 25h
  let exit = updatePnlAndCheckExits("mh5", lpd(5, { in_range: true, age_minutes: 25 * 60, fee_per_tvl_24h: 0.5 }), m);
  check("#3 live REGRESSION: maxHoldMinutes=0 → no MAX_HOLD even at 25h", () => {
    assert.equal(exit, null);
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  PRECEDENCE — maxHold > SL > break-even > ... > fee-decay > OOR        ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  liveDeploy("pr1");
  const m = { ...MGMT, trailingTriggerPct: 99 };
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions.pr1.be_armed = true;        // already armed
  st.positions.pr1.peak_pnl_pct = 6;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  // 25h old + armed + pnl 0 → MAX_HOLD wins over BREAK_EVEN_STOP
  let exit = updatePnlAndCheckExits("pr1", lpd(0, { in_range: true, age_minutes: 25 * 60 }), m);
  check("PRECEDENCE live: maxHold(25h) pre-empts BREAK_EVEN_STOP", () => {
    assert.ok(exit);
    assert.equal(exit.action, "MAX_HOLD_EXPIRED");
  });
  restoreNow();
}

{
  setNow(ANCHOR);
  liveDeploy("pr2");
  const m = { ...MGMT, trailingTriggerPct: 99 };
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions.pr2.be_armed = true;
  st.positions.pr2.peak_pnl_pct = 6;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  // armed + pnl 0% (in range, age 2h) → BREAK_EVEN_STOP wins over fixed SL/fee-decay
  let exit = updatePnlAndCheckExits("pr2", lpd(0, { in_range: true, age_minutes: 120, fee_per_tvl_24h: 0.01 }), m);
  check("PRECEDENCE live: armed BREAK_EVEN_STOP pre-empts fee-decay", () => {
    assert.ok(exit);
    assert.equal(exit.action, "BREAK_EVEN_STOP");
  });
  restoreNow();
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  ALL FLAGS OFF — full legacy behavior (regression)                    ║
// ╚═══════════════════════════════════════════════════════════════════════╝
{
  setNow(ANCHOR);
  liveDeploy("off1");
  const legacy = {
    stopLossPct: -8, trailingTakeProfit: true, trailingTriggerPct: 18, trailingDropPct: 6,
    outOfRangeWaitMinutes: 30, partialTpEnabled: false, velocityExitEnabled: false,
    // all EXIT-3 flags OFF, maxHoldMinutes legacy 720
    breakEvenStopEnabled: false, feeDecayExitEnabled: false, maxHoldMinutes: 720,
  };
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  st.positions.off1.peak_pnl_pct = 10;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  // healthy in-profit, in-range, 2h old → no exit at all
  let exit = updatePnlAndCheckExits("off1", lpd(5, { in_range: true, age_minutes: 120, fee_per_tvl_24h: 50 }), legacy);
  check("REGRESSION live: all EXIT-3 flags OFF + healthy → no exit", () => {
    assert.equal(exit, null);
    assert.equal(getTrackedPosition("off1").be_armed, false);
  });
  restoreNow();
}

restoreState();
console.log(`\nALL ${assertions} assertions PASS`);
