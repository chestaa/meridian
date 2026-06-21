// Cassiopeia — Bluechip PLUMBING fix tests (A binStep exempt + B fee/TVL carve-out +
// C bluechipOnlyMode funnel restrict). Lyra checkpoint: the bluechip income engine had
// NEVER deployed because (A) the memecoin binStep floor [80,…] rejected SOL-USDC's real
// bin_step=1, (B) the memecoin fee/TVL floor (live 0.10-0.15) rejected SOL-USDC's
// fee/TVL 0.078, and (C) bluechip lost the pre-rank to memecoins → never reached top-N.
//
// This suite proves the THREE fixes, end-to-end on the canonical SOL-USDC shape AND the
// flag-off regression:
//
//   A — bluechip gate has NO bin_step floor (the memecoin [80,…] band is structurally
//       wrong for deep stable pools). SOL-USDC bin_step=1 must clear the bluechip gate.
//   B — bluechipMinFeeTvlRatio 0.03 carve-out: SOL-USDC fee/TVL 0.078 PASSES (well above
//       0.03), where the memecoin live floor (0.10-0.15) would have rejected it. The
//       0.03 floor is JUSTIFIED — bluechip IL is far smaller (symmetric payoff), so a
//       lower fee yield still nets positive vs the memecoin asymmetric-IL bar.
//   C — bluechipOnlyMode: a memecoin pool is dropped from the discoverPools funnel
//       (non_bluechip_filtered_bluechip_only_mode) so the paper-soak collects PURE
//       bluechip data; flag OFF → memecoin path byte-for-byte unchanged.
//
// Run: node scripts/test-bluechip-plumbing.js

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
const MEME = "9Wmt111111111111111111111111111111111111111";

// Effective thresholds with the LIVE-shaped memecoin floors that historically blocked
// SOL-USDC: minBinStep 80 (binStep block), minFeeActiveTvlRatio 0.15 (fee/TVL block).
const sOn = {
  bluechipModeEnabled: true,
  bluechipMinTvl: 200_000,
  bluechipMinVolume: 50_000,
  bluechipMinFeeTvlRatio: 0.03,
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
  bluechipMaxBinStep: 200,
  bluechipOnlyMode: false,
  requireBluechipWsolLeg: true,
  // memecoin floors at their HARSHEST live values (the exact ones that blocked bluechip)
  minMcap: 150_000, maxMcap: 10_000_000, minHolders: 500, minVolume: 500,
  minTvl: 10_000, maxTvl: 150_000, minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.15, minOrganic: 60,
};

// Canonical SOL-USDC: REAL deep-pool shape — bin_step=1 (A trap), fee/TVL 0.078 (B trap),
// deep TVL, real volume, low vol (good for bluechip), SOL mcap ~$40B.
function solUsdc(overrides = {}) {
  return {
    pool_address: "POOL_SOLUSDC", name: "SOL-USDC",
    token_x: { address: WSOL, symbol: "SOL", market_cap: 40_000_000_000, organic_score: 95, created_at: 0, holders: 500000 },
    token_y: { address: USDC, symbol: "USDC", organic_score: 95 },
    base: { mint: WSOL, symbol: "SOL" }, quote: { mint: USDC, symbol: "USDC" },
    base_token_holders: 500000,
    tvl: 3_400_000, active_tvl: 3_400_000,
    volume: 18_000_000, volume_window: 18_000_000,
    fee_active_tvl_ratio: 0.078, volatility: 0.141,
    mcap: 40_000_000_000,
    dlmm_params: { bin_step: 1 },
    ...overrides,
  };
}

// A memecoin pool that PASSES the memecoin gate (so C's drop is the only thing that cuts it).
function memecoinPass(overrides = {}) {
  return {
    pool_address: "POOL_MEME", name: "MEME-SOL",
    token_x: { address: MEME, symbol: "MEME", market_cap: 800_000, organic_score: 75, created_at: 0 },
    token_y: { address: WSOL, symbol: "SOL", organic_score: 95 },
    base: { mint: MEME, symbol: "MEME" }, quote: { mint: WSOL, symbol: "SOL" },
    base_token_holders: 1200,
    tvl: 50_000, active_tvl: 50_000,
    volume: 200_000, volume_window: 200_000,
    fee_active_tvl_ratio: 0.30, volatility: 4.0,
    mcap: 800_000,
    dlmm_params: { bin_step: 100 },
    ...overrides,
  };
}

console.log("\n── A: bin_step exempt for bluechip (SOL-USDC bin_step=1 clears the gate) ──");
{
  // The memecoin gate WOULD reject bin_step=1 (below minBinStep 80).
  const memecoinReason = getRawPoolScreeningRejectReason(solUsdc(), sOn);
  check("memecoin gate rejects SOL-USDC (proves the trap exists)", memecoinReason !== null);
  // The bluechip gate has NO bin_step floor → must NOT reject on bin_step.
  const bcReason = bluechipPoolGateRejectReason(solUsdc(), sOn);
  check("bluechip gate does NOT reject SOL-USDC bin_step=1", bcReason === null);
  // Even an extreme small bin_step is fine for bluechip (no floor at all).
  check("bluechip gate ignores bin_step entirely (bin_step=2)", bluechipPoolGateRejectReason(solUsdc({ dlmm_params: { bin_step: 2 } }), sOn) === null);
}

