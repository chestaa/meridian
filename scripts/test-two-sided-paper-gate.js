// Cassiopeia 👁️ — Two-sided PAPER-lane bluechip SURFACING gate (Track-A final unblock).
//
// WHAT THIS PROVES:
//   1. THE BUG — the income gate (bluechipPoolGateRejectReason) rejects a real deep-TVL
//      LST-SOL pool on the income-engine volume / fee-TVL yield bars (the exact blocker
//      that gave 0 paper deploys). Draco's maxTvl hypothesis is disproven (no maxTvl).
//   2. THE FIX — twoSidedPaperBluechipGateReason PASSES that same deep LST-SOL pool
//      (drops the income yield bars) while KEEPING deep-TVL / large-cap / vol-ceiling.
//   3. STRUCTURE STILL BITES — a thin fake-bluechip pool, a wild-vol de-peg, and a
//      small-cap base are still rejected; missing TVL/mcap → fail-closed reject.
//   4. SAFETY NOT RELAXED — the gate does NOT touch rug/mint/freeze/bot/top10; those are
//      enforced downstream (twoSidedBaseLegGateReason) — re-asserted here on a bad leg.
//   5. LIVE ISOLATION — the paper gate is a SUPERSET only when the lane is active; the
//      memecoin/income routing is unchanged when the lane is inactive.
//
// Run: node scripts/test-two-sided-paper-gate.js

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
  bluechipPoolGateRejectReason,
  twoSidedPaperBluechipGateReason,
  isTwoSidedPaperCandidate,
  twoSidedBaseLegGateReason,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

// Effective bluechip thresholds mirroring live defaults.
const S = {
  bluechipMinTvl: 200_000,
  bluechipMinVolume: 50_000,
  bluechipMinFeeTvlRatio: 0.03,
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
  // base-leg safety (used by twoSidedBaseLegGateReason)
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};

// A real deep-TVL LST-SOL pool: $2.44M TVL, low churn ($40k vol), ~1% APR (tiny fee/TVL),
// stable low vol, huge LST mcap. This is exactly what tvl:desc surfaces.
function jitoSolDeep(extra = {}) {
  return {
    name: "JitoSOL-SOL",
    tvl: 2_440_000,
    volume: 40_000,
    fee_active_tvl_ratio: 0.0001,
    volatility: 0.12,
    token_x: { mint: JITOSOL, symbol: "JitoSOL", market_cap: 2_500_000_000 },
    token_y: { mint: WSOL, symbol: "SOL" },
    ...extra,
  };
}

console.log("\n— 1. THE BUG: income gate rejects the deep LST-SOL pool —");
{
  const r = bluechipPoolGateRejectReason(jitoSolDeep(), S);
  check("income gate REJECTS deep LST-SOL (income bar)", r !== null);
  check("...on the volume income bar first", r === "bluechip volume 40000 below bluechipMinVolume 50000");
  // With volume raised, fee/TVL yield bar bites next — proves BOTH income bars are blockers.
  const r2 = bluechipPoolGateRejectReason(jitoSolDeep({ volume: 60_000 }), S);
  check("...and the fee/TVL yield bar bites next", r2 === "bluechip fee/TVL 0.0001 below bluechipMinFeeTvlRatio 0.03");
  // Disprove maxTvl hypothesis: a 100M TVL pool is NOT rejected for being 'too deep'.
  const r3 = bluechipPoolGateRejectReason(jitoSolDeep({ volume: 60_000, fee_active_tvl_ratio: 0.05, tvl: 100_000_000 }), S);
  check("no maxTvl ceiling — $100M TVL pool clears the income gate once yield bars met", r3 === null);
}

console.log("\n— 2. THE FIX: paper gate PASSES the deep LST-SOL pool —");
{
  check("paper gate PASSES deep LST-SOL (income bars dropped)", twoSidedPaperBluechipGateReason(jitoSolDeep(), S) === null);
  check("paper gate PASSES even at $0 volume (dead pool = paper data, no money risk)",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ volume: 0 }), S) === null);
  check("paper gate PASSES at near-zero fee/TVL (expected for stable pair)",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ fee_active_tvl_ratio: 0.00001 }), S) === null);
}

