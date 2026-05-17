// scripts/test-executive-mode.js
// Sirius — verify Executive Notification Mode gates noisy notifs while
// preserving critical ones (circuit breaker, big PnL paper closes, live closes).
// Mocks telegram.js sendHTML via __setTestSender — never touches real Telegram.
//
// Assertions >= 8. Run via: node scripts/test-executive-mode.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "circuit-breaker-state.json");
const BACKUP_FILE = STATE_FILE + ".exec-mode-backup";
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

const { config } = await import("../config.js");
const {
  __setTestSender,
  notifyClose,
  notifyCircuitBreaker,
  isExecutiveMode,
  isBigPnl,
  isMeaningfulReport,
} = await import("../telegram.js");

const captured = [];
__setTestSender(async (msg) => { captured.push(msg); });

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

function clear() { captured.length = 0; }
function last() { return captured[captured.length - 1] || null; }

// Save original config to restore later.
const origExec = config.telegram.executiveMode;
const origThreshold = config.telegram.bigPnlThresholdPct;

console.log("test-executive-mode.js — gated notification surface");

// ── 1. Helpers ────────────────────────────────────────────────────────
config.telegram.executiveMode = true;
config.telegram.bigPnlThresholdPct = 15;

check("isExecutiveMode reflects config flag (true)", () => {
  assert.equal(isExecutiveMode(), true);
});

check("isBigPnl uses configured threshold (15%)", () => {
  assert.equal(isBigPnl(20), true, "|20| >= 15 should be big");
  assert.equal(isBigPnl(-25), true, "|-25| >= 15 should be big");
  assert.equal(isBigPnl(5), false, "|5| < 15 should NOT be big");
  assert.equal(isBigPnl(-10), false, "|-10| < 15 should NOT be big");
  assert.equal(isBigPnl(null), false, "null should NOT be big");
});

// ── 2. Executive ON + small-PnL paper close: notif via paper-trades.js NOT fired ─
// We test the gating logic at the call site (closePaperTrade), which is where
// the policy lives. Simulate the gate decision directly.
clear();
const smallPnl = -8.4;
const shouldFireSmall = !isExecutiveMode() || isBigPnl(smallPnl);
check("execMode=true + small PnL: paper close gate decides NOT to fire", () => {
  assert.equal(shouldFireSmall, false, "small-PnL paper close should be silenced");
});

// ── 3. Executive ON + big-PnL paper close: notif via notifyClose IS fired ─
clear();
const bigPnl = -20.0;
const shouldFireBig = !isExecutiveMode() || isBigPnl(bigPnl);
check("execMode=true + big PnL: paper close gate decides TO fire", () => {
  assert.equal(shouldFireBig, true, "big-PnL paper close should fire");
});
// Actually fire the notif to ensure the underlying call still works.
await notifyClose({
  pair: "BIG-SOL",
  pnlUsd: -5.0,
  pnlPct: bigPnl,
  pnlSol: -0.02,
  feesSol: 0.001,
  durationMin: 45,
  feeInclusivePnlPct: bigPnl,
  dryRun: true,
});
check("notifyClose still emits SIMULATION marker on big-PnL paper close", () => {
  const msg = last();
  assert.ok(msg, "expected captured msg");
  assert.ok(/SIMULATION|PAPER/i.test(msg.text), `paper marker missing: ${msg.text}`);
  assert.ok(msg.text.includes("-20"), "pnl value missing");
});

// ── 4. Executive OFF (legacy): every paper close fires regardless of PnL ─
config.telegram.executiveMode = false;
clear();
const shouldFireLegacy = !isExecutiveMode() || isBigPnl(smallPnl);
check("execMode=false: small-PnL paper close fires (legacy path)", () => {
  assert.equal(shouldFireLegacy, true, "legacy mode must not gate paper closes");
});

// ── 5. Circuit breaker source has NO isExecutiveMode gate (critical safety) ─
// Static-verify by reading telegram.js: notifyCircuitBreaker's body must not
// reference isExecutiveMode. This guarantees the path is never silenced by
// executive mode regardless of TOKEN/chatId environment in tests.
config.telegram.executiveMode = true;
const telegramSrc = fs.readFileSync(path.join(ROOT, "telegram.js"), "utf8");
const breakerFnStart = telegramSrc.indexOf("export async function notifyCircuitBreaker");
const breakerFnEnd = telegramSrc.indexOf("\n}", breakerFnStart);
const breakerBody = telegramSrc.slice(breakerFnStart, breakerFnEnd);
check("notifyCircuitBreaker body has NO isExecutiveMode gate", () => {
  assert.ok(breakerFnStart > 0, "notifyCircuitBreaker not found in telegram.js");
  assert.ok(!breakerBody.includes("isExecutiveMode"),
    "notifyCircuitBreaker must NEVER be gated by executive mode");
  assert.ok(breakerBody.includes("CIRCUIT BREAKER"), "header text missing");
});

// ── 6. Reversibility — flipping flag back restores legacy behavior ────
config.telegram.executiveMode = false;
check("flipping executiveMode=false makes isExecutiveMode() return false", () => {
  assert.equal(isExecutiveMode(), false);
});

// ── 7. Custom threshold honored ───────────────────────────────────────
config.telegram.executiveMode = true;
config.telegram.bigPnlThresholdPct = 30;
check("custom bigPnlThresholdPct=30 honored by isBigPnl", () => {
  assert.equal(isBigPnl(20), false, "20% no longer big at threshold 30");
  assert.equal(isBigPnl(-35), true, "35% still big at threshold 30");
});

