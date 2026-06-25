// scripts/test-btc-reconcile.js — fail-closed assertions for chain-vs-book
// reconciliation. Chain read injected, alert disabled — NO network, NO money.
// Run: node scripts/test-btc-reconcile.js

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-rec-"));
process.env.BTC_TSMOM_STATE = path.join(tmp, "pos.json");

const R = await import("../tsmom/btc-reconcile.js");
const { CBBTC_MINT, USDC_MINT } = await import("../tsmom/btc-guards.js");

// ── legReconcile pure ───────────────────────────────────────────────────────────
ok(R.legReconcile(0.004, 0.004, 0.01, 1e-6).ok, "exact match => ok");
ok(R.legReconcile(0.004, 0.004001, 0.01, 1e-6).ok, "tiny dust within tol => ok");
ok(!R.legReconcile(0.004, 0.0045, 0.01, 1e-6).ok, "12% drift beyond tol => not ok");
ok(R.legReconcile(0, 0, 0.01, 1e-6).ok, "both flat => ok");
ok(!R.legReconcile(0, 0.01, 0.01, 1e-6).ok, "book flat, chain holds => drift not ok");
ok(!R.legReconcile(0.004, null, 0.01, 1e-6).ok, "non-finite chain => fail-closed");
ok(!R.legReconcile(NaN, 0.004, 0.01, 1e-6).ok, "NaN book => fail-closed");

// ── reconcile: chain read failure => halt ───────────────────────────────────────
const failRead = async () => ({ error: true, error_message: "helius down", tokens: [] });
const rFail = await R.reconcile({ book: { cbbtc_units: 0.004, usdc_units: 250 }, getBalances: failRead, alert: false });
ok(!rFail.ok && rFail.halt && rFail.reason.startsWith("chain_read_failed"), "chain read failure => HALT (fail-closed)");

// ── reconcile: matching book + chain => ok ──────────────────────────────────────
const goodRead = async () => ({ error: false, usdc: 200, tokens: [{ mint: CBBTC_MINT, balance: 0.004 }, { mint: USDC_MINT, balance: 200 }] });
const rOk = await R.reconcile({ book: { cbbtc_units: 0.004, usdc_units: 200 }, getBalances: goodRead, alert: false });
ok(rOk.ok && !rOk.halt, "book matches chain => ok, no halt");

// ── reconcile: cbBTC drift => halt ──────────────────────────────────────────────
const driftCb = async () => ({ error: false, usdc: 200, tokens: [{ mint: CBBTC_MINT, balance: 0.0080 }, { mint: USDC_MINT, balance: 200 }] });
const rCb = await R.reconcile({ book: { cbbtc_units: 0.004, usdc_units: 200 }, getBalances: driftCb, alert: false });
ok(!rCb.ok && rCb.halt && rCb.reason.includes("cbBTC"), "cbBTC drift (2x) => HALT");

// ── reconcile: USDC drift => halt ───────────────────────────────────────────────
const driftUsdc = async () => ({ error: false, usdc: 50, tokens: [{ mint: CBBTC_MINT, balance: 0.004 }, { mint: USDC_MINT, balance: 50 }] });
const rUsdc = await R.reconcile({ book: { cbbtc_units: 0.004, usdc_units: 200 }, getBalances: driftUsdc, alert: false });
ok(!rUsdc.ok && rUsdc.halt && rUsdc.reason.includes("USDC"), "USDC drift => HALT");

// ── reconcile: cold book (no state) but chain flat => ok ───────────────────────
const flatRead = async () => ({ error: false, usdc: 300, tokens: [{ mint: USDC_MINT, balance: 300 }] });
const rCold = await R.reconcile({ book: { cbbtc_units: 0, usdc_units: 300 }, getBalances: flatRead, alert: false });
ok(rCold.ok && !rCold.halt, "cold/flat book matches flat chain => ok");

// ── reconcile: cold book but chain HOLDS cbBTC (un-booked!) => halt ────────────
const unbooked = async () => ({ error: false, usdc: 200, tokens: [{ mint: CBBTC_MINT, balance: 0.005 }, { mint: USDC_MINT, balance: 200 }] });
const rUnbooked = await R.reconcile({ book: { cbbtc_units: 0, usdc_units: 200 }, getBalances: unbooked, alert: false });
ok(!rUnbooked.ok && rUnbooked.halt, "un-booked chain cbBTC vs flat book => HALT");

console.log(`\nbtc-reconcile: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
