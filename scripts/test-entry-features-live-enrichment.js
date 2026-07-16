/**
 * Vega P0 regression — entry_features LIVE-PATH enrichment (2026-07-17).
 *
 * ROOT CAUSE of the 115/115 empty entry_features (Lyra forensic 2026-07-15): the
 * LIVE deploy path is agent.js → executeTool → deployPosition. The LLM's
 * deploy_position tool call carries ONLY schema params — it cannot forward
 * sol_regime_24h_pct / token_price_change / buy_vol / sell_vol / mcap, so
 * dlmm.buildEntryFeatures always got all-null → persisted EMPTY features. The
 * Jul-14 efNumeric fix hardened only the DETERMINISTIC vega.js path (flag OFF in
 * live), so it never touched this gap → "the fix never landed."
 *
 * enrichDeployEntryFeatures deterministically re-attaches the REAL scalars (computed
 * this cycle by screening) to the deploy args BEFORE dlmm.buildEntryFeatures, with
 * NO new API call. This test drives that function directly + asserts the end-to-end
 * chain (enriched args → real buildEntryFeatures output) and the fail-safe contract.
 *
 * Run: node scripts/test-entry-features-live-enrichment.js
 */

import assert from "node:assert";

import {
  enrichDeployEntryFeatures,
  __setDetectMarketRegimeForExecutorTests,
  __setPeekDiscoveryDetailForTests,
  __resetPeekDiscoveryDetailForTests,
} from "../tools/executor.js";
import {
  peekCandidateEntryScalars,
  __primeCandidateEntryScalarsForTests,
} from "../tools/screening.js";
import { buildEntryFeatures as dlmmBuildEntryFeatures } from "../tools/dlmm.js";

