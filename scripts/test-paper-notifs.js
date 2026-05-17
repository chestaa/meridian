// scripts/test-paper-notifs.js
// Vega — verify DRY_RUN paper trade events produce Telegram notifications
// with explicit PAPER / SIMULATION markers. Mocks telegram.js sendHTML via
// __setTestSender so we never touch the real Telegram API.
//
// Assertions ≥ 6. Run via: node scripts/test-paper-notifs.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Sandbox circuit breaker state file BEFORE importing the module ──────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "circuit-breaker-state.json");
const BACKUP_FILE = STATE_FILE + ".paper-notifs-backup";
let hadExisting = false;
if (fs.existsSync(STATE_FILE)) {
  fs.renameSync(STATE_FILE, BACKUP_FILE);
  hadExisting = true;
}
function restore() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
  if (hadExisting && fs.existsSync(BACKUP_FILE)) fs.renameSync(BACKUP_FILE, STATE_FILE);
}
process.on("exit", restore);

const { __setTestSender, notifyDeploy, notifyClose } = await import("../telegram.js");
const {
  assertCircuitOK,
  recordRealizedLoss,
  getCircuitStatus,
  manualReset,
  __setWalletFetchForTest,
} = await import("../account-circuit-breaker.js");

const captured = [];
__setTestSender(async (msg) => { captured.push(msg); });

function takeLast() {
  return captured[captured.length - 1] || null;
}

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

console.log("test-paper-notifs.js — paper-trade Telegram pulse");

// ── 1. DRY_RUN deploy notif fires with SIMULATION marker ────────────────
await notifyDeploy({
  pair: "ABC-SOL",
  amountSol: 0.05,
  position: null,
  tx: null,
  priceRange: { min: 0.0000123, max: 0.0000456 },
  rangeCoverage: { downside_pct: 12.5, upside_pct: 3.1, width_pct: 15.6 },
  binStep: 100,
  baseFee: 1.0,
  dryRun: true,
});
const dryDeploy = takeLast();
check("dry deploy notif captured", () => {
  assert.ok(dryDeploy, "expected a captured message for dry deploy");
});
check("dry deploy contains SIMULATION marker", () => {
  assert.ok(/SIMULATION|PAPER/i.test(dryDeploy.text), `expected SIMULATION/PAPER marker in: ${dryDeploy.text}`);
});
check("dry deploy renders pair + amount", () => {
  assert.ok(dryDeploy.text.includes("ABC-SOL"), "pair missing");
  assert.ok(dryDeploy.text.includes("0.05"), "amount missing");
});
check("dry deploy shows paper-no-tx placeholder (not real tx hash)", () => {
  assert.ok(/PAPER.*no transaction|PAPER.*not on-chain/i.test(dryDeploy.text),
    `expected paper placeholder for tx/position: ${dryDeploy.text}`);
});

// ── 2. LIVE deploy notif keeps existing ✅ Deployed header ──────────────
await notifyDeploy({
  pair: "XYZ-SOL",
  amountSol: 0.03,
  position: "AbCdEfGhIjKlMnOpQrStUv",
  tx: "1234567890abcdef1234567890abcdef",
  binStep: 80,
  baseFee: 0.8,
  dryRun: false,
});
const liveDeploy = takeLast();
check("live deploy notif uses ✅ Deployed header (no SIMULATION)", () => {
  assert.ok(liveDeploy.text.includes("Deployed"), "missing Deployed header");
  assert.ok(!/SIMULATION/i.test(liveDeploy.text), `live deploy must not say SIMULATION: ${liveDeploy.text}`);
  assert.ok(liveDeploy.text.includes("AbCdEfGh"), "position prefix missing");
});

// ── 3. DRY_RUN close notif with pnl_pct + duration + fees ────────────────
await notifyClose({
  pair: "ABC-SOL",
  pnlUsd: -1.23,
  pnlPct: -8.4,
  pnlSol: -0.0042,
  feesSol: 0.0015,
  durationMin: 95,
  feeInclusivePnlPct: -7.2,
  dryRun: true,
});
const dryClose = takeLast();
check("dry close notif contains SIMULATION + pnl_pct + fees + duration", () => {
  assert.ok(/SIMULATION|PAPER/i.test(dryClose.text), `marker missing: ${dryClose.text}`);
  assert.ok(dryClose.text.includes("-8.4"), `pnl_pct missing: ${dryClose.text}`);
  assert.ok(dryClose.text.includes("Fees collected"), `fees line missing: ${dryClose.text}`);
  assert.ok(/1h 35m|95m/.test(dryClose.text), `duration missing: ${dryClose.text}`);
  assert.ok(dryClose.text.includes("ABC-SOL"), "pair missing");
});

// ── 4. LIVE close notif still works without paper marker ─────────────────
await notifyClose({
  pair: "XYZ-SOL",
  pnlUsd: 2.5,
  pnlPct: 12.3,
  pnlSol: 0.012,
  feesSol: 0.003,
  durationMin: 30,
  positionAddress: "POSlive1234567890",
  dryRun: false,
});
const liveClose = takeLast();
check("live close: 🔒 Closed header, no SIMULATION", () => {
  assert.ok(liveClose.text.includes("Closed"), "Closed header missing");
  assert.ok(!/SIMULATION/i.test(liveClose.text), `live close must not say SIMULATION: ${liveClose.text}`);
  assert.ok(liveClose.text.includes("+12.30%"), `positive pnl format missing: ${liveClose.text}`);
});

// ── 5. recordRealizedLoss still callable on losing close ─────────────────
// (proves circuit-breaker write path independent of paper notif change)
// Seed the circuit breaker with a known starting balance so recordRealizedLoss
// can actually update state (otherwise it short-circuits when wallet is null).
__setWalletFetchForTest(null);
await assertCircuitOK(1.0);
const beforeState = getCircuitStatus();
await recordRealizedLoss({
  pnl_pct: -5.0,
  amount_sol: 0.05,
  pool: "TestPool111",
  pool_name: "TEST-SOL",
  reason: "test-paper-notifs",
});
const afterState = getCircuitStatus();
check("recordRealizedLoss writes to circuit state", () => {
  const beforeClosed = beforeState.positions_closed_today ?? beforeState.daily?.positions_closed ?? 0;
  const afterClosed = afterState.positions_closed_today ?? afterState.daily?.positions_closed ?? 0;
  const beforeLoss = Number(beforeState.realized_loss_sol ?? beforeState.daily?.realized_loss_sol ?? 0);
  const afterLoss = Number(afterState.realized_loss_sol ?? afterState.daily?.realized_loss_sol ?? 0);
  assert.ok(
    afterClosed > beforeClosed || afterLoss !== beforeLoss,
    `circuit breaker did not record loss: before=${JSON.stringify(beforeState)} after=${JSON.stringify(afterState)}`,
  );
});

// Cleanup so this test does not bleed into subsequent test runs / cron state.
try { manualReset?.("test-paper-notifs cleanup"); } catch (_) {}
__setTestSender(null);

console.log(`\nALL ${assertions} assertions PASS`);
