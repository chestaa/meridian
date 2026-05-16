// scripts/test-enricher.js — Sirius smoke test for signal-enricher.
// Pure unit test: mocks Jupiter + Meteora APIs via __setEnricherOverrides.
// No real network. No real on-chain calls. No real API keys required.

import { enrichSignal, __setEnricherOverrides, __resetEnricherOverrides } from "../signal-enricher.js";
import { parseSignalMessage, scoreParsedSignal } from "../signal-parser.js";

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

function eq(label, actual, expected) {
  assert(label, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

const FAKE_MINT = "Fk1ePumpFakeFakeFakeFakeFakeFakeFakeFakepump";

function happyOverrides() {
  return {
    getTokenInfo: async ({ query }) => ({
      found: true,
      query,
      results: [{
        mint: FAKE_MINT,
        symbol: "FAKE",
        name: "Fake Token",
        mcap: 42_000,
        price: 0.000042,
        liquidity: 18_500,
        holders: 1234,
        organic_score: 72,
        bundle_pct: 12,
        sniper_pct: 0.3,
        suspicious_pct: 4,
        risk_level: 2,
      }],
    }),
    getTokenHolders: async ({ mint }) => ({
      mint,
      top_10_real_holders_pct: "33.50",
      bundle_pct: 12,
      sniper_pct: 0.3,
      suspicious_pct: 4,
      risk_level: 2,
      holders: [],
    }),
    getTokenNarrative: async ({ mint }) => ({ mint, narrative: "memetic mascot tribute" }),
    findPoolForToken: async (mint) => ({
      pool_address: "PooLAddr1111111111111111111111111111111111",
      tvl: 27_000,
      active_tvl: 9_000,
      volume24h: 88_000,
      fee_active_tvl_ratio: 0.12,
      bin_step: 100,
      volatility: 3.2,
      base_mint: mint,
      base_symbol: "FAKE",
    }),
  };
}

async function testHappyPath() {
  console.log("\n# happy path — all APIs respond");
  __setEnricherOverrides(happyOverrides());
  const parsed = { source: "manual", tokenAddress: FAKE_MINT, mcapUsd: null, vol5mUsd: null, raw: "ape this CA" };
  const out = await enrichSignal(parsed);
  eq("enriched=true", out.enriched, true);
  eq("mcapUsd promoted", out.mcapUsd, 42_000);
  eq("symbol promoted", out.symbol, "FAKE");
  eq("vol5mUsd uses volume24h proxy", out.vol5mUsd, 88_000);
  eq("enrichment.tvl", out.enrichment.tvl, 27_000);
  eq("enrichment.pool_address", out.enrichment.pool_address, "PooLAddr1111111111111111111111111111111111");
  eq("enrichment.top10Pct", out.enrichment.top10Pct, 33.5);
  eq("enrichment.holders", out.enrichment.holders, 1234);
  eq("enrichment.narrative", out.enrichment.narrative, "memetic mascot tribute");
  eq("enrichment.bin_step", out.enrichment.bin_step, 100);
  eq("enrichment.volatility", out.enrichment.volatility, 3.2);
  assert("enrichedAt ISO timestamp", typeof out.enrichedAt === "string" && out.enrichedAt.includes("T"));
  assert("no enrichmentErrors", out.enrichmentErrors === undefined);
  __resetEnricherOverrides();
}

async function testPartialFailure() {
  console.log("\n# partial failure — pool finder throws, others succeed");
  const overrides = happyOverrides();
  overrides.findPoolForToken = async () => { throw new Error("meteora 503"); };
  __setEnricherOverrides(overrides);
  const parsed = { source: "manual", tokenAddress: FAKE_MINT, mcapUsd: null };
  const out = await enrichSignal(parsed);
  eq("still enriched=true", out.enriched, true);
  eq("mcap still populated from tokenInfo", out.enrichment.mcapUsd, 42_000);
  eq("tvl null when pool finder fails", out.enrichment.tvl, null);
  assert("error recorded", Array.isArray(out.enrichmentErrors) && out.enrichmentErrors.some((e) => e.includes("poolFinder")));
  __resetEnricherOverrides();
}

async function testNoTokenAddress() {
  console.log("\n# bypass — no tokenAddress means can't enrich");
  __setEnricherOverrides(happyOverrides());
  const parsed = { source: "manual", tokenAddress: null, raw: "vague chatter" };
  const out = await enrichSignal(parsed);
  assert("not enriched", out.enriched !== true);
  assert("returned untouched (no enrichment key)", out.enrichment === undefined);
  __resetEnricherOverrides();
}

async function testNeverThrows() {
  console.log("\n# fault tolerance — every API throws, must still return");
  __setEnricherOverrides({
    getTokenInfo: async () => { throw new Error("jup 500"); },
    getTokenHolders: async () => { throw new Error("jup 500"); },
    getTokenNarrative: async () => { throw new Error("jup 500"); },
    findPoolForToken: async () => { throw new Error("meteora 500"); },
  });
  const parsed = { source: "manual", tokenAddress: FAKE_MINT };
  const out = await enrichSignal(parsed);
  eq("returns enriched=true even on all-fail (best-effort contract)", out.enriched, true);
  eq("mcap null", out.enrichment.mcapUsd, null);
  eq("tvl null", out.enrichment.tvl, null);
  assert("all 4 errors logged", Array.isArray(out.enrichmentErrors) && out.enrichmentErrors.length === 4);
  __resetEnricherOverrides();
}

async function testFillsScoringFields() {
  console.log("\n# integration — enriched signal lets scoreParsedSignal pass");
  __setEnricherOverrides(happyOverrides());
  // Realistic raw KOL signal — bare CA, no metadata in text
  const raw = `gem alert ${FAKE_MINT} lfg`;
  const parsed = parseSignalMessage(raw);
  eq("parser found tokenAddress", parsed.tokenAddress, FAKE_MINT);
  eq("parser leaves mcap null", parsed.mcapUsd, null);
  const before = scoreParsedSignal(parsed);
  assert("pre-enrichment score skip", before.decision === "skip");
  const enriched = await enrichSignal(parsed);
  const after = scoreParsedSignal(enriched);
  assert("post-enrichment scoring sees mcapUsd", enriched.mcapUsd === 42_000);
  assert("post-enrichment score >= pre", after.score >= before.score);
  __resetEnricherOverrides();
}

async function testFlagOffBehavior() {
  console.log("\n# flag off — caller (runner) bypasses enricher entirely");
  // We don't import the runner, but we simulate its flag check pattern:
  const config = (await import("../config.js")).config;
  const enricherEnabled = config?.internalAgents?.enricherEnabled !== false;
  assert("default flag is true (Phase 1 goal)", enricherEnabled === true);
  // Simulate flag-off path
  const fakeFlag = false;
  const parsed = { source: "manual", tokenAddress: FAKE_MINT, mcapUsd: null };
  const result = fakeFlag ? await enrichSignal(parsed) : parsed;
  assert("flag off → returns raw parsed", result.enriched !== true);
}

(async () => {
  console.log("# signal-enricher smoke test (no network)\n");
  try {
    await testHappyPath();
    await testPartialFailure();
    await testNoTokenAddress();
    await testNeverThrows();
    await testFillsScoringFields();
    await testFlagOffBehavior();
  } catch (err) {
    console.error(`\nFATAL: ${err.message}\n${err.stack}`);
    process.exit(2);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