let passed = 0;
async function check(desc, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${desc}`);
}

// Default seams: no peek detail, regime read fails (forces isolation per test).
__setPeekDiscoveryDetailForTests(() => null);
__setDetectMarketRegimeForExecutorTests(async () => { throw new Error("no regime in test"); });

const POOL = "PooLaddrEnrichTest1111111111111111111111111";

// ─── 1. Candidate-scalars cache is the authoritative source (complete set) ────
console.log("\n1. candidate cache → complete scalar set attached to args:");

await check("cached scalars (incl OKX flow) attached; no clobber of amount/bins", async () => {
  __primeCandidateEntryScalarsForTests(POOL, {
    sol_regime_24h_pct: -3.48,
    token_price_change_1h: 1.2,
    token_price_change_24h: null, // honest null from condensed candidate
    buy_vol: 8000,
    sell_vol: 2000,
    mcap: 450000,
  });
  const args = { pool_address: POOL, amount_y: 0.1, bins_below: 40 };
  await enrichDeployEntryFeatures(args);
  assert.strictEqual(args.sol_regime_24h_pct, -3.48);
  assert.strictEqual(args.token_price_change_1h, 1.2);
  assert.strictEqual(args.buy_vol, 8000);
  assert.strictEqual(args.sell_vol, 2000);
  assert.strictEqual(args.mcap, 450000);
  // deploy-critical args untouched
  assert.strictEqual(args.amount_y, 0.1);
  assert.strictEqual(args.bins_below, 40);
});

await check("end-to-end: enriched args → dlmm.buildEntryFeatures computes REAL flow", () => {
  // Simulate what dlmm.deployPosition does with the now-enriched args.
  const ef = dlmmBuildEntryFeatures({
    sol_regime_24h_pct: -3.48,
    token_price_change_1h: 1.2,
    token_price_change_24h: null,
    buy_vol: 8000,
    sell_vol: 2000,
    mcap: 450000,
  });
  assert.strictEqual(ef.sol_regime_24h_pct, -3.48);
  assert.strictEqual(ef.token_price_change_1h, 1.2);
  assert.strictEqual(ef.token_price_change_24h, null); // honest gap preserved
  assert.strictEqual(ef.buy_sell_flow_ratio, 0.8);     // 8000/10000 REAL, not fabricated
  assert.strictEqual(ef.mcap, 450000);
});

await check("peekCandidateEntryScalars returns a copy (mutation isolation)", () => {
  const a = peekCandidateEntryScalars(POOL);
  a.mcap = 999;
  const b = peekCandidateEntryScalars(POOL);
  assert.strictEqual(b.mcap, 450000);
});

// ─── 2. Fallback — raw peek detail + regime (no OKX flow available) ──────────
console.log("\n2. cache miss → fallback to raw peek detail + market regime:");

await check("fallback fills price_change + mcap from detail, sol_regime from regime", async () => {
  __setPeekDiscoveryDetailForTests(() => ({
    pool_price_change_pct: 2.5,
    token_x: { market_cap: 300000 },
  }));
  __setDetectMarketRegimeForExecutorTests(async () => ({ sol24hChangePct: -6.1 }));
  const args = { pool_address: "UNCACHED_POOL_addr_2222222222222222222222" };
  await enrichDeployEntryFeatures(args);
  assert.strictEqual(args.token_price_change_1h, 2.5);
  assert.strictEqual(args.mcap, 300000);
  assert.strictEqual(args.sol_regime_24h_pct, -6.1);
  // OKX flow is enrichment-only, absent from raw detail → honest null (never fabricated)
  assert.strictEqual(args.buy_vol, undefined);
  assert.strictEqual(args.sell_vol, undefined);
});

await check("fallback: buildEntryFeatures leaves flow null when no buy/sell vol", () => {
  const ef = dlmmBuildEntryFeatures({
    sol_regime_24h_pct: -6.1,
    token_price_change_1h: 2.5,
    mcap: 300000,
  });
  assert.strictEqual(ef.buy_sell_flow_ratio, null); // never fabricated to 0 or 1
  assert.strictEqual(ef.sol_regime_24h_pct, -6.1);
});

// ─── 3. No-clobber: deterministic vega path already populated the scalars ────
console.log("\n3. deterministic path (scalars pre-set) → NOT overwritten:");

await check("any pre-set scalar → enrichment skips entirely (no clobber)", async () => {
  __primeCandidateEntryScalarsForTests(POOL, { mcap: 111111 });
  const args = { pool_address: POOL, sol_regime_24h_pct: 5.0 }; // vega already set this
  await enrichDeployEntryFeatures(args);
  assert.strictEqual(args.sol_regime_24h_pct, 5.0);
  assert.strictEqual(args.mcap, undefined); // NOT pulled from cache — path pre-owned
});

// ─── 4. Fail-safe (anti-pattern #2): never fabricate, never throw, never block ─
console.log("\n4. fail-safe contract:");

await check("no cache + no detail + regime throws → args untouched, NO throw", async () => {
  __setPeekDiscoveryDetailForTests(() => null);
  __setDetectMarketRegimeForExecutorTests(async () => { throw new Error("regime down"); });
  const args = { pool_address: "NOSOURCE_pool_addr_333333333333333333333" };
  await enrichDeployEntryFeatures(args); // must not throw
  assert.strictEqual(args.sol_regime_24h_pct, undefined);
  assert.strictEqual(args.mcap, undefined);
  assert.strictEqual(args.buy_vol, undefined);
});

await check("missing pool_address → no-op, no throw", async () => {
  const args = { amount_y: 0.1 };
  await enrichDeployEntryFeatures(args);
  assert.deepStrictEqual(args, { amount_y: 0.1 });
});

await check("null/undefined args → no throw", async () => {
  await enrichDeployEntryFeatures(null);
  await enrichDeployEntryFeatures(undefined);
});

await check("peek impl throwing is swallowed (telemetry never escalates)", async () => {
  __setPeekDiscoveryDetailForTests(() => { throw new Error("peek boom"); });
  __setDetectMarketRegimeForExecutorTests(async () => ({ sol24hChangePct: -1.0 }));
  const args = { pool_address: "THROWY_pool_addr_44444444444444444444444" };
  await enrichDeployEntryFeatures(args); // must not throw
  // regime still applied after the swallowed peek error
  assert.strictEqual(args.sol_regime_24h_pct, -1.0);
});

await check("cache with ALL-null scalars → treated as miss, no fabricated values", async () => {
  __setPeekDiscoveryDetailForTests(() => null);
  __setDetectMarketRegimeForExecutorTests(async () => { throw new Error("no regime"); });
  const ALLNULL = "ALLNULL_pool_addr_5555555555555555555555";
  __primeCandidateEntryScalarsForTests(ALLNULL, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_vol: null,
    sell_vol: null,
    mcap: null,
  });
  const args = { pool_address: ALLNULL };
  await enrichDeployEntryFeatures(args);
  // no non-null cached value → nothing copied; fallback also empty → all absent
  for (const k of ["sol_regime_24h_pct", "token_price_change_1h", "buy_vol", "sell_vol", "mcap"]) {
    assert.strictEqual(args[k], undefined, `${k} must stay absent (never fabricated)`);
  }
});

await check("expired cache entry → miss (TTL honored), falls through to fallback", async () => {
  __setPeekDiscoveryDetailForTests(() => null);
  __setDetectMarketRegimeForExecutorTests(async () => { throw new Error("no regime"); });
  const STALE = "STALE_pool_addr_666666666666666666666666";
  // Back-date well beyond any sane TTL (24h).
  __primeCandidateEntryScalarsForTests(STALE, { mcap: 777777 }, 24 * 60 * 60 * 1000);
  assert.strictEqual(peekCandidateEntryScalars(STALE), null);
  const args = { pool_address: STALE };
  await enrichDeployEntryFeatures(args);
  assert.strictEqual(args.mcap, undefined);
});

__resetPeekDiscoveryDetailForTests();
__setDetectMarketRegimeForExecutorTests(null);

console.log(`\n${passed} assertions passed.`);