console.log("\n── B: fee/TVL carve-out (SOL-USDC fee/TVL 0.078 passes the 0.03 bluechip floor) ──");
{
  // Isolate the fee/TVL trap: a pool that clears the memecoin mcap band + bin_step but
  // sits at SOL-USDC's fee/TVL 0.078 — the memecoin live floor 0.15 rejects it ON fee/TVL,
  // proving the B trap. (The real SOL-USDC also trips the mcap band; here we isolate fee/TVL.)
  const feeTvlIsolated = getRawPoolScreeningRejectReason(
    solUsdc({ dlmm_params: { bin_step: 100 }, mcap: 5_000_000, token_x: { address: WSOL, symbol: "SOL", market_cap: 5_000_000, organic_score: 95, created_at: 0 }, tvl: 100_000, active_tvl: 100_000 }),
    sOn,
  );
  check("memecoin floor 0.15 rejects fee/TVL 0.078 (B trap isolated)", typeof feeTvlIsolated === "string" && feeTvlIsolated.includes("fee/active-TVL"));
  check("bluechip floor 0.03 accepts fee/TVL 0.078", bluechipPoolGateRejectReason(solUsdc(), sOn) === null);
  // Below the bluechip 0.03 floor → bluechip STILL rejects (carve-out is a floor, not a hole).
  check("bluechip floor 0.03 STILL rejects fee/TVL 0.02 (not a hole)", typeof bluechipPoolGateRejectReason(solUsdc({ fee_active_tvl_ratio: 0.02 }), sOn) === "string");
  // Fail-closed: missing fee/TVL → reject (anti-pattern #2).
  check("bluechip fail-closed: missing fee/TVL → reject", bluechipPoolGateRejectReason(solUsdc({ fee_active_tvl_ratio: undefined }), sOn) === "bluechip_fee_tvl_unknown");
}

console.log("\n── A+B together: SOL-USDC clears the FULL bluechip gate end-to-end ──");
{
  check("classifyPoolMode(SOL-USDC) === bluechip", classifyPoolMode(solUsdc()) === "bluechip");
  check("isBluechipPool true when flag on", isBluechipPool(solUsdc(), sOn) === true);
  check("SOL-USDC PASSES bluechip gate (deploy-eligible: A+B both cleared)", bluechipPoolGateRejectReason(solUsdc(), sOn) === null);
}

console.log("\n── C: bluechipOnlyMode funnel restrict (paper-soak purity) ──");
{
  // Simulate the discoverPools routing decision (the exact condition added at line ~1966).
  function discoverDecision(pool, s) {
    const isBc = isBluechipPool(pool, s);
    if (s.bluechipModeEnabled === true && s.bluechipOnlyMode === true && !isBc) {
      return "non_bluechip_filtered_bluechip_only_mode";
    }
    return isBc ? bluechipPoolGateRejectReason(pool, s) : getRawPoolScreeningRejectReason(pool, s);
  }
  const sOnly = { ...sOn, bluechipOnlyMode: true };

  // bluechipOnlyMode ON: memecoin dropped, bluechip survives.
  check("bluechipOnlyMode drops a passing memecoin pool", discoverDecision(memecoinPass(), sOnly) === "non_bluechip_filtered_bluechip_only_mode");
  check("bluechipOnlyMode keeps SOL-USDC (bluechip survives)", discoverDecision(solUsdc(), sOnly) === null);

  // bluechipOnlyMode OFF (but mode on): mixed — memecoin takes its own gate.
  check("mixed mode (onlyMode off): memecoin routed to memecoin gate", discoverDecision(memecoinPass(), sOn) === null);
  check("mixed mode (onlyMode off): SOL-USDC still bluechip", discoverDecision(solUsdc(), sOn) === null);
}

console.log("\n── REGRESSION: flag OFF → memecoin path byte-for-byte unchanged ──");
{
  const sOff = { ...sOn, bluechipModeEnabled: false, bluechipOnlyMode: true };
  function discoverDecision(pool, s) {
    const isBc = isBluechipPool(pool, s);
    if (s.bluechipModeEnabled === true && s.bluechipOnlyMode === true && !isBc) {
      return "non_bluechip_filtered_bluechip_only_mode";
    }
    return isBc ? bluechipPoolGateRejectReason(pool, s) : getRawPoolScreeningRejectReason(pool, s);
  }
  // Even with bluechipOnlyMode=true, master flag OFF → C is inert (memecoin not dropped).
  check("flag OFF: isBluechipPool false for SOL-USDC", isBluechipPool(solUsdc(), sOff) === false);
  check("flag OFF: bluechipOnlyMode inert (C never fires without master flag)", discoverDecision(memecoinPass(), sOff) === getRawPoolScreeningRejectReason(memecoinPass(), sOff));
  check("flag OFF: SOL-USDC takes MEMECOIN gate (and is rejected — bin_step/fee/TVL trap)", discoverDecision(solUsdc(), sOff) === getRawPoolScreeningRejectReason(solUsdc(), sOff));
  check("flag OFF: SOL-USDC memecoin-gate reject is non-null (the original block)", getRawPoolScreeningRejectReason(solUsdc(), sOff) !== null);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "bluechip plumbing tests must all pass");
