/**
 * Vega 2026-07-07 — pre-deploy 429-dedup (discovery-detail peek) tests.
 *
 * Money-path: validateDeployPoolThresholds() used to UNCONDITIONALLY call
 * fetchFreshPoolDetail(pool_address) — re-fetching a pool discovery had pulled
 * seconds earlier → Meteora Pool-Discovery 429 → snapshot_verify_failed on GOOD
 * candidates. Fix = prefer Cassiopeia's peekDiscoveryDetailByAddress (already-in-
 * hand live discovery detail) BEFORE the fetch. Reuse removes ONLY the redundant
 * network fetch on a cache-hit; ALL threshold checks still run on the reused detail.
 *
 * Asserts:
 *   (a) cache-HIT (peek non-null) → NO fetch, validation still runs → PASS
 *   (b) cache-HIT that FAILS a threshold → validation still REJECTS (not skipped)
 *   (c) cache-MISS (peek null) → falls through to fetch → PASS
 *   (d) cache-MISS + fetch 429-exhausts, no snapshot → fail-close (preserved)
 *   (e) vol-timeframe peek reused too (secondary read de-duped)
 */
import {
  __setSnapshotFetchForTests,
  __resetSnapshotFetchForTests,
  __setPeekDiscoveryDetailForTests,
  __resetPeekDiscoveryDetailForTests,
  __validateDeployPoolThresholdsForTests,
} from "../tools/executor.js";
import { config } from "../config.js";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const POOL = "PoolAddr11111111111111111111111111111111111";

// A discovery detail that PASSES all memecoin thresholds. bin_step within
// [minBinStep,maxBinStep] would be checked further down but validateDeploy only
// runs the TVL/fee-TVL/volatility gates in this function slice; we feed a healthy
// row so the reused-detail path returns pass:true.
function healthyDetail() {
  return {
    pool_address: POOL,
    tvl: 50000,
    liquidity: 50000,
    fee_active_tvl_ratio: 0.15,
    fee_tvl_ratio: 0.15,
    volatility: 5,
    bin_step: 100,
  };
}
function okResponse(detail) {
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: detail ? [detail] : [] }) };
}
function errResponse(status, statusText = "") { return { ok: false, status, statusText }; }

console.log("=== Vega pre-deploy 429-dedup (discovery peek) tests ===\n");

// ── (a) cache-HIT → NO fetch, validation still runs → PASS ────────────────
console.log("[a] peek cache-HIT → NO network fetch, thresholds still run → PASS");
{
  let fetchCalls = 0;
  __setSnapshotFetchForTests(async () => { fetchCalls += 1; return okResponse(healthyDetail()); }, [0, 0, 0]);
  __setPeekDiscoveryDetailForTests(() => healthyDetail());

  const res = await __validateDeployPoolThresholdsForTests({ pool_address: POOL, fee_tvl_ratio: 0.15 });
  assert(res.pass === true, `deploy verify PASSED on reused detail (reason=${res.reason || "n/a"})`);
  assert(fetchCalls === 0, `NO redundant fetch fired on cache-hit (fetchCalls=${fetchCalls}) — 429 avoided`);

  __resetPeekDiscoveryDetailForTests();
  __resetSnapshotFetchForTests();
}

// ── (b) cache-HIT that fails a threshold → validation STILL rejects ───────
console.log("\n[b] peek cache-HIT with breaching detail → thresholds STILL run → REJECT (not skipped)");
{
  let fetchCalls = 0;
  __setSnapshotFetchForTests(async () => { fetchCalls += 1; return okResponse(healthyDetail()); }, [0, 0, 0]);
  // TVL far above maxTvl → the maxTvl memecoin ceiling must reject on the reused row.
  const maxTvl = Number(config.screening.maxTvl) || 150000;
  __setPeekDiscoveryDetailForTests(() => ({ ...healthyDetail(), tvl: maxTvl * 100, liquidity: maxTvl * 100 }));

  const res = await __validateDeployPoolThresholdsForTests({ pool_address: POOL, fee_tvl_ratio: 0.15 });
  assert(res.pass === false, "reused detail STILL runs thresholds → over-maxTvl rejected (validation NOT bypassed)");
  assert(fetchCalls === 0, `still no fetch (peek used) yet gate enforced (fetchCalls=${fetchCalls})`);

  __resetPeekDiscoveryDetailForTests();
  __resetSnapshotFetchForTests();
}

// ── (c) cache-MISS → falls through to fetch → PASS ────────────────────────
console.log("\n[c] peek cache-MISS (null) → falls through to fetchFreshPoolDetail → PASS");
{
  let fetchCalls = 0;
  __setSnapshotFetchForTests(async () => { fetchCalls += 1; return okResponse(healthyDetail()); }, [0, 0, 0]);
  __setPeekDiscoveryDetailForTests(() => null); // simulate cache miss / stale / TTL-0

  const res = await __validateDeployPoolThresholdsForTests({ pool_address: POOL, fee_tvl_ratio: 0.15 });
  assert(res.pass === true, `fetch path verified detail → PASS (reason=${res.reason || "n/a"})`);
  assert(fetchCalls >= 1, `fetch WAS used on cache-miss (fetchCalls=${fetchCalls}) — fallback intact`);

  __resetPeekDiscoveryDetailForTests();
  __resetSnapshotFetchForTests();
}

// ── (d) cache-MISS + fetch 429-exhausts + no snapshot → FAIL-CLOSE ────────
console.log("\n[d] peek MISS + fetch 429-exhausts + no reusable snapshot → fail-close (anti-pattern #2 preserved)");
{
  __setSnapshotFetchForTests(async () => errResponse(429, "Too Many Requests"), [0, 0, 0, 0, 0]);
  __setPeekDiscoveryDetailForTests(() => null);

  const res = await __validateDeployPoolThresholdsForTests({ pool_address: POOL /* no candidate_snapshot */ });
  assert(res.pass === false, "fail-closed when peek miss AND fetch exhausts AND no snapshot");
  assert(String(res.reason).includes("snapshot_verify_failed"), `snapshot_verify_failed preserved (${res.reason})`);

  __resetPeekDiscoveryDetailForTests();
  __resetSnapshotFetchForTests();
}

// ── (e) vol-timeframe peek reused too (secondary read de-duped) ───────────
console.log("\n[e] vol-timeframe secondary read also served from peek (no extra fetch)");
{
  // Force deploy timeframe != vol timeframe so the secondary vol read path runs.
  const origTf = config.screening.timeframe;
  config.screening.timeframe = "5m"; // getVolatilityTimeframe("5m") differs → secondary read fires

  let fetchCalls = 0;
  __setSnapshotFetchForTests(async () => { fetchCalls += 1; return okResponse(healthyDetail()); }, [0, 0, 0]);
  // Peek returns a healthy detail for BOTH primary and vol-timeframe calls.
  __setPeekDiscoveryDetailForTests(() => healthyDetail());

  const res = await __validateDeployPoolThresholdsForTests({ pool_address: POOL, fee_tvl_ratio: 0.15 });
  assert(res.pass === true, `vol read served from peek → PASS (reason=${res.reason || "n/a"})`);
  assert(fetchCalls === 0, `neither primary NOR vol-timeframe fetched (fetchCalls=${fetchCalls}) — both de-duped`);

  config.screening.timeframe = origTf;
  __resetPeekDiscoveryDetailForTests();
  __resetSnapshotFetchForTests();
}

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
