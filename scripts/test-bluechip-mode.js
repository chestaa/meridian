// Cassiopeia — Bluechip income-engine dual-mode tests (Wave 2 / Phase 1).
//
// Bluechip mode is a SEPARATE, PARALLEL path for deep STABLE pools (SOL-USDC, JLP,
// JitoSOL, LSTs). Gated behind bluechipModeEnabled (default FALSE) — when off it is
// inert and the memecoin path is unchanged. The risk profile is INVERTED:
//   - rug-immune (no rug/mint/freeze/bot/top10 gates)
//   - LOW-vol is GOOD → volatility CEILING, never the memecoin floor
//   - large-cap → own mcap band (NOT the memecoin 50k-2M)
//   - regime-downtrend EXEMPT (already wired via isMemecoinNarrowProfile)
//
// Covers:
//   classifyPoolMode (pure):
//     - both legs bluechip (SOL-USDC)        → "bluechip"
//     - one bluechip leg, one memecoin       → "memecoin" (inherits memecoin risk)
//     - both memecoin                         → "memecoin"
//     - missing a leg mint                    → "memecoin" (fail-safe)
//     - condensed base/quote shape            → classified same as raw token_x/y
//   isBluechipPool (pure):
//     - flag OFF                              → false even for SOL-USDC
//     - flag ON + bluechip pool               → true
//     - flag ON + memecoin pool               → false
//   bluechipPoolGateRejectReason (pure, fail-closed):
//     - deep stable pool clears every gate    → null
//     - TVL below floor                       → reject
//     - volume below floor (deep-but-dead)    → reject
//     - fee-yield below bar                   → reject
//     - mcap below large-cap floor            → reject
//     - volatility ABOVE ceiling              → reject (NOT a floor)
//     - LOW/zero volatility (stable)          → PASS (low vol is GOOD — inversion proof)
//     - missing TVL/volume/fee/mcap           → *_unknown reject (anti-pattern #2)
//   INVERSION PROOFS (the whole reason bluechip needs its own gate):
//     - memecoin minVolatility 3.0 would reject SOL-USDC (vola 0.1); bluechip PASSES
//     - memecoin mcap band (max 2M) would reject SOL ($40B); bluechip PASSES
//
// Run: node scripts/test-bluechip-mode.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  classifyPoolMode,
  isBluechipPool,
  bluechipPoolGateRejectReason,
  getRawPoolScreeningRejectReason,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JLP  = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MEME = "9Wmt111111111111111111111111111111111111111"; // arbitrary non-bluechip mint

// Effective bluechip thresholds (mirror config defaults).
const sOn = {
  bluechipModeEnabled: true,
  bluechipMinTvl: 200_000,
  bluechipMinVolume: 50_000,
  bluechipMinFeeTvlRatio: 0.03,
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
};
const sOff = { ...sOn, bluechipModeEnabled: false };

// A deep, healthy live-shaped SOL-USDC pool (numbers from the 2026-06-20 probe).
function solUsdc(overrides = {}) {
  return {
    pool_address: "POOL_SOLUSDC",
    token_x: { address: WSOL, symbol: "SOL", market_cap: 40_000_000_000 },
    token_y: { address: USDC, symbol: "USDC" },
    tvl: 2_816_792,
    volume: 5_088_000,
    fee_active_tvl_ratio: 0.1684,
    volatility: 0.141,
    ...overrides,
  };
}

console.log("\n── classifyPoolMode ──");
check("both legs bluechip (SOL-USDC) → bluechip", classifyPoolMode(solUsdc()) === "bluechip");
check("JLP-USDC → bluechip", classifyPoolMode({ token_x: { address: JLP }, token_y: { address: USDC } }) === "bluechip");
check("JitoSOL-SOL → bluechip", classifyPoolMode({ token_x: { address: JITO }, token_y: { address: WSOL } }) === "bluechip");
check("one bluechip leg + memecoin → memecoin", classifyPoolMode({ token_x: { address: MEME }, token_y: { address: USDC } }) === "memecoin");
check("both memecoin → memecoin", classifyPoolMode({ token_x: { address: MEME }, token_y: { address: MEME } }) === "memecoin");
check("missing base leg → memecoin (fail-safe)", classifyPoolMode({ token_y: { address: USDC } }) === "memecoin");
check("missing quote leg → memecoin (fail-safe)", classifyPoolMode({ token_x: { address: WSOL } }) === "memecoin");
check("empty pool → memecoin (fail-safe)", classifyPoolMode({}) === "memecoin");
check("condensed base/quote shape classified same",
  classifyPoolMode({ base: { mint: WSOL }, quote: { mint: USDC } }) === "bluechip");

console.log("\n── isBluechipPool ──");
check("flag OFF → false even for SOL-USDC", isBluechipPool(solUsdc(), sOff) === false);
check("flag ON + bluechip → true", isBluechipPool(solUsdc(), sOn) === true);
check("flag ON + memecoin → false", isBluechipPool({ token_x: { address: MEME }, token_y: { address: USDC } }, sOn) === false);

console.log("\n── bluechipPoolGateRejectReason — happy path ──");
check("deep healthy SOL-USDC clears every gate", bluechipPoolGateRejectReason(solUsdc(), sOn) === null);

