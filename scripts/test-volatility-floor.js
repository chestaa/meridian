// Cassiopeia 👁️ — volatility FLOOR gate tests (Lyra 39-trade finding).
//
// Verifies minVolatility floor in getRawPoolScreeningRejectReason:
//   - vol >= floor  -> pass (no vol reject)
//   - vol <  floor  -> reject "volatility ... below minVolatility ..."
//   - vol null/0/non-finite -> reject fail-closed (volatility_unknown / unusable)
//   - floor = 0 (off) -> NO vol-floor reject (only the fail-closed checks apply)
//   - NO ceiling: arbitrarily high vol passes
//
// Run: node scripts/test-volatility-floor.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { getRawPoolScreeningRejectReason } = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";

// Thresholds matching a typical live gate, with floor configurable per-test.
function thresholds(minVolatility) {
  return {
    minMcap: 150_000, maxMcap: 10_000_000,
    minHolders: 500, minVolume: 500,
    minTvl: 10_000, maxTvl: 150_000,
    minBinStep: 80, maxBinStep: 200,
    minFeeActiveTvlRatio: 0.13,
    minOrganic: 60, minQuoteOrganic: 0,
    minTokenAgeHours: 12, maxTokenAgeHours: 720,
    blockedLaunchpads: [], allowedLaunchpads: [],
    minVolatility,
  };
}

// A pool that clears EVERY gate except whatever we vary. created_at ~3 days ago
// (inside 12-720h age band). Quote = wSOL (blue-chip, quote-organic exempt).
function passingPool(volatility) {
  return {
    name: "GOOD-SOL",
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100 },
    tvl: 50_000,
    fee_active_tvl_ratio: 0.20,
    volume: 30_000,
    volatility,
    base_token_holders: 1200,
    token_x: {
      market_cap: 800_000,
      organic_score: 75,
      created_at: Math.floor((Date.now() - 72 * 3_600_000) / 1000) * 1000,
    },
    quote: { mint: WSOL },
    token_y: { address: WSOL },
  };
}

console.log("=== Cassiopeia — volatility FLOOR gate tests ===\n");

// Sanity: the fixture passes the full gate with floor off.
console.log("[0] fixture clears full raw gate (floor off)");
{
  const r = getRawPoolScreeningRejectReason(passingPool(4.0), thresholds(0));
  check("vol=4.0, floor=0 -> no reject (fixture is gate-clean)", r === null);
}

// ── Floor = 3.5 (Lyra's proposal) ──
console.log("\n[1] floor = 3.5");
{
  const s = thresholds(3.5);
  check("vol=4.0 -> PASS (above floor)", getRawPoolScreeningRejectReason(passingPool(4.0), s) === null);
  check("vol=3.5 -> PASS (exactly at floor, inclusive)", getRawPoolScreeningRejectReason(passingPool(3.5), s) === null);
  const r2 = getRawPoolScreeningRejectReason(passingPool(2.0), s);
  check("vol=2.0 -> REJECT (below floor)", typeof r2 === "string" && r2.includes("below minVolatility"));
  const r34 = getRawPoolScreeningRejectReason(passingPool(3.49), s);
  check("vol=3.49 -> REJECT (just below floor)", typeof r34 === "string" && r34.includes("below minVolatility"));
}

// ── Floor = 3.0 (Cassiopeia's chosen value, anti-dormancy) ──
console.log("\n[2] floor = 3.0 (applied value)");
{
  const s = thresholds(3.0);
  check("vol=3.0 -> PASS (at floor)", getRawPoolScreeningRejectReason(passingPool(3.0), s) === null);
  check("vol=3.2 -> PASS", getRawPoolScreeningRejectReason(passingPool(3.2), s) === null);
  const r = getRawPoolScreeningRejectReason(passingPool(2.49), s);
  check("vol=2.49 -> REJECT (kills worst [0,2.5) bucket)", typeof r === "string" && r.includes("below minVolatility"));
}

// ── NO CEILING (Lyra: 4.5+ still EV-positive) ──
console.log("\n[3] no ceiling — high vol always passes");
{
  const s = thresholds(3.0);
  check("vol=14.8 (universe max) -> PASS (no ceiling)", getRawPoolScreeningRejectReason(passingPool(14.8), s) === null);
  check("vol=100 -> PASS (no upper bound)", getRawPoolScreeningRejectReason(passingPool(100), s) === null);
}

// ── Fail-closed (anti-pattern #2): missing/0/non-finite vol rejects BEFORE floor ──
console.log("\n[4] fail-closed missing/zero/non-finite vol");
{
  const s = thresholds(3.0);
  const rNull = getRawPoolScreeningRejectReason(passingPool(null), s);
  check("vol=null -> volatility_unknown (fail-closed, not defaulted)", rNull === "volatility_unknown");
  const rUndef = getRawPoolScreeningRejectReason(passingPool(undefined), s);
  check("vol=undefined -> volatility_unknown", rUndef === "volatility_unknown");
  const rZero = getRawPoolScreeningRejectReason(passingPool(0), s);
  check("vol=0 -> unusable (genuine dead reading, distinct from unknown)", typeof rZero === "string" && rZero.includes("unusable"));
  const rNeg = getRawPoolScreeningRejectReason(passingPool(-1), s);
  check("vol=-1 -> unusable", typeof rNeg === "string" && rNeg.includes("unusable"));
  const rNaN = getRawPoolScreeningRejectReason(passingPool(NaN), s);
  // NaN -> strictNumeric returns null -> volatility_unknown
  check("vol=NaN -> volatility_unknown (non-finite)", rNaN === "volatility_unknown");
}

// ── Floor = 0 (off, base default) ── only fail-closed applies, no floor reject
console.log("\n[5] floor = 0 (off) — no vol-floor reject, fail-closed still applies");
{
  const s = thresholds(0);
  check("vol=0.5, floor=0 -> PASS (floor disabled)", getRawPoolScreeningRejectReason(passingPool(0.5), s) === null);
  check("vol=1.0, floor=0 -> PASS", getRawPoolScreeningRejectReason(passingPool(1.0), s) === null);
  check("vol=0, floor=0 -> still unusable (fail-closed independent of floor)",
    (getRawPoolScreeningRejectReason(passingPool(0), s) || "").includes("unusable"));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
assert.equal(failed, 0, `${failed} volatility-floor assertion(s) failed`);
