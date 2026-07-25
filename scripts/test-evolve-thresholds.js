// scripts/test-evolve-thresholds.js — PR-C regression for evolveThresholds()
//
// Verifies that the key-name fix lands:
//   - maxVolatility branch is GONE (no phantom mutation, no crash)
//   - minFeeTvlRatio renamed to minFeeActiveTvlRatio (matches config.js)
//   - minOrganic still evolves (existing working path)
//   - Changes persist to user-config.json
//
// Pure unit test. No network, no on-chain. Backs up + restores user-config.json
// and lessons.json so the test is idempotent and safe to re-run.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evolveThresholds } from "../lessons.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const USER_CONFIG_PATH = path.join(ROOT, "user-config.json");
const LESSONS_FILE = path.join(ROOT, "lessons.json");
const PROPOSALS_FILE = path.join(ROOT, "threshold-proposals.json");

let passed = 0;
let failed = 0;

function assert(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label} ${detail}`);
  }
}

// ── Backup state ──────────────────────────────────────────────
const userConfigBackup = fs.existsSync(USER_CONFIG_PATH)
  ? fs.readFileSync(USER_CONFIG_PATH, "utf8")
  : null;
const lessonsBackup = fs.existsSync(LESSONS_FILE)
  ? fs.readFileSync(LESSONS_FILE, "utf8")
  : null;
const proposalsBackup = fs.existsSync(PROPOSALS_FILE)
  ? fs.readFileSync(PROPOSALS_FILE, "utf8")
  : null;

// Snapshot of live config screening values we'll mutate
const snapshotScreening = { ...config.screening };

function restore() {
  if (userConfigBackup === null) {
    if (fs.existsSync(USER_CONFIG_PATH)) fs.unlinkSync(USER_CONFIG_PATH);
  } else {
    fs.writeFileSync(USER_CONFIG_PATH, userConfigBackup);
  }
  if (lessonsBackup === null) {
    if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
  } else {
    fs.writeFileSync(LESSONS_FILE, lessonsBackup);
  }
  if (proposalsBackup === null) {
    if (fs.existsSync(PROPOSALS_FILE)) fs.unlinkSync(PROPOSALS_FILE);
  } else {
    fs.writeFileSync(PROPOSALS_FILE, proposalsBackup);
  }
  Object.assign(config.screening, snapshotScreening);
}

try {
  // Ensure baseline floors so test is deterministic regardless of evolved state
  config.screening.minFeeActiveTvlRatio = 0.05;
  config.screening.minOrganic = 60;

  // Lyra propose-only guard: auto-apply is OFF by default now, so this legacy
  // AUTO-APPLY regression must opt in explicitly (the switch only Bro flips).
  // The propose-only default is asserted separately at the end of this file and
  // in scripts/test-bucket-learning.js.
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ learning: { evolveAutoApply: true } }, null, 2));

  // Synthetic perf records:
  //   - 5 winners: high fee_tvl (~0.10), high organic (~80), all profitable
  //   - 5 losers : low  fee_tvl (~0.04), low  organic (~55), all <-5%
  const perfData = [
    // Winners — pnl_pct > 0
    { pnl_pct:  8.0, fee_tvl_ratio: 0.10, organic_score: 78, volatility: 2.0 },
    { pnl_pct: 12.5, fee_tvl_ratio: 0.11, organic_score: 82, volatility: 1.8 },
    { pnl_pct:  6.2, fee_tvl_ratio: 0.09, organic_score: 75, volatility: 2.3 },
    { pnl_pct: 15.1, fee_tvl_ratio: 0.13, organic_score: 84, volatility: 2.1 },
    { pnl_pct:  4.0, fee_tvl_ratio: 0.10, organic_score: 80, volatility: 1.9 },

    // Losers — pnl_pct < -5
    { pnl_pct: -12.0, fee_tvl_ratio: 0.04, organic_score: 52, volatility: 4.5 },
    { pnl_pct: -18.5, fee_tvl_ratio: 0.03, organic_score: 55, volatility: 5.0 },
    { pnl_pct:  -8.7, fee_tvl_ratio: 0.05, organic_score: 50, volatility: 4.2 },
    { pnl_pct: -25.3, fee_tvl_ratio: 0.04, organic_score: 58, volatility: 4.8 },
    { pnl_pct:  -9.1, fee_tvl_ratio: 0.05, organic_score: 54, volatility: 4.3 },
  ];

  // ── Execute ─────────────────────────────────────────────────
  let result;
  let threw = false;
  try {
    result = evolveThresholds(perfData, config);
  } catch (err) {
    threw = true;
    console.error("  evolveThresholds threw:", err.message);
  }

  // 1. Did not throw (validates maxVolatility branch removed cleanly)
  assert("evolveThresholds executes without throwing", threw === false);

  // 2. Returned non-null result with changes
  assert("returns a non-null result object", result != null);
  assert("result.changes is an object", result && typeof result.changes === "object");

  // 3. No phantom maxVolatility key in changes (branch removed entirely)
  assert(
    "changes object has NO maxVolatility key (branch removed)",
    result && !("maxVolatility" in result.changes),
    `got: ${JSON.stringify(result?.changes)}`
  );

  // 4. No legacy minFeeTvlRatio key in changes
  assert(
    "changes object has NO legacy minFeeTvlRatio key",
    result && !("minFeeTvlRatio" in result.changes),
    `got: ${JSON.stringify(result?.changes)}`
  );

  // 5. minFeeActiveTvlRatio evolved (PR-C rename works)
  assert(
    "changes.minFeeActiveTvlRatio is present and > baseline 0.05",
    result && typeof result.changes.minFeeActiveTvlRatio === "number" && result.changes.minFeeActiveTvlRatio > 0.05,
    `got: ${result?.changes?.minFeeActiveTvlRatio}`
  );

  // 6. Live config object mutated for minFeeActiveTvlRatio
  assert(
    "config.screening.minFeeActiveTvlRatio mutated on live object",
    config.screening.minFeeActiveTvlRatio > 0.05,
    `got: ${config.screening.minFeeActiveTvlRatio}`
  );

  // 7. minOrganic evolved (existing working path still functional)
  assert(
    "changes.minOrganic is present and > baseline 60",
    result && typeof result.changes.minOrganic === "number" && result.changes.minOrganic > 60,
    `got: ${result?.changes?.minOrganic}`
  );

  // 8. Live config object mutated for minOrganic
  assert(
    "config.screening.minOrganic mutated on live object",
    config.screening.minOrganic > 60,
    `got: ${config.screening.minOrganic}`
  );

  // 9. user-config.json was written and contains the new key
  const written = fs.existsSync(USER_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
    : {};
  assert(
    "user-config.json persisted minFeeActiveTvlRatio",
    typeof written.minFeeActiveTvlRatio === "number" && written.minFeeActiveTvlRatio > 0.05,
    `got: ${written.minFeeActiveTvlRatio}`
  );

  // 10. user-config.json did NOT pick up phantom keys
  assert(
    "user-config.json has NO maxVolatility key",
    !("maxVolatility" in written),
    `keys: ${Object.keys(written).join(",")}`
  );
  assert(
    "user-config.json has NO legacy minFeeTvlRatio key",
    !("minFeeTvlRatio" in written),
    `keys: ${Object.keys(written).join(",")}`
  );

  // 11. Evolution metadata persisted
  assert(
    "user-config.json includes _lastEvolved timestamp",
    typeof written._lastEvolved === "string" && written._lastEvolved.length > 0
  );
  assert(
    "user-config.json includes _positionsAtEvolution count = 10",
    written._positionsAtEvolution === 10,
    `got: ${written._positionsAtEvolution}`
  );

  // ── 12. PROPOSE-ONLY default: identical data writes NO threshold ──
  // Same winners/losers, but with the shipped default (evolveAutoApply=false):
  // nothing may reach user-config.json or the live config object.
  {
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ learning: { evolveAutoApply: false } }, null, 2));
    if (fs.existsSync(PROPOSALS_FILE)) fs.unlinkSync(PROPOSALS_FILE);
    const isolated = { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 } };
    const proposeOnly = evolveThresholds(perfData, isolated, { notify: false });
    assert(
      "propose-only default: changes EMPTY (nothing applied)",
      proposeOnly && Object.keys(proposeOnly.changes).length === 0,
      `got: ${JSON.stringify(proposeOnly?.changes)}`
    );
    assert(
      "propose-only default: proposals still computed",
      proposeOnly && Array.isArray(proposeOnly.proposals) && proposeOnly.proposals.length > 0
    );
    const uc = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    assert(
      "propose-only default: user-config.json has NO threshold keys",
      !("minFeeActiveTvlRatio" in uc) && !("minOrganic" in uc) && !("_lastEvolved" in uc),
      `keys: ${Object.keys(uc).join(",")}`
    );
    assert(
      "propose-only default: live config object untouched",
      isolated.screening.minFeeActiveTvlRatio === 0.05 && isolated.screening.minOrganic === 60
    );
    assert("propose-only default: proposal queue file written", fs.existsSync(PROPOSALS_FILE));
  }
} finally {
  restore();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