// ── 8. Live close (dryRun=false) still fires in executive mode ────────
// Live deploys/closes are operator-critical money events; they bypass the
// paper-trades.js gate entirely (executor.js calls notifyClose without the
// isExecutiveMode wrap). Verify the notifyClose helper itself does not block.
config.telegram.executiveMode = true;
config.telegram.bigPnlThresholdPct = 15;
clear();
await notifyClose({
  pair: "LIVE-SOL",
  pnlUsd: 1.0,
  pnlPct: 2.0,  // small PnL but LIVE close
  pnlSol: 0.001,
  feesSol: 0.0005,
  durationMin: 20,
  dryRun: false,
});
check("execMode=true + LIVE close + small PnL: notifyClose still fires (no internal gate)", () => {
  const msg = last();
  assert.ok(msg, "live close must fire in exec mode");
  assert.ok(!/SIMULATION/i.test(msg.text), `live close must not say SIMULATION: ${msg.text}`);
  assert.ok(msg.text.includes("Closed"), "Closed header missing");
});

// ── 9. HOTFIX-5: isMeaningfulReport gate for cycle final reports ─────
// Exec mode silences cycle headers + tool echoes BUT must let Orion's
// verdict analysis (DEPLOY / NO DEPLOY / dev-sold/dump narrative) through.
config.telegram.executiveMode = true;

check("isMeaningfulReport: NO DEPLOY verdict with rationale → fires", () => {
  const orionVerdict =
    "NO DEPLOY. Dev sold all 1h ago — token down 44% on the dump. " +
    "Holder count collapsing, top10 concentration spiked. Hard pass.";
  assert.equal(isMeaningfulReport(orionVerdict), true);
});

check("isMeaningfulReport: DEPLOY decision with deploy_args → fires", () => {
  const orionVerdict =
    "DEPLOY this pool. Strong organic volume, bundlers low, smart wallets " +
    "accumulating. Recommend bid_ask, bins_below 50, 0.5 SOL.";
  assert.equal(isMeaningfulReport(orionVerdict), true);
});

check("isMeaningfulReport: BEST LOOKING CANDIDATE summary → fires", () => {
  const orionSummary =
    "BEST LOOKING CANDIDATE: PEPE-SOL. Volume/TVL ratio 0.42, " +
    "holders 1200+, no dev concentration. Rationale: organic flow.";
  assert.equal(isMeaningfulReport(orionSummary), true);
});

check("isMeaningfulReport: mgmt close-decision rationale → fires", () => {
  const orionMgmt =
    "Close position 1 — OOR for 45 minutes, no recovery signal. " +
    "Hold position 2, still earning fees in active bin.";
  assert.equal(isMeaningfulReport(orionMgmt), true);
});

check("isMeaningfulReport: 'no open positions' boilerplate → silent", () => {
  assert.equal(
    isMeaningfulReport("No open positions. Triggering screening cycle."),
    false
  );
  assert.equal(
    isMeaningfulReport("No open positions. Screening already running or cooling down."),
    false
  );
});

check("isMeaningfulReport: empty / just-header text → silent", () => {
  assert.equal(isMeaningfulReport(""), false);
  assert.equal(isMeaningfulReport(null), false);
  assert.equal(isMeaningfulReport(undefined), false);
  assert.equal(isMeaningfulReport("   "), false);
  assert.equal(isMeaningfulReport("Evaluating positions..."), false);
});

check("isMeaningfulReport: cycle failure boilerplate → silent", () => {
  assert.equal(
    isMeaningfulReport("Screening pre-check failed: insufficient SOL"),
    false
  );
  assert.equal(
    isMeaningfulReport("Management cycle failed: RPC timeout"),
    false
  );
  assert.equal(
    isMeaningfulReport("No candidates available after filtering"),
    false
  );
});

check("isMeaningfulReport: VERDICT marker (case insensitive) → fires", () => {
  const text =
    "Verdict: skip. Pool has 80% top10 concentration which violates " +
    "screener safety thresholds. Will not deploy.";
  assert.equal(isMeaningfulReport(text), true);
});

// ── 10. Case-sensitivity hardening — actual TG messages use Title/All caps ──
// Observed leak: "No open positions. Screening already running" (capital N)
// slipped through 30-min observation window. Gate must reject ALL case
// variants of cycle boilerplate.
check("isMeaningfulReport: TitleCase 'No open positions...' boilerplate → silent", () => {
  assert.equal(
    isMeaningfulReport("No open positions. Screening already running or cooling down."),
    false
  );
  assert.equal(
    isMeaningfulReport("No open positions. Triggering screening cycle."),
    false
  );
});

check("isMeaningfulReport: ALL CAPS 'NO OPEN POSITIONS...' boilerplate → silent", () => {
  assert.equal(
    isMeaningfulReport("NO OPEN POSITIONS. SCREENING ALREADY RUNNING OR COOLING DOWN."),
    false
  );
  assert.equal(
    isMeaningfulReport("NO OPEN POSITIONS. TRIGGERING SCREENING CYCLE."),
    false
  );
});

check("isMeaningfulReport: mixed-case cycle-failure boilerplate → silent", () => {
  assert.equal(
    isMeaningfulReport("Management Cycle Failed: RPC timeout after 30s retry"),
    false
  );
  assert.equal(
    isMeaningfulReport("SCREENING PRE-CHECK FAILED: insufficient SOL balance"),
    false
  );
  assert.equal(
    isMeaningfulReport("No Candidates Available after filtering current trending list"),
    false
  );
});

// Restore original config + cleanup
config.telegram.executiveMode = origExec;
config.telegram.bigPnlThresholdPct = origThreshold;
__setTestSender(null);

console.log(`\nALL ${assertions} assertions PASS`);