console.log("\n── bluechipPoolGateRejectReason — each floor ──");
check("TVL below floor → reject", /below bluechipMinTvl/.test(bluechipPoolGateRejectReason(solUsdc({ tvl: 100_000 }), sOn)));
check("volume below floor (deep-but-dead) → reject", /below bluechipMinVolume/.test(bluechipPoolGateRejectReason(solUsdc({ volume: 2_000 }), sOn)));
check("fee-yield below bar → reject", /below bluechipMinFeeTvlRatio/.test(bluechipPoolGateRejectReason(solUsdc({ fee_active_tvl_ratio: 0.001 }), sOn)));
check("mcap below large-cap floor → reject", /below bluechipMinMcap/.test(bluechipPoolGateRejectReason(solUsdc({ token_x: { address: WSOL, market_cap: 1_000_000 } }), sOn)));

console.log("\n── volatility is a CEILING, not a floor (the inversion) ──");
check("vola ABOVE ceiling → reject", /above bluechipMaxVolatility/.test(bluechipPoolGateRejectReason(solUsdc({ volatility: 3.5 }), sOn)));
check("LOW vola (0.14, stable) → PASS", bluechipPoolGateRejectReason(solUsdc({ volatility: 0.14 }), sOn) === null);
check("ZERO vola (perfectly stable) → PASS (no floor)", bluechipPoolGateRejectReason(solUsdc({ volatility: 0 }), sOn) === null);
check("MISSING vola tolerated for bluechip → PASS", bluechipPoolGateRejectReason(solUsdc({ volatility: null }), sOn) === null);

console.log("\n── fail-closed missing data (anti-pattern #2) ──");
check("missing TVL → bluechip_tvl_unknown", bluechipPoolGateRejectReason(solUsdc({ tvl: null }), sOn) === "bluechip_tvl_unknown");
check("missing volume → bluechip_volume_unknown", bluechipPoolGateRejectReason(solUsdc({ volume: null }), sOn) === "bluechip_volume_unknown");
check("missing fee/TVL → bluechip_fee_tvl_unknown", bluechipPoolGateRejectReason(solUsdc({ fee_active_tvl_ratio: null }), sOn) === "bluechip_fee_tvl_unknown");
check("missing mcap → bluechip_mcap_unknown", bluechipPoolGateRejectReason(solUsdc({ token_x: { address: WSOL } }), sOn) === "bluechip_mcap_unknown");

console.log("\n── INVERSION PROOFS: memecoin gates would WRONGLY reject a bluechip ──");
// 1) memecoin volatility FLOOR (3.0) would reject SOL-USDC (vola 0.14) — bluechip passes.
const memeS = {
  minMcap: 50_000, maxMcap: 2_000_000, minHolders: 0, minVolume: 0, minTvl: 0,
  minBinStep: 0, maxBinStep: 999, minFeeActiveTvlRatio: 0,
  minVolatility: 3.0, minOrganic: 0,
};
// In-band mcap so we isolate the VOLATILITY floor as the rejecting gate (SOL's real
// $40B mcap would otherwise fire the maxMcap ceiling first — that's inversion proof #2).
const lowVolStable = {
  token_x: { address: WSOL, symbol: "SOL", market_cap: 1_000_000, organic_score: 50, created_at: Date.now() - 1e9 },
  token_y: { address: USDC, organic_score: 50 },
  tvl: 2_816_792, volume: 5_088_000, fee_active_tvl_ratio: 0.1684, volatility: 0.141,
  base_token_holders: 99999, dlmm_params: { bin_step: 10 },
};
const memeVolReject = getRawPoolScreeningRejectReason(lowVolStable, memeS);
check("memecoin minVolatility 3.0 WOULD reject a stable low-vol pool (vola 0.14)", /below minVolatility/.test(memeVolReject || ""));
check("bluechip gate PASSES the SAME low-vol SOL-USDC pool", bluechipPoolGateRejectReason(solUsdc({ volatility: 0.141 }), sOn) === null);
// 2) memecoin mcap ceiling (2M) would reject SOL ($40B) — bluechip passes.
const realSol = {
  token_x: { address: WSOL, symbol: "SOL", market_cap: 40_000_000_000, organic_score: 50, created_at: Date.now() - 1e9 },
  token_y: { address: USDC, organic_score: 50 },
  tvl: 2_816_792, volume: 5_088_000, fee_active_tvl_ratio: 0.1684, volatility: 5,
  base_token_holders: 99999, dlmm_params: { bin_step: 10 },
};
const memeMcapReject = getRawPoolScreeningRejectReason(realSol, memeS);
check("memecoin maxMcap 2M WOULD reject SOL ($40B)", /above maxMcap/.test(memeMcapReject || ""));
check("bluechip gate PASSES SOL ($40B mcap)", bluechipPoolGateRejectReason(solUsdc(), sOn) === null);

console.log("\n── disabled-gate inertness (each floor=0 → no-op) ──");
check("all floors 0 → null (gate inert)", bluechipPoolGateRejectReason(solUsdc({ tvl: 1, volume: 1, fee_active_tvl_ratio: 0.0001, token_x: { address: WSOL, market_cap: 1 } }),
  { bluechipModeEnabled: true, bluechipMinTvl: 0, bluechipMinVolume: 0, bluechipMinFeeTvlRatio: 0, bluechipMinMcap: 0, bluechipMaxVolatility: 0 }) === null);

console.log(`\n${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "bluechip-mode tests must all pass");
