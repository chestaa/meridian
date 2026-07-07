/**
 * Cassiopeia — by-address discovery-cache reuse primitive tests.
 *
 * Covers `peekDiscoveryDetailByAddress` (screening.js): the read-only seam that
 * lets Vega's pre-deploy snapshot-verify reuse the pool data discovery already
 * fetched this cycle instead of re-hitting the Pool-Discovery endpoint (the 429
 * source, Draco 2026-07-07). The MOST IMPORTANT assertions here are the
 * FAIL-CLOSED ones: every miss/stale/empty path MUST return null so the caller
 * falls through to its own fetch + existing fail-closed guard (anti-pattern #2).
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
  peekDiscoveryDetailByAddress,
  clearDiscoveryCache,
  __primeDiscoveryCachesForTests,
} = await import("../tools/screening.js");

// Ensure caches are ON with generous TTLs for the positive cases.
config.screening.broadDiscoveryCacheTtlMin = 7;       // page cache 7 min
config.screening.broadDiscoveryDetailCacheTtlMin = 5; // detail cache 5 min
const TF = config.screening.timeframe || "5m";

console.log("=== Cassiopeia — discovery-cache by-address reuse tests ===\n");

const ADDR = "PoolAddr1111111111111111111111111111111111";
const OTHER = "PoolAddrZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const detailObj = { pool_address: ADDR, tvl: 42000, fee_active_tvl_ratio: 0.15, volatility: 4.1 };
const pagePool = { pool_address: ADDR, tvl: 42000, fee_active_tvl_ratio: 0.15, volatility: 4.1 };

// ── FAIL-CLOSED: empty caches ────────────────────────────────────────────────
console.log("[a] empty caches → null (fail-closed: caller must fetch)");
{
  clearDiscoveryCache();
  check("no address → null", peekDiscoveryDetailByAddress(null) === null);
  check("empty cache → null", peekDiscoveryDetailByAddress(ADDR) === null);
}

// ── Positive: per-pool detail cache hit ──────────────────────────────────────
console.log("\n[b] fresh per-pool detail cache → deep-cloned hit");
{
  clearDiscoveryCache();
  __primeDiscoveryCachesForTests({ detailKey: `${ADDR}|${TF}`, detail: detailObj, ageMs: 1000 });
  const got = peekDiscoveryDetailByAddress(ADDR, TF);
  check("returns the cached detail", got != null && got.pool_address === ADDR);
  check("tvl preserved", got?.tvl === 42000);
  check("deep clone (not same ref)", got !== detailObj);
}

// ── Positive: broad page cache scan by address ───────────────────────────────
console.log("\n[c] fresh broad page cache → scan finds pool by pool_address");
{
  clearDiscoveryCache();
  __primeDiscoveryCachesForTests({
    pageKey: "somekey",
    pageData: { data: [{ pool_address: OTHER }, pagePool] },
    ageMs: 1000,
  });
  const got = peekDiscoveryDetailByAddress(ADDR, TF);
  check("found in page scan", got != null && got.pool_address === ADDR);
  check("deep clone from page", got !== pagePool);
  check("unknown address in fresh page → null", peekDiscoveryDetailByAddress("nope") === null);
}

// ── FAIL-CLOSED: staleness ───────────────────────────────────────────────────
console.log("\n[d] stale entries → null (never reuse >TTL data)");
{
  clearDiscoveryCache();
  // detail TTL 5 min → back-date 6 min
  __primeDiscoveryCachesForTests({ detailKey: `${ADDR}|${TF}`, detail: detailObj, ageMs: 6 * 60 * 1000 });
  check("stale detail → null", peekDiscoveryDetailByAddress(ADDR, TF) === null);

  clearDiscoveryCache();
  // page TTL 7 min → back-date 8 min
  __primeDiscoveryCachesForTests({ pageKey: "k", pageData: { data: [pagePool] }, ageMs: 8 * 60 * 1000 });
  check("stale page → null", peekDiscoveryDetailByAddress(ADDR, TF) === null);
}

// ── FAIL-CLOSED: cache disabled (TTL 0) ──────────────────────────────────────
console.log("\n[e] cache disabled (TTL 0) → null even with a primed entry");
{
  clearDiscoveryCache();
  __primeDiscoveryCachesForTests({ detailKey: `${ADDR}|${TF}`, detail: detailObj, ageMs: 0 });
  __primeDiscoveryCachesForTests({ pageKey: "k", pageData: { data: [pagePool] }, ageMs: 0 });
  config.screening.broadDiscoveryCacheTtlMin = 0;
  config.screening.broadDiscoveryDetailCacheTtlMin = 0;
  check("TTL 0 → null (fail-closed, caller fetches)", peekDiscoveryDetailByAddress(ADDR, TF) === null);
  // restore
  config.screening.broadDiscoveryCacheTtlMin = 7;
  config.screening.broadDiscoveryDetailCacheTtlMin = 5;
}

// ── FAIL-CLOSED: malformed page ──────────────────────────────────────────────
console.log("\n[f] malformed page data → null (no throw, fail-closed)");
{
  clearDiscoveryCache();
  __primeDiscoveryCachesForTests({ pageKey: "k", pageData: { data: null }, ageMs: 1000 });
  check("page with null data array → null", peekDiscoveryDetailByAddress(ADDR, TF) === null);
  clearDiscoveryCache();
  __primeDiscoveryCachesForTests({ pageKey: "k", pageData: {}, ageMs: 1000 });
  check("page with no data field → null", peekDiscoveryDetailByAddress(ADDR, TF) === null);
}

clearDiscoveryCache();
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
