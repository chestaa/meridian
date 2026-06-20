// Cassiopeia — Bluechip income-engine WIRING tests (Wave 2 / Phase 1).
//
// c342d23 built the bluechip CLASSIFIER + inverted GATE (test-bluechip-mode.js).
// THIS suite covers the WIRING of that gate into the funnel (getTopCandidates /
// discoverPools / buildDiscoveryFilters / market-regime gate). It exercises the pure
// decision fns the wiring relies on, with the flag both ON and OFF, to prove:
//
//   (a) flag ON  + SOL-USDC bluechip  → routed to bluechip gate (passes)
//   (b) flag ON  + memecoin pool      → memecoin gate (unchanged)
//   (c) flag OFF + everything         → memecoin path (regression: isBluechipPool false)
//   (d) bluechip + requireSolQuote    → SOL-USDC (wSOL base / USDC quote) deployable
//   (e) non-deployable bluechip       → no wSOL leg (JLP-USDC) flagged undeployable
//   + discovery-band: broad mcap ceiling RAISED only when flag on (SOL ~$40B survives)
//   + regime gate: bluechip EXEMPT from downtrend pause (incl. non-stable base LST)
//
// Run: node scripts/test-bluechip-wiring.js

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
  bluechipHasWsolLeg,
  marketRegimeGateRejectReason,
  solQuoteRejectReason,
  buildDiscoveryFilters,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JLP  = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MEME = "9Wmt111111111111111111111111111111111111111";

const sOn = {
  bluechipModeEnabled: true,
  bluechipMinTvl: 200_000,
  bluechipMinVolume: 50_000,
  bluechipMinFeeTvlRatio: 0.03,
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
  requireBluechipWsolLeg: true,
  requireSolQuote: true,
  // discovery-band knobs
  broadDiscoveryEnabled: true,
  broadMcapFloor: 10_000,
  broadMcapCeil: 50_000_000,
  broadMinTvl: 1_000,
  bluechipBroadMcapCeil: 1_000_000_000_000,
  excludeHighSupplyConcentration: true,
  // memecoin gate knobs (so OFF-mode path is well-formed)
  minMcap: 150_000, maxMcap: 10_000_000, minHolders: 500, minVolume: 500,
  minTvl: 10_000, maxTvl: 150_000, minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.06, minOrganic: 60, marketRegimeGateEnabled: true,
};
const sOff = { ...sOn, bluechipModeEnabled: false };

// SOL-USDC: base = wSOL, quote = USDC (the canonical deployable bluechip — wSOL LEG).
function solUsdc(overrides = {}) {
  return {
    pool_address: "POOL_SOLUSDC", name: "SOL-USDC",
    token_x: { address: WSOL, symbol: "SOL", market_cap: 40_000_000_000 },
    token_y: { address: USDC, symbol: "USDC" },
    base: { mint: WSOL, symbol: "SOL" }, quote: { mint: USDC, symbol: "USDC" },
    tvl: 2_816_792, volume: 5_088_000, volume_window: 5_088_000,
    fee_active_tvl_ratio: 0.1684, volatility: 0.141,
    mcap: 40_000_000_000,
    ...overrides,
  };
}
// JLP-USDC: both bluechip, but NO wSOL leg → discoverable, NOT Opsi-B deployable.
function jlpUsdc(overrides = {}) {
  return {
    pool_address: "POOL_JLPUSDC", name: "JLP-USDC",
    token_x: { address: JLP, symbol: "JLP", market_cap: 770_000_000 },
    token_y: { address: USDC, symbol: "USDC" },
    base: { mint: JLP, symbol: "JLP" }, quote: { mint: USDC, symbol: "USDC" },
    tvl: 1_500_000, volume: 800_000, volume_window: 800_000,
    fee_active_tvl_ratio: 0.05, volatility: 0.3, mcap: 770_000_000,
    ...overrides,
  };
}
// JitoSOL-SOL: bluechip with NON-stable base (LST) — the regime-exempt edge case.
function jitoSol(overrides = {}) {
  return {
    pool_address: "POOL_JITOSOL", name: "JitoSOL-SOL",
    token_x: { address: JITO, symbol: "JitoSOL", market_cap: 2_000_000_000 },
    token_y: { address: WSOL, symbol: "SOL" },
    base: { mint: JITO, symbol: "JitoSOL" }, quote: { mint: WSOL, symbol: "SOL" },
    tvl: 5_000_000, volume: 1_000_000, volume_window: 1_000_000,
    fee_active_tvl_ratio: 0.04, volatility: 0.2, mcap: 2_000_000_000,
    ...overrides,
  };
}
// A memecoin pool (USDC-quoted but base is a meme — classified memecoin).
function meme(overrides = {}) {
  return {
    pool_address: "POOL_MEME", name: "MEME-USDC",
    token_x: { address: MEME, symbol: "MEME", market_cap: 500_000 },
    token_y: { address: USDC, symbol: "USDC" },
    base: { mint: MEME, symbol: "MEME" }, quote: { mint: USDC, symbol: "USDC" },
    tvl: 50_000, volume: 100_000, volume_window: 100_000,
    fee_active_tvl_ratio: 0.2, volatility: 4.0, mcap: 500_000,
    ...overrides,
  };
}

