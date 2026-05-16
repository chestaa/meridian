// Snapshot test for agents/andromeda.js (PR 2)
//
// Pure JS, no LLM, no network. Run via:
//   node scripts/test-andromeda.js
//
// Failure exits non-zero so this is CI-friendly.

import {
  formatDeployReport,
  formatNoDeployReport,
  formatPnL,
  formatProgressBar,
  formatRange,
  andromedaEnabled,
} from "../agents/andromeda.js";

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertContains(haystack, needle, label) {
  if (typeof haystack === "string" && haystack.includes(needle)) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
    console.log(`    needle:   ${JSON.stringify(needle)}`);
    console.log(`    haystack: ${JSON.stringify(haystack)}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (typeof haystack === "string" && !haystack.includes(needle)) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
}

// ─── Fixtures ─────────────────────────────────────────────────
const sampleCandidate = {
  pool: {
    pool: "PooLAddr1111111111111111111111111111111111",
    name: "MOON/SOL",
    bin_step: 100,
    fee_pct: 1.0,
    fee_active_tvl_ratio: 0.42,
    volume_window: 12_345,
    tvl: 87_654,
    volatility: 3.2,
    organic_score: 78,
    mcap: 420_000,
    token_age_hours: 14,
    active_bin: 8123,
    risk_level: "medium",
    bundle_pct: 12,
    sniper_pct: 0.3,
    is_rugpull: false,
    is_wash: false,
    price_vs_ath_pct: -35,
  },
  sw: { in_pool: [{ name: "alpha_wallet" }, { name: "kol_x" }] },
  n: { narrative: "viral cat moment" },
  ti: {
    audit: { top_holders_pct: 38, bot_holders_pct: 12 },
    global_fees_sol: 67.5,
  },
};

const dryRunDeploy = {
  dry_run: true,
  would_deploy: {
    pool_address: "PooLAddr1111111111111111111111111111111111",
    strategy: "bid_ask",
    bins_below: 51,
    bins_above: 0,
    amount_y: 0.03,
  },
  message: "DRY RUN — no transaction sent",
};

const liveDeploy = {
  success: true,
  position: "PosAddr222",
  pool: "PooLAddr1111111111111111111111111111111111",
  pool_name: "MOON/SOL",
  bin_range: { min: 8072, max: 8123, active: 8123 },
  price_range: { min: 0.00012, max: 0.00015 },
  range_coverage: {
    downside_pct: 19.5,
    upside_pct: 0,
    width_pct: 24.3,
    active_price: 0.00014,
  },
  bin_step: 100,
  base_fee: 1.0,
  strategy: "bid_ask",
  amount_y: 0.5,
  txs: ["sig1"],
};

// ─── 1. Dry-run deploy report ─────────────────────────────────
console.log("\n[1] formatDeployReport — dry run");
const dryReport = formatDeployReport({ deployResult: dryRunDeploy, candidate: sampleCandidate });
assertContains(dryReport, "🚀 SIMULATED DEPLOY", "header is SIMULATED for dry-run");
assertContains(dryReport, "MOON/SOL", "pool name appears");
assertContains(dryReport, "PooLAddr1111111111111111111111111111111111", "pool address appears");
assertContains(dryReport, "bid_ask", "strategy appears");
assertContains(dryReport, "0.030 SOL", "amount formatted with 3 decimals");
assertContains(dryReport, "Top10: 38.00%", "top10 audit line");
assertContains(dryReport, "Bots: 12.00%", "bots audit line");
assertContains(dryReport, "Smart wallets: alpha_wallet, kol_x", "smart wallet names");
assertContains(dryReport, "Risk level: medium", "OKX risk line");
assertContains(dryReport, "Rugpull: NO", "rugpull flag line");
assertNotContains(dryReport, "OKX: unavailable", "OKX is present, not 'unavailable'");

// ─── 2. Live deploy report ────────────────────────────────────
console.log("\n[2] formatDeployReport — live");
const liveReport = formatDeployReport({ deployResult: liveDeploy, candidate: sampleCandidate });
assertContains(liveReport, "🚀 DEPLOYED", "live header is DEPLOYED (not SIMULATED)");
assertNotContains(liveReport, "SIMULATED", "no SIMULATED prefix on live");
assertContains(liveReport, "Range cover: 19.50% downside | 0.00% upside | 24.30% total", "range_coverage from tool result");
assertContains(liveReport, "bin 8123", "active bin appears");
assertContains(liveReport, "Range: ", "range line present");

// ─── 3. No-deploy with rejected candidates ────────────────────
console.log("\n[3] formatNoDeployReport — with rejects");
const noDeploy = formatNoDeployReport({
  rejectedCandidates: [
    { pool: { name: "MOON/SOL" }, reason: "low fee/TVL" },
    { pool: { name: "DOGE2/SOL" }, reason: "rugpull flag" },
  ],
  reason: "no candidate cleared the bar",
});
assertContains(noDeploy, "⛔ NO DEPLOY", "no-deploy header");
assertContains(noDeploy, "BEST LOOKING CANDIDATE\nMOON/SOL", "best candidate is first in list");
assertContains(noDeploy, "- MOON/SOL: low fee/TVL", "first reject formatted");
assertContains(noDeploy, "- DOGE2/SOL: rugpull flag", "second reject formatted");
assertContains(noDeploy, "no candidate cleared the bar", "user-supplied reason embedded");

// ─── 4. No-deploy empty list ──────────────────────────────────
console.log("\n[4] formatNoDeployReport — empty");
const noDeployEmpty = formatNoDeployReport({ rejectedCandidates: [] });
assertContains(noDeployEmpty, "⛔ NO DEPLOY", "empty header");
assertContains(noDeployEmpty, "BEST LOOKING CANDIDATE\nnone", "empty list → 'none'");
assertNotContains(noDeployEmpty, "REJECTED", "no REJECTED section when list empty");

// ─── 5. Helper functions ──────────────────────────────────────
console.log("\n[5] helper functions");
assertEq(formatPnL(5.234), "+5.23%", "formatPnL positive");
assertEq(formatPnL(-12.5), "-12.50%", "formatPnL negative");
assertEq(formatPnL(null), "n/a", "formatPnL null");
assertEq(formatProgressBar(0).startsWith("["), true, "progress bar starts with [");
assertEq(formatProgressBar(100).includes("100%"), true, "progress bar 100%");
assertEq(formatRange({ min: 1, max: 2 }), "1.0000 → 2.0000", "formatRange basic");
assertEq(formatRange(null), "n/a", "formatRange null");

// ─── 6. andromedaEnabled flag check ───────────────────────────
console.log("\n[6] andromedaEnabled");
assertEq(andromedaEnabled({ internalAgents: { andromedaEnabled: true } }), true, "flag ON");
assertEq(andromedaEnabled({ internalAgents: { andromedaEnabled: false } }), false, "flag OFF");
assertEq(andromedaEnabled({}), false, "missing block → false");
assertEq(andromedaEnabled(null), false, "null config → false");

// ─── 7. Robustness — missing OKX data ─────────────────────────
console.log("\n[7] missing OKX block");
const noOkxCandidate = {
  pool: {
    pool: "PoolX", name: "X/SOL",
    fee_active_tvl_ratio: 0.1, volume_window: 1000, tvl: 5000,
    volatility: 1, organic_score: 50, mcap: 50000,
  },
  ti: { audit: {} },
};
const noOkxReport = formatDeployReport({ deployResult: liveDeploy, candidate: noOkxCandidate });
assertContains(noOkxReport, "OKX: unavailable", "no OKX → 'unavailable' literal");

// ─── Summary ──────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} assertions total)`);
if (failed > 0) process.exit(1);
