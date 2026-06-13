/**
 * Cassiopeia — Broad Discovery (server→client gate migration) tests.  CROWN JEWEL.
 *
 * ROOT CAUSE (Sirius, verified live): we sent EVERY strict gate to the Pool-Discovery
 * server as filter_by params, so the server cut the 114k-pool universe down to ~3
 * BEFORE we ever saw a candidate. Bro: "cuma main 5 pool dari jutaan." page_size was
 * 50 (API ceiling 1000 = 20x headroom thrown away); pagination is broken so page_size
 * is the only breadth lever.
 *
 * FIX (NOT a loosening): send only a WIDE cheap server pre-filter + free server pre-sort,
 * pull up to 1000 pools, then run the IDENTICAL strict client gate. Deterministic
 * pre-rank + slice to `limit` keeps enrichment + judge cost FLAT.
 *
 * Asserts (Polaris/Bro acceptance list a–e + gate identity):
 *   (a) broad fetch is configured to pull >50 pools (page_size lever raised)
 *   (b) the broad SERVER filter is a strict SUPERSET — wider than the strict thresholds
 *       on EVERY shared bound (server can never drop a pool the client gate passes)
 *   (c) the strict CLIENT gate fires IDENTICALLY to the old server filter — bad pools
 *       (low mcap / low organic / low fee-TVL / few holders / dead vol) still rejected
 *   (d) pre-rank picks the top-N by scoreCandidate (cost boundary before enrichment)
 *   (e) good pools still PASS the client gate (quality preserved, not just breadth)
 *   + legacy-strict mode (broadDiscoveryEnabled=false) restores the full server filter
 *   + fail-closed (anti-pattern #2): missing data still rejects in the client gate
 *
 * Run: node scripts/test-broad-discovery.js
 */
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { config } = await import("../config.js");
const {
  buildDiscoveryFilters,
  getRawPoolScreeningRejectReason,
  scoreCandidate,
} = await import("../tools/screening.js");

console.log("=== Cassiopeia — Broad Discovery (CROWN JEWEL) tests ===\n");

// Strict thresholds mirroring the native screening config (the gate that MUST stay
// identical). These are the values the OLD server filter pushed server-side.
const STRICT = {
  excludeHighSupplyConcentration: true,
  minMcap: 150_000, maxMcap: 10_000_000,
  minHolders: 500,
  minVolume: 500,
  minTvl: 10_000, maxTvl: 150_000,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.06,
  minOrganic: 60, minQuoteOrganic: 0,
  minTokenAgeHours: null, maxTokenAgeHours: null,
  allowedLaunchpads: [], blockedLaunchpads: [],
  // broad-mode knobs (defaults mirror config.js)
  broadDiscoveryEnabled: true,
  broadDiscoveryPageSize: 1000,
  broadMcapFloor: 10_000,
  broadMcapCeil: 50_000_000,
  broadMinTvl: 1_000,
  broadSortBy: "fee_active_tvl_ratio:desc",
};