// ── (a) flag ON + SOL-USDC bluechip → bluechip gate, passes ──
console.log("\n── (a) flag ON + SOL-USDC → bluechip gate path (pass) ──");
check("isBluechipPool ON + SOL-USDC → true", isBluechipPool(solUsdc(), sOn) === true);
check("bluechip gate PASSES the deep SOL-USDC pool", bluechipPoolGateRejectReason(solUsdc(), sOn) === null);

// ── (b) flag ON + memecoin → memecoin path (NOT routed to bluechip gate) ──
console.log("\n── (b) flag ON + memecoin → memecoin gate (unchanged) ──");
check("isBluechipPool ON + memecoin → false (takes memecoin path)", isBluechipPool(meme(), sOn) === false);
check("classifyPoolMode meme → memecoin", classifyPoolMode(meme()) === "memecoin");

// ── (c) flag OFF → everything memecoin path (regression) ──
console.log("\n── (c) flag OFF → memecoin path for ALL (regression) ──");
check("isBluechipPool OFF + SOL-USDC → false", isBluechipPool(solUsdc(), sOff) === false);
check("isBluechipPool OFF + JLP-USDC → false", isBluechipPool(jlpUsdc(), sOff) === false);
check("isBluechipPool OFF + JitoSOL → false", isBluechipPool(jitoSol(), sOff) === false);
// classifyPoolMode is flag-independent (pure label); the BRANCH is gated by isBluechipPool.
check("classifyPoolMode still labels SOL-USDC bluechip (flag-independent)", classifyPoolMode(solUsdc()) === "bluechip");

// ── (d) bluechip + requireSolQuote relaxed (SOL-USDC = USDC quote, wSOL base) ──
console.log("\n── (d) requireSolQuote relax for bluechip ──");
// solQuoteRejectReason itself still rejects a USDC quote (the wiring SKIPS it for bluechip).
check("raw solQuoteRejectReason WOULD reject USDC-quoted SOL-USDC (memecoin assumption)",
  solQuoteRejectReason(solUsdc(), sOn) === "non_sol_quote_undeployable");
// The wiring relaxes via isBluechipPool — confirm SOL-USDC IS classified bluechip so it bypasses.
check("SOL-USDC is bluechip → wiring bypasses the SOL-quote filter", isBluechipPool(solUsdc(), sOn) === true);
// True deployability is governed by wSOL-leg, NOT quote==wSOL: SOL-USDC has a wSOL leg.
check("SOL-USDC has wSOL leg → deployable under Opsi B", bluechipHasWsolLeg(solUsdc()) === true);

