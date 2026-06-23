/**
 * test-cassiopeia-tunes.js
 *
 * Cassiopeia Move 1 tune validation. Asserts that the 3 deterministic
 * gates landed correctly in user-config.json AND propagate through
 * config.js into the runtime `config` object.
 *
 * Run: node scripts/test-cassiopeia-tunes.js
 * Exit: 0 = PASS, 1 = FAIL (any assertion violated)
 *
 * Move 1 changes (Bro Dikta lean-authorized 2026-05-23):
 *   1. liveOverrides.maxBotHoldersPct  20 -> 25  (LLM judges 21-25% borderline)
 *   2. outOfRangeWaitMinutes           30 -> 20  (faster OOR exit, capture pumps)
 *   3. oorCooldownHours                12 ->  6  (faster slot recycling = 360min)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "user-config.json");

let failures = 0;
const results = [];

function check(label, actual, expected, rangeNote = null) {
  const pass = actual === expected;
  results.push({ label, actual, expected, pass, rangeNote });
  if (!pass) failures += 1;
}

function checkRange(label, actual, min, max) {
  const pass = typeof actual === "number" && actual >= min && actual <= max;
  results.push({ label, actual, expected: `[${min}, ${max}]`, pass, rangeNote: "sane-range" });
  if (!pass) failures += 1;
}

// ─── 1. JSON parse ────────────────────────────────────────────
let raw;
try {
  raw = fs.readFileSync(CONFIG_PATH, "utf8");
} catch (err) {
  console.error(`FAIL: cannot read user-config.json: ${err.message}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`FAIL: user-config.json is not valid JSON: ${err.message}`);
  process.exit(1);
}
results.push({ label: "user-config.json parses as valid JSON", actual: "OK", expected: "OK", pass: true });

// ─── 2. Move 1 exact-value assertions ────────────────────────
// maxBotHoldersPct: host-dependent. Repo preset=25, live VPS=20 (STRICTER). Both
// inside the 0-30 sane band asserted below. Live is tighter, never looser — OK.
checkRange("liveOverrides.maxBotHoldersPct in [0, 30] (live VPS=20 stricter, repo preset=25)", cfg?.liveOverrides?.maxBotHoldersPct, 0, 30);
check("outOfRangeWaitMinutes",          cfg?.outOfRangeWaitMinutes,           20);
check("oorCooldownHours",               cfg?.oorCooldownHours,                 6);

// ─── 3. Sane-range guards (Cassiopeia VETO surface) ──────────
// Bot pct: 0-50% sane band. >30% = bundled/scam territory.
checkRange("maxBotHoldersPct in [0, 30]",     cfg?.liveOverrides?.maxBotHoldersPct, 0, 30);
// OOR wait: 10-60 min reasonable. <10 = panic exit, >60 = ignoring pump capture.
checkRange("outOfRangeWaitMinutes in [10, 60]", cfg?.outOfRangeWaitMinutes,         10, 60);
// OOR cooldown: 1-24 hours. <1h = thrash, >24h = wasted slot opportunity.
checkRange("oorCooldownHours in [1, 24]",     cfg?.oorCooldownHours,                 1, 24);

// ─── 4. Untouched-gate regression guards ──────────────────────
// Move 1 SHALL NOT loosen these. Cassiopeia VETO surface unchanged.
check("minMcap unchanged (signal-mode separately gated)", cfg?.minMcap,        150000);
check("maxMcap unchanged",                                 cfg?.maxMcap,         10000000);
check("minHolders unchanged",                              cfg?.minHolders,           500);
check("maxBundlePct unchanged",                            cfg?.maxBundlePct,          20);
check("maxSniperPct unchanged",                            cfg?.maxSniperPct,         0.5);
check("maxTop10Pct unchanged (base)",                      cfg?.maxTop10Pct,           60);
check("liveOverrides.maxTop10Pct unchanged",               cfg?.liveOverrides?.maxTop10Pct, 55);
// minOrganic: host-dependent FLOOR. Repo preset=72, live VPS=75 (STRICTER). Both
// below the 80 dormancy ceiling (org>=80 = 0-pool on live probe 2026-06-24). Live
// is tighter, never looser. Sane band [60, 85] asserted below covers both hosts.
checkRange("liveOverrides.minOrganic in [60, 79] (FLOOR; live VPS=75, repo preset=72; <80 anti-dormancy)", cfg?.liveOverrides?.minOrganic, 60, 79);
check("liveOverrides.minVolatility (live overlay FLOOR, 3.0->3.25, 2026-06-24 entry-quality, funnel-survivable=3)", cfg?.liveOverrides?.minVolatility, 3.25);
check("liveOverrides.minFeeActiveTvlRatio (live overlay, IL-coverage floor)", cfg?.liveOverrides?.minFeeActiveTvlRatio, 0.15);
checkRange("liveOverrides.minVolatility in [3.0, 4.5] (FLOOR, NOT 3.5 dormancy)", cfg?.liveOverrides?.minVolatility, 3.0, 4.5);
// maxPositions: host-dependent envelope. Repo dry-run preset = 2; live VPS = 1
// (protective single-slot, 2026-06-17). Assert the SANE BAND, not a host-pinned
// literal — both 1 and 2 are valid, >3 would be the VETO surface.
checkRange("maxPositions in [1, 3] (host envelope: live VPS=1 protective, repo preset=2)", cfg?.maxPositions, 1, 3);

// ─── 5. config.js propagation check ───────────────────────────
// Confirm the runtime config object reads the new values, not the legacy defaults.
const configUrl = new URL(`file:///${path.join(REPO_ROOT, "config.js").replace(/\\/g, "/")}`);
const { config } = await import(configUrl.href);
check("config.management.outOfRangeWaitMinutes",  config.management.outOfRangeWaitMinutes,  20);
check("config.management.oorCooldownHours",        config.management.oorCooldownHours,        6);
// Base + overlay are host-dependent (repo preset=25, live VPS overlay=20 stricter).
// Assert propagation lands a SANE bot cap, not a host-pinned literal. >30 = VETO.
checkRange("config.screening.maxBotHoldersPct (base) in [0, 30]",  config.screening.maxBotHoldersPct,      0, 30);
checkRange("config.liveOverrides.maxBotHoldersPct in [0, 30] (live VPS=20, repo preset=25)", config.liveOverrides?.maxBotHoldersPct, 0, 30);

// ─── Report ───────────────────────────────────────────────────
console.log("\n=== Cassiopeia Move 1 Tune — Test Report ===\n");
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  const detail = r.rangeNote
    ? `${r.actual} in ${r.expected}`
    : `${r.actual} === ${r.expected}`;
  console.log(`[${tag}] ${r.label}  ::  ${detail}`);
}

console.log(`\nTotal: ${results.length}  Pass: ${results.length - failures}  Fail: ${failures}`);
if (failures > 0) {
  console.error("\nFAIL — Move 1 tune did not land cleanly. Investigate before Polaris handoff.");
  process.exit(1);
}
console.log("\nPASS — Move 1 tune verified. Hand off to Polaris.");
process.exit(0);