// ─────────────────────────────────────────────────────────────────────────────
// (a) Breadth: the page_size lever is raised well above 50.
// ─────────────────────────────────────────────────────────────────────────────
console.log("[a] broad fetch pulls >50 pools (page_size lever raised)");
{
  check(
    `config default broadDiscoveryPageSize (${config.screening.broadDiscoveryPageSize}) > 50`,
    Number(config.screening.broadDiscoveryPageSize) > 50,
  );
  check(
    `config default broadDiscoveryPageSize (${config.screening.broadDiscoveryPageSize}) <= 1000 (API ceiling)`,
    Number(config.screening.broadDiscoveryPageSize) <= 1000,
  );
  check("broadDiscoveryEnabled defaults ON", config.screening.broadDiscoveryEnabled === true);
  check(
    `broadSortBy is a free server pre-sort (${config.screening.broadSortBy})`,
    /(:desc|:asc)$/.test(String(config.screening.broadSortBy)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) The broad SERVER filter is a strict SUPERSET of the deployable set.
//     Every shared bound must be WIDER (looser-or-equal) than the strict threshold,
//     so the server can NEVER reject a pool the strict client gate would pass.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[b] broad server filter is WIDER than strict thresholds (superset, not loosening)");
{
  const broadFilter = buildDiscoveryFilters(STRICT);
  // Broad filter must NOT carry the strict quality gates (they moved to the client).
  check("broad filter does NOT push organic to server", !/organic_score/.test(broadFilter));
  check("broad filter does NOT push fee_active_tvl_ratio to server", !/fee_active_tvl_ratio/.test(broadFilter));
  check("broad filter does NOT push holders to server", !/base_token_holders/.test(broadFilter));
  check("broad filter does NOT push bin_step to server", !/dlmm_bin_step/.test(broadFilter));
  check("broad filter does NOT push volume to server", !/volume>/.test(broadFilter));
  check("broad filter does NOT push token age to server", !/created_at/.test(broadFilter));
  // Broad filter DOES keep cheap rug/sanity flags (client enforces these too).
  check("broad filter keeps pool_type=dlmm", /pool_type=dlmm/.test(broadFilter));
  check("broad filter keeps base critical-warning sanity", /base_token_has_critical_warnings=false/.test(broadFilter));
  check("broad filter keeps high-single-ownership sanity", /base_token_has_high_single_ownership=false/.test(broadFilter));
  // Broad mcap band must STRADDLE the strict band (floor <= minMcap, ceil >= maxMcap).
  const floorMatch = broadFilter.match(/base_token_market_cap>=(\d+)/);
  const ceilMatch = broadFilter.match(/base_token_market_cap<=(\d+)/);
  const tvlMatch = broadFilter.match(/tvl>=(\d+)/);
  check("broad mcap floor present", !!floorMatch);
  check("broad mcap ceil present", !!ceilMatch);
  check("broad tvl floor present", !!tvlMatch);
  check(
    `broad mcap floor (${floorMatch?.[1]}) <= strict minMcap (${STRICT.minMcap})`,
    Number(floorMatch?.[1]) <= STRICT.minMcap,
  );
  check(
    `broad mcap ceil (${ceilMatch?.[1]}) >= strict maxMcap (${STRICT.maxMcap})`,
    Number(ceilMatch?.[1]) >= STRICT.maxMcap,
  );
  check(
    `broad tvl floor (${tvlMatch?.[1]}) <= strict minTvl (${STRICT.minTvl})`,
    Number(tvlMatch?.[1]) <= STRICT.minTvl,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for the client-gate identity tests. A complete raw pool that PASSES every
// strict gate; per-test we degrade one field to prove the gate still fires.
// ─────────────────────────────────────────────────────────────────────────────
function goodRawPool(overrides = {}) {
  const { token_x: tokenXOverride, ...rest } = overrides;
  const baseTokenX = {
    symbol: "GOOD",
    address: "MintGOOD",
    organic_score: 85,
    market_cap: 800_000,
    created_at: Date.now() - 100 * 3_600_000,
    launchpad: null,
  };
  return {
    pool_address: "POOL_GOOD",
    name: "GOOD-SOL",
    pool_type: "dlmm",
    tvl: 60_000,
    volume: 25_000,
    fee_active_tvl_ratio: 0.12,
    volatility: 4,
    base_token_holders: 1200,
    dlmm_params: { bin_step: 100 },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 0 },
    base_mint: "MintGOOD",
    ...rest,
    // token_x merged LAST so per-test token_x overrides win over the base shape.
    token_x: { ...baseTokenX, ...(tokenXOverride || {}) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) The CLIENT gate fires IDENTICALLY — every bad-pool class still rejected.
//     These are the same checks the old server filter performed; they now run
//     client-side over the broad set. A pool that fails here is a pool the old
//     server filter would also have dropped.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[c] strict client gate rejects the same bad pools the server filter did");
{
  // low mcap (below floor 150k) — was base_token_market_cap>=150000 server-side
  check(
    "low mcap rejected client-side",
    /below minMcap/.test(getRawPoolScreeningRejectReason(goodRawPool({ token_x: { market_cap: 50_000 } }), STRICT) || ""),
  );
  // low organic (below floor 60) — was base_token_organic_score>=60 server-side
  check(
    "low organic rejected client-side",
    /below minOrganic/.test(getRawPoolScreeningRejectReason(goodRawPool({ token_x: { organic_score: 30 } }), STRICT) || ""),
  );
  // low fee/TVL (below 0.06) — was fee_active_tvl_ratio>=0.06 server-side
  check(
    "low fee/TVL rejected client-side",
    /below minFeeActiveTvlRatio/.test(getRawPoolScreeningRejectReason(goodRawPool({ fee_active_tvl_ratio: 0.01 }), STRICT) || ""),
  );
  // too few holders (below 500) — was base_token_holders>=500 server-side
  check(
    "low holders rejected client-side",
    /below minHolders/.test(getRawPoolScreeningRejectReason(goodRawPool({ base_token_holders: 120 }), STRICT) || ""),
  );
  // out-of-band bin step — was dlmm_bin_step<=125 server-side
  check(
    "out-of-band bin_step rejected client-side",
    /minBinStep|maxBinStep/.test(getRawPoolScreeningRejectReason(goodRawPool({ dlmm_params: { bin_step: 250 } }), STRICT) || ""),
  );
  // dead volatility (0) — vol gate (client-only, but part of the strict gate set)
  check(
    "dead volatility rejected client-side",
    /unusable|volatility_unknown/.test(getRawPoolScreeningRejectReason(goodRawPool({ volatility: 0 }), STRICT) || ""),
  );
  // mcap above ceil (above 10M) — was base_token_market_cap<=10000000 server-side
  check(
    "above-ceil mcap rejected client-side",
    /above maxMcap/.test(getRawPoolScreeningRejectReason(goodRawPool({ token_x: { market_cap: 20_000_000 } }), STRICT) || ""),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// fail-closed (anti-pattern #2): missing data still rejects, never defaults to safe.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[c2] fail-closed: missing data still rejects (anti-pattern #2)");
{
  check(
    "missing holders → holders_unknown",
    getRawPoolScreeningRejectReason(goodRawPool({ base_token_holders: null }), STRICT) === "holders_unknown",
  );
  check(
    "missing volatility → volatility_unknown",
    getRawPoolScreeningRejectReason(goodRawPool({ volatility: null }), STRICT) === "volatility_unknown",
  );
  check(
    "missing organic → organic_unknown",
    getRawPoolScreeningRejectReason(goodRawPool({ token_x: { organic_score: null } }), STRICT) === "organic_unknown",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) Good pools still PASS — quality preserved, the fix is breadth not leniency.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[e] a clean pool still PASSES the strict client gate (quality preserved)");
{
  check(
    "clean pool passes the strict gate (null reject reason)",
    getRawPoolScreeningRejectReason(goodRawPool(), STRICT) === null,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) Pre-rank: scoreCandidate orders pools so the cost slice picks the cream.
//     This is the cost boundary — only the top-N enter enrichment + judge.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[d] deterministic pre-rank picks the top-N by score (cost boundary)");
{
  // Three condensed-shape pools with different fee/TVL (the dominant score driver).
  const mk = (name, feeTvl, organic, volume) => ({
    pool: "P_" + name, name, fee_active_tvl_ratio: feeTvl, organic_score: organic,
    volume_window: volume, holders: 800, signal_sources: ["meteora"],
  });
  const cfg = config.screening;
  const pools = [
    mk("LOW", 0.07, 70, 5_000),
    mk("HIGH", 0.40, 90, 80_000),
    mk("MID", 0.18, 75, 20_000),
  ];
  const ranked = [...pools].sort((a, b) => scoreCandidate(b, cfg) - scoreCandidate(a, cfg));
  check("highest fee/TVL pool ranks #1", ranked[0].name === "HIGH");
  check("lowest fee/TVL pool ranks last", ranked[2].name === "LOW");
  // slice(0, limit) keeps only the cream — simulate limit=2 (judge cap is 5; this
  // just proves the slice picks top-by-score, the actual cost boundary).
  const top2 = ranked.slice(0, 2).map((p) => p.name);
  check("top-2 slice = the two highest-scored pools", top2.join(",") === "HIGH,MID");
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy-strict mode (reversibility): broadDiscoveryEnabled=false restores the full
// server filter — every strict gate pushed server-side again.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[rev] legacy-strict mode restores the full server filter (reversible)");
{
  const legacyFilter = buildDiscoveryFilters({ ...STRICT, broadDiscoveryEnabled: false });
  check("legacy filter pushes organic to server", /base_token_organic_score>=60/.test(legacyFilter));
  check("legacy filter pushes fee/TVL to server", /fee_active_tvl_ratio>=0.06/.test(legacyFilter));
  check("legacy filter pushes holders to server", /base_token_holders>=500/.test(legacyFilter));
  check("legacy filter pushes strict mcap floor to server", /base_token_market_cap>=150000/.test(legacyFilter));
  check("legacy filter pushes bin_step band to server", /dlmm_bin_step>=80/.test(legacyFilter) && /dlmm_bin_step<=125/.test(legacyFilter));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} ${passed} assertions${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
