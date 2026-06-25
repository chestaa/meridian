// scripts/test-btc-executor.js — assertions for the signal→order bridge.
// WRAPS decideSoak (no reimplementation). reconcile/order/balances injected;
// isolated state — NO network, NO wallet, NO money.
// Run: node scripts/test-btc-executor.js

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }
async function rejects(fn, msg) {
  try { await fn(); fail++; console.error(`  ✗ ${msg} (did NOT throw)`); } catch { pass++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-exec-"));
process.env.BTC_TSMOM_STATE = path.join(tmp, "pos.json");

const X = await import("../tsmom/btc-executor.js");
const { decideSoak } = await import("../tsmom/tsmom-paper-soak.js");
const { V3_BTC_LONG_PARAMS } = await import("../tsmom/tsmom-variants.js");
const { loadPosition } = await import("../tsmom/btc-position.js");

// ── synthetic series (reuse the soak test's builders) ──────────────────────────
function uptrendCloses(n, start = 100, drift = 0.004, noiseAmp = 0.01) {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(+(out[i - 1] * (1 + drift + noiseAmp * Math.sin(i * 1.7))).toFixed(6));
  return out;
}
function rowsFrom(closes) {
  return closes.map((c, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: c }));
}
const upRows = rowsFrom(uptrendCloses(360)); // > 252 + 60, clearly positive momentum

// Sanity: decideSoak on cold state gives a LONG cold_open (so we're testing a real signal).
const dCold = decideSoak(upRows, null, V3_BTC_LONG_PARAMS);
ok(dCold.action === "cold_open" && dCold.sig.signal === 1 && dCold.sig.weight > 0, "decideSoak gives LONG cold_open on uptrend (signal owned by decideSoak)");

// ── planFromDecision: clamps weight to 1.0, sizes by capped equity ─────────────
const planLong = X.planFromDecision(dCold, { currentEquityUsd: 250, currentCbbtcUnits: 0, cbbtcPriceUsd: 60000 });
ok(planLong.order && planLong.side === "buy", "long plan => buy USDC->cbBTC");
ok(planLong.targetWeight <= 1.0, "weight clamped to <= 1.0 (leverage OFF)");
ok(planLong.targetNotional <= 300 && planLong.amount <= 300, "notional hard-capped <= $300 probe");
ok(Math.abs(planLong.expectedOut - (planLong.amount / 60000)) < 1e-9, "expectedOut = USDC/price");

// ── non-actionable decisions => no order ───────────────────────────────────────
ok(!X.planFromDecision({ action: "mark", sig: dCold.sig }, { currentEquityUsd: 250 }).order, "mark => no order");
ok(!X.planFromDecision({ action: "noop" }, { currentEquityUsd: 250 }).order, "noop => no order");
ok(!X.planFromDecision({ action: "insufficient" }, { currentEquityUsd: 250 }).order, "insufficient => no order");
ok(!X.planFromDecision(null, { currentEquityUsd: 250 }).order, "null decision => no order");

// ── flat target with holdings => sell; flat target while flat => none ──────────
const flatDecision = { action: "rebalance", sig: { signal: 0, weight: 0, date: "2024-12-01" } };
const planExit = X.planFromDecision(flatDecision, { currentEquityUsd: 250, currentCbbtcUnits: 0.004, cbbtcPriceUsd: 60000 });
ok(planExit.order && planExit.side === "sell" && planExit.amount === 0.004, "flat target while holding => sell full cbBTC");
const planNoop = X.planFromDecision(flatDecision, { currentEquityUsd: 250, currentCbbtcUnits: 0, cbbtcPriceUsd: 60000 });
ok(!planNoop.order && planNoop.reason === "already_flat", "flat target while flat => no order");

// ── executeStep: DRY_RUN gate throws on bad value ──────────────────────────────
await rejects(
  () => X.executeStep({ rows: upRows, currentEquityUsd: 250, cbbtcPriceUsd: 60000, dryRunRaw: undefined }),
  "executeStep throws on ambiguous DRY_RUN"
);

// ── executeStep DRY-RUN: computes intended order, places + books NOTHING ───────
let placeCalls = 0;
const dryPlace = async (p) => { placeCalls++; ok(p.dryRunRaw === "true", "dry-run forwards dryRunRaw=true to order"); return { success: true, placed: false, dry_run: true, intended: p }; };
const dryRes = await X.executeStep({
  rows: upRows, currentEquityUsd: 250, cbbtcPriceUsd: 60000,
  deps: { placeOrderFn: dryPlace }, dryRunRaw: "true",
});
ok(!dryRes.ordered && dryRes.isDryRun, "dry-run: ordered=false");
ok(dryRes.intended && dryRes.intended.dry_run, "dry-run: intended order returned");
ok(loadPosition() === null || loadPosition().fills.length === 0, "dry-run: NO book fill written");

// ── executeStep LIVE: reconcile drift => HALT, no order ─────────────────────────
let orderCalls = 0;
const spyPlace = async () => { orderCalls++; return { success: true, placed: true, signature: "S", realizedOut: 0.004 }; };
const driftRec = async () => ({ ok: false, halt: true, reason: "drift_cbBTC" });
const liveDrift = await X.executeStep({
  rows: upRows, currentEquityUsd: 250, cbbtcPriceUsd: 60000,
  deps: { reconcileFn: driftRec, placeOrderFn: spyPlace }, dryRunRaw: "false",
});
ok(!liveDrift.ordered && liveDrift.halted && liveDrift.reason.startsWith("reconcile_"), "live: reconcile drift => HALT");
ok(orderCalls === 0, "live: NO order placed when reconcile halts (money path blocked)");

// ── executeStep LIVE: circuit breaker (>=8% 24h loss) => HALT, no order ─────────
const okRec = async () => ({ ok: true, halt: false });
let orderCalls2 = 0;
const spyPlace2 = async () => { orderCalls2++; return { success: true, placed: true, signature: "S2", realizedOut: 0.004 }; };
const liveCircuit = await X.executeStep({
  rows: upRows, currentEquityUsd: 220, windowStartEquity: 250, cbbtcPriceUsd: 60000,
  deps: { reconcileFn: okRec, placeOrderFn: spyPlace2 }, dryRunRaw: "false",
});
ok(!liveCircuit.ordered && liveCircuit.stage === "circuit", "live: -12% 24h => circuit HALT");
ok(orderCalls2 === 0, "live: NO order when circuit halts");

// ── executeStep LIVE happy path: reconcile ok => place + verify => book fill ────
const okRec2 = async () => ({ ok: true, halt: false });
const okPlace = async () => ({ success: true, placed: true, signature: "SIGLIVE", realizedOut: 0.004, intended: {} });
const liveOk = await X.executeStep({
  rows: upRows, currentEquityUsd: 250, windowStartEquity: 250, cbbtcPriceUsd: 60000,
  deps: { reconcileFn: okRec2, placeOrderFn: okPlace }, dryRunRaw: "false",
});
ok(liveOk.ordered && liveOk.booked, "live happy path: ordered + booked");
ok(loadPosition() && loadPosition().fills.length === 1 && loadPosition().fills[0].signature === "SIGLIVE", "live: book fill persisted with signature");
ok(loadPosition().cbbtc_units === 0.004, "live: book cbBTC units updated to realized out");

console.log(`\nbtc-executor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