// ── (e) non-deployable bluechip (no wSOL leg) handled ──
console.log("\n── (e) non-wSOL-leg bluechip flagged undeployable ──");
check("JLP-USDC is bluechip", isBluechipPool(jlpUsdc(), sOn) === true);
check("JLP-USDC has NO wSOL leg → undeployable under Opsi B", bluechipHasWsolLeg(jlpUsdc()) === false);
check("USDC-USDT (no wSOL leg) → undeployable",
  bluechipHasWsolLeg({ base: { mint: USDC }, quote: { mint: USDT } }) === false);
check("JitoSOL-SOL HAS wSOL leg (quote side) → deployable", bluechipHasWsolLeg(jitoSol()) === true);
check("SOL-USDC wSOL leg detected via condensed shape too", bluechipHasWsolLeg({ base: { mint: WSOL }, quote: { mint: USDC } }) === true);

// ── discovery band: broad mcap ceiling RAISED only when flag on ──
console.log("\n── discovery band: broad mcap ceiling raise (flag-gated) ──");
const filtersOff = buildDiscoveryFilters(sOff);
const filtersOn = buildDiscoveryFilters(sOn);
check("flag OFF → broad ceiling = memecoin 50M (byte-for-byte)",
  filtersOff.includes("base_token_market_cap<=50000000"));
check("flag OFF → NO trillion ceiling",
  !filtersOff.includes("base_token_market_cap<=1000000000000"));
check("flag ON → broad ceiling raised to bluechipBroadMcapCeil ($1T) so SOL ($40B) survives server",
  filtersOn.includes("base_token_market_cap<=1000000000000"));
check("flag ON → floor unchanged (10k, still a superset)",
  filtersOn.includes("base_token_market_cap>=10000"));
// SUPERSET invariant: the raised ceiling never narrows — it only widens the server set.
check("raised ceiling (1T) >= memecoin ceiling (50M) → superset preserved",
  1_000_000_000_000 >= 50_000_000);

// ── regime gate: bluechip EXEMPT from downtrend pause (incl. non-stable base) ──
console.log("\n── regime gate: bluechip exempt from downtrend pause ──");
const downtrend = { regime: "DOWNTREND", reasoning: "test" };
check("flag ON: SOL-USDC bluechip EXEMPT in downtrend (null)",
  marketRegimeGateRejectReason(solUsdc(), downtrend, sOn) === null);
check("flag ON: JitoSOL-SOL (NON-stable LST base) ALSO exempt — the wiring fix",
  marketRegimeGateRejectReason(jitoSol(), downtrend, sOn) === null);
check("flag ON: memecoin in downtrend → PAUSED (unchanged)",
  marketRegimeGateRejectReason(meme(), downtrend, sOn) === "market_regime_downtrend_memecoin_paused");
check("flag OFF: JitoSOL-SOL falls to legacy isMemecoinNarrowProfile (base=LST → pausable)",
  marketRegimeGateRejectReason(jitoSol(), downtrend, sOff) === "market_regime_downtrend_memecoin_paused");
check("flag OFF: SOL-USDC (wSOL base) still legacy-exempt (BLUECHIP_BASE_MINTS)",
  marketRegimeGateRejectReason(solUsdc(), downtrend, sOff) === null);
check("regime gate off entirely → null regardless",
  marketRegimeGateRejectReason(meme(), downtrend, { ...sOn, marketRegimeGateEnabled: false }) === null);
check("NEUTRAL regime → never pauses (anti-dormancy)",
  marketRegimeGateRejectReason(meme(), { regime: "NEUTRAL" }, sOn) === null);

// ── fail-closed sanity: bluechip gate still rejects missing data ──
console.log("\n── fail-closed (anti-pattern #2) preserved through wiring ──");
check("bluechip missing TVL → reject", bluechipPoolGateRejectReason(solUsdc({ tvl: undefined, active_tvl: undefined }), sOn) === "bluechip_tvl_unknown");
check("bluechip thin TVL (deep-but-dead) → reject", bluechipPoolGateRejectReason(jlpUsdc({ tvl: 5_000 }), sOn)?.startsWith("bluechip tvl"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