console.log("\n— 3. STRUCTURE STILL BITES (deep-TVL / mcap / vol-ceiling kept) —");
{
  // S carries no twoSidedPaperMinTvl → the paper tvl floor falls back to bluechipMinTvl (200k).
  check("thin fake-bluechip (tvl 5k) → rejected below the paper tvl floor (fallback = bluechipMinTvl)",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ tvl: 5_000 }), S) === "two_sided_paper tvl 5000 below paper tvl floor 200000");
  check("small-cap base (mcap 1M) → rejected below bluechipMinMcap",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ token_x: { mint: JITOSOL, market_cap: 1_000_000 } }), S) === "two_sided_paper mcap 1000000 below bluechipMinMcap 50000000");
  check("wild-vol de-peg (vol 3.0) → rejected above bluechipMaxVolatility",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ volatility: 3.0 }), S) === "two_sided_paper volatility 3 above bluechipMaxVolatility 1.5");
  check("low/zero vol tolerated (GOOD stable state) → pass",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ volatility: 0 }), S) === null);
  check("missing vol tolerated (stable reads ~0) → pass",
    twoSidedPaperBluechipGateReason(jitoSolDeep({ volatility: null }), S) === null);
  // FAIL-CLOSED (anti-pattern #2)
  check("missing TVL → fail-closed reject", twoSidedPaperBluechipGateReason(jitoSolDeep({ tvl: null }), S) === "two_sided_paper_tvl_unknown");
  check("missing mcap → fail-closed reject", twoSidedPaperBluechipGateReason(jitoSolDeep({ token_x: { mint: JITOSOL } }), S) === "two_sided_paper_mcap_unknown");
  check("Number(null)===0 trap avoided: tvl null !== tvl 0 pass", twoSidedPaperBluechipGateReason(jitoSolDeep({ tvl: null }), S) !== null);
}

console.log("\n— 4. SAFETY NOT RELAXED (paper gate does not touch rug/mint/freeze/bot/top10) —");
{
  // The paper gate is surfacing-only; a bad base leg still dies at twoSidedBaseLegGateReason.
  const mintLive = { audit: { mint_disabled: false, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: false };
  const rug = { audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: true };
  check("paper gate does NOT gate on mint authority (surfacing only)", twoSidedPaperBluechipGateReason({ ...jitoSolDeep(), ...mintLive }, S) === null);
  check("but downstream base-leg gate REJECTS mint-live", twoSidedBaseLegGateReason(mintLive, S) === "mint_authority_not_renounced");
  check("and downstream base-leg gate REJECTS rugpull", twoSidedBaseLegGateReason(rug, S) === "liquidity_removal_rugpull");
  check("missing audit → fail-closed reject downstream", twoSidedBaseLegGateReason({ is_rugpull: false }, S) === "mint_authority_not_renounced");
}

console.log("\n— 5. LIVE ISOLATION (routing gated on isTwoSidedPaperCandidate) —");
{
  // The gate FUNCTION is pure/config-agnostic; isolation is enforced by the isTsp routing
  // guard (proven in test-two-sided-paper-lane). Re-assert the guard is false in live/off,
  // so the paper gate NEVER runs on the live single-side funnel.
  const active = { strategy: { twoSidedEnabled: true, twoSidedPaperOnly: true } };
  const off = { strategy: { twoSidedEnabled: false, twoSidedPaperOnly: true } };
  const rawLst = { name: "JitoSOL-SOL", token_x: { address: JITOSOL }, token_y: { address: WSOL } };
  check("lane active + DRY_RUN → isTsp true (paper gate routes)", isTwoSidedPaperCandidate(rawLst, active, "true") === true);
  check("lane active + LIVE → isTsp false (income/memecoin routing, paper gate never runs)", isTwoSidedPaperCandidate(rawLst, active, "false") === false);
  check("flag off + DRY_RUN → isTsp false (paper gate never runs)", isTwoSidedPaperCandidate(rawLst, off, "true") === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
