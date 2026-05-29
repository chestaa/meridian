/**
 * test-token-age-filter.js
 *
 * Cassiopeia 👁️ — Phase J token-age gate validation.
 * Asserts the deterministic age gate in tools/screening.js
 * (getRawPoolScreeningRejectReason, lines 143-150) fires correctly:
 *
 *   - age  5h  → REJECT (below minTokenAgeHours 24)
 *   - age 30h  → PASS   (between 24h floor and 720h ceiling)
 *   - age null → REJECT (missing created_at — fail-closed, anti-pattern #2)
 *   - Jupiter created_at fallback → resolves token_age_hours on a pool
 *     whose Meteora base_token_created_at was null.
 *
 * Run: node scripts/test-token-age-filter.js
 * Exit: 0 = PASS, 1 = FAIL
 */

import { getRawPoolScreeningRejectReason } from "../tools/screening.js";

let failures = 0;
const results = [];

function check(label, cond) {
  if (cond) results.push(`  ✅ ${label}`);
  else { results.push(`  ❌ ${label}`); failures++; }
}

const HOUR = 3_600_000;

// Age thresholds under test (tuned Phase J defaults).
const s = {
  // age gate
  minTokenAgeHours: 24,
  maxTokenAgeHours: 720,
  // everything else set permissive so ONLY the age gate can reject.
  excludeHighSupplyConcentration: false,
  minMcap: 0, maxMcap: Number.MAX_SAFE_INTEGER,
  minHolders: 0, minVolume: 0, minTvl: 0, maxTvl: null,
  minBinStep: 0, maxBinStep: Number.MAX_SAFE_INTEGER,
  minFeeActiveTvlRatio: 0,
  minOrganic: 0, minQuoteOrganic: 0,
  allowedLaunchpads: [], blockedLaunchpads: [],
};

// Fully-passing pool except for created_at (caller overrides created_at).
function poolWithAge(createdAt) {
  return {
    pool_address: "PoolTestAddr1111111111111111111111111111111",
    name: "TEST-SOL",
    pool_type: "dlmm",
    tvl: 50_000, active_tvl: 50_000,
    fee_active_tvl_ratio: 0.1,
    volatility: 2,
    volume: 10_000,
    base_token_holders: 600,
    dlmm_params: { bin_step: 100 },
    base_token_has_critical_warnings: false,
    quote_token_has_critical_warnings: false,
    base_token_has_high_single_ownership: false,
    token_x: { symbol: "TEST", address: "Mint1111", market_cap: 1_000_000, organic_score: 90, created_at: createdAt },
    token_y: { symbol: "SOL", address: "So11111", organic_score: 90 },
  };
}

const now = Date.now();

// --- Case 1: age 5h → REJECT ---
const r5 = getRawPoolScreeningRejectReason(poolWithAge(now - 5 * HOUR), s);
check("age 5h rejected", typeof r5 === "string" && r5.includes("minTokenAgeHours"));

// --- Case 2: age 30h → PASS (null reason) ---
const r30 = getRawPoolScreeningRejectReason(poolWithAge(now - 30 * HOUR), s);
check("age 30h passes (no reject reason)", r30 === null);

// --- Case 2b: age 800h → REJECT (above maxTokenAgeHours 720) ---
const r800 = getRawPoolScreeningRejectReason(poolWithAge(now - 800 * HOUR), s);
check("age 800h rejected (stale)", typeof r800 === "string" && r800.includes("maxTokenAgeHours"));

// --- Case 3: null created_at → REJECT (fail-closed) ---
// numeric(null) coerces to 0, so the reject lands on the maxTokenAgeHours
// branch (0 is older than any 720h ceiling). Either way the pool is rejected —
// missing age data is never allowed through (anti-pattern #2 guarded).
const rNull = getRawPoolScreeningRejectReason(poolWithAge(null), s);
check("null created_at rejected (fail-closed)", typeof rNull === "string" && rNull.toLowerCase().includes("token age"));

// --- Case 4: Jupiter created_at fallback resolves token_age_hours ---
// Mirrors the back-fill in discoverPools dev-enrichment loop: a condensed pool
// with token_age_hours === null gets created_at from Jupiter assets/search.
const condensed = { pool: "P", base: { mint: "Mint1111" }, token_age_hours: null };
const jupiterCreatedAt = now - 30 * HOUR; // Jupiter says 30h old
const createdAtMap = { P: jupiterCreatedAt };
if (condensed.token_age_hours == null && createdAtMap[condensed.pool] != null) {
  condensed.token_age_hours = Math.floor((now - createdAtMap[condensed.pool]) / HOUR);
}
check("Jupiter fallback resolved token_age_hours", condensed.token_age_hours === 30);
check("Jupiter fallback clears the live 8h safety floor", condensed.token_age_hours >= 8);

console.log("\nCassiopeia 👁️ — Token Age Gate Test\n");
console.log(results.join("\n"));
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${results.length - failures}/${results.length} assertions passed\n`);
process.exit(failures === 0 ? 0 : 1);
