// scripts/test-btc-synthetic-trips.js — SYNTHETIC HALT proofs for the live path.
//
// VEGA 🔥 — Phase-B requirement #4. Each guard must HALT the live money path under
// a synthetic trigger. We drive executeStep on the LIVE branch (dryRunRaw:"false")
// with injected deps so NO network / NO wallet / NO money is touched, and assert:
//   * kill switch (env)           => no order placed
//   * circuit breaker (>=8% dd via PERSISTED baseline) => no order placed
//   * reconcile drift             => no order placed
//   * independent-price missing   => no order placed (fail-closed, gap #3)
//   * baseline missing/young      => no order placed (fail-closed, gap #1)
// A spy placeOrderFn counts calls — the proof is that it is NEVER called on a trip.
// Run: node scripts/test-btc-synthetic-trips.js

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-trips-"));
process.env.BTC_TSMOM_STATE = path.join(tmp, "pos.json");
process.env.BTC_TSMOM_EQUITY_BASELINE = path.join(tmp, "baseline.json");

const X = await import("../tsmom/btc-executor.js");
const { decideSoak } = await import("../tsmom/tsmom-paper-soak.js");
const { V3_BTC_LONG_PARAMS } = await import("../tsmom/tsmom-variants.js");
const { loadPosition } = await import("../tsmom/btc-position.js");

function uptrendCloses(n, start = 100, drift = 0.004, noiseAmp = 0.01) {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(+(out[i - 1] * (1 + drift + noiseAmp * Math.sin(i * 1.7))).toFixed(6));
  return out;
}
function rowsFrom(closes) {
  return closes.map((c, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: c }));
}
const upRows = rowsFrom(uptrendCloses(360));

// Confirm the underlying decision is an actionable LONG (so a NO-ORDER is a TRIP, not a noop).
const d = decideSoak(upRows, null, V3_BTC_LONG_PARAMS);
ok(d.action === "cold_open" && d.sig.weight > 0, "baseline decision is an actionable LONG (so halts are real trips)");

// Healthy injected deps (so ONLY the trigger under test causes the halt).
const okRec = async () => ({ ok: true, halt: false });
const okPrice = async () => ({ ok: true, price: 60000, source: "test" });
const healthyBaseline = () => ({ equityUsd: 250, age_hours: 24, reason: null });

function spyPlacer() {
  let calls = 0;
  const fn = async () => { calls++; return { success: true, placed: true, signature: "SHOULD_NOT_PLACE", realizedOut: 0.004 }; };
  return { fn, calls: () => calls };
}

function noBook() { const p = loadPosition(); return !p || p.fills.length === 0; }

// ── TRIP 1: KILL SWITCH (env) halts the live path ───────────────────────────────
{
  process.env.BTC_TSMOM_KILL = "1";
  const sp = spyPlacer();
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 250, windowStartEquity: 250, recordSnapshot: false,
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: healthyBaseline },
    dryRunRaw: "false",
  });
  delete process.env.BTC_TSMOM_KILL;
  ok(!r.ordered && r.stage === "kill_switch", "KILL SWITCH => halt (stage kill_switch)");
  ok(sp.calls() === 0, "KILL SWITCH => placeOrder NEVER called");
  ok(noBook(), "KILL SWITCH => no book fill");
}

// ── TRIP 2: CIRCUIT BREAKER via PERSISTED baseline (−8%+ drawdown) ───────────────
{
  // Synthetic −10% drawdown: baseline 250 (24h ago) vs current 225.
  const sp = spyPlacer();
  const drawdownBaseline = () => ({ equityUsd: 250, age_hours: 24, reason: null });
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 225, recordSnapshot: false,
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: drawdownBaseline },
    dryRunRaw: "false",
  });
  ok(!r.ordered && r.stage === "circuit", "CIRCUIT (−10% vs persisted 24h baseline) => halt (stage circuit)");
  ok(/daily_loss_-10\.00pct/.test(r.reason), "CIRCUIT reason names the −10% breach");
  ok(sp.calls() === 0, "CIRCUIT => placeOrder NEVER called");
  ok(noBook(), "CIRCUIT => no book fill");
}

// ── TRIP 2b: CIRCUIT trips at exactly −8% (boundary must fire) ───────────────────
{
  const sp = spyPlacer();
  const eightPct = () => ({ equityUsd: 250, age_hours: 24, reason: null });
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 230, recordSnapshot: false, // 230/250-1 = -8.0%
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: eightPct },
    dryRunRaw: "false",
  });
  ok(!r.ordered && r.stage === "circuit", "CIRCUIT at exactly −8% => halt (boundary fires, no under-trip)");
  ok(sp.calls() === 0, "CIRCUIT −8% => placeOrder NEVER called");
}

// ── TRIP 3: MISSING / YOUNG baseline => circuit fail-closed HALT (gap #1) ────────
{
  const sp = spyPlacer();
  const noBaseline = () => ({ equityUsd: null, age_hours: null, reason: "baseline_too_young_fail_closed" });
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 250, recordSnapshot: false,
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: noBaseline },
    dryRunRaw: "false",
  });
  ok(!r.ordered && r.stage === "circuit" && /equity_unknown/.test(r.reason), "MISSING baseline => circuit fail-closed HALT (never 0% dd)");
  ok(sp.calls() === 0, "MISSING baseline => placeOrder NEVER called");
}

// ── TRIP 4: RECONCILE drift => HALT (chain-vs-book mismatch, fail-closed) ────────
{
  const sp = spyPlacer();
  const driftRec = async () => ({ ok: false, halt: true, reason: "drift_cbBTC" });
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 250, windowStartEquity: 250, recordSnapshot: false,
    deps: { reconcileFn: driftRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: healthyBaseline },
    dryRunRaw: "false",
  });
  ok(!r.ordered && r.halted && r.reason === "reconcile_drift_cbBTC", "RECONCILE drift => HALT");
  ok(sp.calls() === 0, "RECONCILE drift => placeOrder NEVER called (money path blocked)");
  ok(noBook(), "RECONCILE drift => no book fill");
}

// ── TRIP 5: INDEPENDENT PRICE missing => LIVE refuse (gap #3, fail-closed) ───────
{
  const sp = spyPlacer();
  const noPrice = async () => ({ ok: false, price: null, source: null, reason: "no_independent_price_fail_closed" });
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 250, windowStartEquity: 250, recordSnapshot: false,
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: noPrice, resolveBaselineFn: healthyBaseline },
    dryRunRaw: "false",
  });
  ok(!r.ordered && r.halted && r.reason === "independent_price_unavailable_fail_closed", "MISSING independent price => LIVE refuse (no self-referenced quote)");
  ok(sp.calls() === 0, "MISSING price => placeOrder NEVER called");
  ok(noBook(), "MISSING price => no book fill");
}

// ── SANITY: with ALL guards healthy, the live path DOES place (the trips are real) ─
{
  const sp = spyPlacer();
  const r = await X.executeStep({
    rows: upRows, currentEquityUsd: 250, windowStartEquity: 250, recordSnapshot: false,
    deps: { reconcileFn: okRec, placeOrderFn: sp.fn, resolvePriceFn: okPrice, resolveBaselineFn: healthyBaseline },
    dryRunRaw: "false",
  });
  ok(r.ordered && r.booked && sp.calls() === 1, "ALL HEALTHY => order placed once (proves the halts above are caused by the trigger, not a dead path)");
}

console.log(`\nbtc-synthetic-trips: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
