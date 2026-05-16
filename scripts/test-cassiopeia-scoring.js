// scripts/test-cassiopeia-scoring.js — Cassiopeia 👁️ scorer regression
// Validates two scoring profiles in signal-parser.scoreParsedSignal:
//   (A) Legacy Discord-LP — uses vol5mUsd + distributedSol, unchanged behavior
//   (B) Enriched — uses enrichment.{volume24h, organicScore, holders, ...}
//
// No network. No on-chain. Pure unit assertions.

import { scoreParsedSignal } from "../signal-parser.js";
import { config } from "../config.js";

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

function discordLpSignal(overrides = {}) {
  return {
    source: "discord",
    tokenAddress: FAKE_MINT,
    mcapUsd: 25_000,
    vol5mUsd: 2_500,
    distributedSol: 0.8,
    recipientPct: 12,
    type: "alpha drop",
    ...overrides,
  };
}

function enrichedTelegramSignal(overrides = {}) {
  return {
    source: "telegram",
    tokenAddress: FAKE_MINT,
    mcapUsd: 42_000,
    vol5mUsd: 88_000, // enricher promoted volume24h here (harmless under enriched profile)
    enriched: true,
    enrichedAt: new Date().toISOString(),
    enrichment: {
      mcapUsd: 42_000,
      priceUsd: 0.000042,
      liquidityUsd: 18_500,
      holders: 1234,
      organicScore: 72,
      top10Pct: 33.5,
      bundlersPct: 12,
      snipersPct: 0.3,
      riskLevel: "LOW",
      volume24h: 88_000,
      tvl: 27_000,
      pool_address: "PooLAddr1111111111111111111111111111111111",
      bin_step: 100,
      volatility: 3.2,
      ...(overrides.enrichment || {}),
    },
    ...overrides,
  };
}

function runDiscordLegacy() {
  console.log("\n# A. Discord-LP legacy path (unchanged behavior)");
  const s = discordLpSignal();
  const r = scoreParsedSignal(s);
  assert("discord LP scored", typeof r.score === "number");
  assert("discord LP reaches watch (score>=55)", r.decision === "watch");
  // Components: addr15 + mcap20 + vol20 + distrib15 + recip5 + type5 = 80
  eq("discord LP score == 80", r.score, 80);

  // Mcap below band → should drop mcap component but still legacy logic
  const lowMcap = scoreParsedSignal(discordLpSignal({ mcapUsd: 100 }));
  assert("discord LP low mcap loses 20 pts", lowMcap.score === 60);

  // Missing distributed → legacy still applies threshold
  const noDistrib = scoreParsedSignal(discordLpSignal({ distributedSol: null }));
  assert("discord LP missing distrib loses 15 pts", noDistrib.score === 65);
}

function runEnrichedHappy() {
  console.log("\n# B. Enriched telegram path");
  const s = enrichedTelegramSignal();
  const r = scoreParsedSignal(s);
  // Components: addr15 + mcap20 + volProxy20 + organic15 + holders10 + liq10 + top5 + risk5 = 100
  eq("enriched score == 100", r.score, 100);
  eq("enriched reaches watch", r.decision, "watch");
  assert("no skip reasons accumulated", r.reasons.length === 0);
}

function runEnrichedHardFails() {
  console.log("\n# C. Enriched hard-fail veto gates");
  const bundle = scoreParsedSignal(enrichedTelegramSignal({
    enrichment: { bundlersPct: 99 },
  }));
  eq("bundlers > maxBundlePct → skip", bundle.decision, "skip");
  eq("bundler skip carries reason", bundle.reasons[0].includes("bundlers"), true);

  const top10 = scoreParsedSignal(enrichedTelegramSignal({
    enrichment: { top10Pct: 95 },
  }));
  eq("top10 > maxTop10Pct → skip", top10.decision, "skip");

  const tooLate = scoreParsedSignal(enrichedTelegramSignal({
    mcapUsd: 60_000_000,
    enrichment: { mcapUsd: 60_000_000 },
  }));
  eq("mcap >50M → skip", tooLate.decision, "skip");

  const tooSmall = scoreParsedSignal(enrichedTelegramSignal({
    mcapUsd: 50,
    enrichment: { mcapUsd: 50 },
  }));
  eq("mcap <1k → skip", tooSmall.decision, "skip");
}

function runStubFallback() {
  console.log("\n# D. Pure stub signal (no enrichment, no Discord fields) → skip");
  const stub = { source: "manual", tokenAddress: FAKE_MINT };
  const r = scoreParsedSignal(stub);
  // Legacy profile: only addr15. score=15 < 55.
  eq("stub score == 15", r.score, 15);
  eq("stub decision skip", r.decision, "skip");
}

function runHybridSignalUsesLegacy() {
  console.log("\n# E. Enriched + Discord LP fields → legacy profile (richer source wins)");
  const hybrid = {
    ...discordLpSignal(),
    enriched: true,
    enrichment: {
      mcapUsd: 25_000,
      volume24h: 88_000,
      organicScore: 72,
      holders: 1234,
      liquidityUsd: 18_500,
      top10Pct: 33.5,
      bundlersPct: 12,
      riskLevel: "LOW",
    },
  };
  const r = scoreParsedSignal(hybrid);
  // Should pick LEGACY (distributedSol present) → score 80, same as pure Discord
  eq("hybrid uses legacy → score 80", r.score, 80);
}

function runFeatureFlagRollback() {
  console.log("\n# F. Feature flag rollback");
  const original = config.internalAgents.useEnrichedScoring;
  config.internalAgents.useEnrichedScoring = false;

  const s = enrichedTelegramSignal();
  const r = scoreParsedSignal(s);
  // Under legacy: addr15 + mcap20 (42k in band) + vol(vol5mUsd=88k>=1k)20 + distrib MISSING -15 = 55 ... wait
  // distributedSol absent → loses 15. recipientPct absent → loses 5. type absent → loses 5.
  // Components present: addr15 + mcap20 + vol20 = 55 → exactly watch threshold.
  eq("flag off → enriched signal scored under legacy profile", r.score, 55);
  eq("flag off → enriched signal still watch (boundary)", r.decision, "watch");

  // Now strip vol5m proxy too → confirm legacy path
  const stripped = { ...s, vol5mUsd: null };
  const r2 = scoreParsedSignal(stripped);
  eq("flag off + no vol5m → legacy drops to 35", r2.score, 35);
  eq("flag off + no vol5m → skip", r2.decision, "skip");

  config.internalAgents.useEnrichedScoring = original;
}

function runBundlerHardFailOverridesGoodSignal() {
  console.log("\n# G. Bundler-heavy signal hard-fails despite otherwise perfect scores");
  const s = enrichedTelegramSignal({
    enrichment: {
      mcapUsd: 42_000,
      volume24h: 1_000_000,
      organicScore: 99,
      holders: 5000,
      liquidityUsd: 500_000,
      top10Pct: 20,
      bundlersPct: 80, // way over
      riskLevel: "LOW",
    },
  });
  const r = scoreParsedSignal(s);
  eq("bundler hard-fail decision", r.decision, "skip");
  eq("bundler hard-fail score 0", r.score, 0);
}

(async () => {
  console.log("# Cassiopeia scoring regression — pure unit (no network)\n");
  try {
    runDiscordLegacy();
    runEnrichedHappy();
    runEnrichedHardFails();
    runStubFallback();
    runHybridSignalUsesLegacy();
    runFeatureFlagRollback();
    runBundlerHardFailOverridesGoodSignal();
  } catch (err) {
    console.error(`\nFATAL: ${err.message}\n${err.stack}`);
    process.exit(2);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
