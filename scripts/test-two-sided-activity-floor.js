// Cassiopeia 👁️ — Two-sided PAPER-lane ACTIVITY floor (S2 paper-lane blocker #2).
//
// WHAT THIS PROVES:
//   1. THE BLOCKER — with the income yield bars dropped, a genuinely DEAD pool (the deep
//      JitoSOL-SOL $2.7M-TVL / $0-vol zombie the probe found ranking #1 by TVL) would
//      pass the surfacing gate and reach the judge, which rejects it every cycle → the
//      sleeve burns judge cost and never accrues data (infinite time-to-data).
//   2. THE FIX — twoSidedPaperActivityFloorReason drops the $0-vol zombie on a MINIMAL
//      "is it trading at all" volume floor (default $500), FAR below the income bar.
//   3. STILL ALIVE (anti-dormancy) — a pool with real churn (vol >= $500) PASSES; the
//      floor does not zero a funnel that contains live pools.
//   4. FAIL-CLOSED (anti-pattern #2) — an ACTIVE floor with missing volume/fee-TVL data
//      REJECTS (never default a dead/unknown pool into the judge set); Number(null)===0
//      trap avoided (missing !== genuine 0, both reject but via distinct reasons).
//   5. INDEPENDENCE + OFF — each floor fires only when its config value > 0; 0/absent =
//      disabled (backward-compatible with the pre-floor paper gate).
//   6. COMPOSITION — twoSidedPaperBluechipGateReason enforces structure (TVL/mcap/vol-
//      ceiling) FIRST, then the activity floor; both bite through the one routing point.
//   7. LIVE-PROBE REPLAY — the exact 22-candidate distribution from the 2026-07-18 live
//      probe: default $500 floor keeps 3, drops the deep JitoSOL-SOL zombie; the 0.03
//      income bar would zero the funnel (anti-dormancy regression guard).
//
// Run: node scripts/test-two-sided-activity-floor.js

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
  twoSidedPaperActivityFloorReason,
  twoSidedPaperBluechipGateReason,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

// Structure thresholds (mirror live bluechip defaults) + the new activity floors.
const S = {
  bluechipMinTvl: 200_000,
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
  twoSidedPaperMinVolume: 500,      // default ON
  twoSidedPaperMinFeeTvlRatio: 0,   // default OFF
};
// Floors fully OFF (pre-fix behavior).
const S_OFF = { ...S, twoSidedPaperMinVolume: 0, twoSidedPaperMinFeeTvlRatio: 0 };

// The deep JitoSOL-SOL zombie the live probe found: $2.7M TVL, $0 vol, 0 fee/TVL, low vol,
// huge mcap. Structurally a "bluechip" but DEAD — the corpse the funnel used to point at.
function jitoSolDead(extra = {}) {
  return {
    name: "JitoSOL-SOL",
    tvl: 2_717_097,
    volume: 0,
    fee_active_tvl_ratio: 0,
    volatility: 0.05,
    token_x: { mint: JITOSOL, symbol: "JitoSOL", market_cap: 2_500_000_000 },
    token_y: { mint: WSOL, symbol: "SOL" },
    ...extra,
  };
}

console.log("\n— 1. THE BLOCKER: dead pool passes when the activity floor is OFF —");
{
  check("floor OFF → dead $0-vol pool passes activity fn (pre-fix behavior)",
    twoSidedPaperActivityFloorReason(jitoSolDead(), S_OFF) === null);
  check("floor OFF → surfacing gate passes the dead pool (would reach judge)",
    twoSidedPaperBluechipGateReason(jitoSolDead(), S_OFF) === null);
}

console.log("\n— 2. THE FIX: default $500 floor drops the $0-vol zombie —");
{
  check("activity fn REJECTS $0-vol JitoSOL-SOL zombie",
    twoSidedPaperActivityFloorReason(jitoSolDead(), S) === "two_sided_paper volume 0 below twoSidedPaperMinVolume 500");
  check("surfacing gate REJECTS it (activity floor composed in)",
    twoSidedPaperBluechipGateReason(jitoSolDead(), S) === "two_sided_paper volume 0 below twoSidedPaperMinVolume 500");
  check("a trickle-vol pool ($374) still rejected (below $500 floor)",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 374 }), S) !== null);
  check("just below floor ($499) rejected", twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 499 }), S) !== null);
}

console.log("\n— 3. ANTI-DORMANCY: live pools with real churn PASS —");
{
  check("vol exactly at floor ($500) passes", twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 500 }), S) === null);
  check("the live cbBTC-SOL $6,759-vol pool passes", twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 6759 }), S) === null);
  check("the live cbBTC-SOL $1,335-vol pool passes", twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 1335 }), S) === null);
  check("the live USDC-SOL $734-vol pool passes", twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 734 }), S) === null);
  // full gate: a live, structurally-sound pool clears end to end
  check("live churning pool clears the full surfacing gate",
    twoSidedPaperBluechipGateReason(jitoSolDead({ volume: 6759, fee_active_tvl_ratio: 0.00294 }), S) === null);
}

console.log("\n— 4. FAIL-CLOSED (anti-pattern #2) —");
{
  check("floor ON + missing volume → two_sided_paper_volume_unknown",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: null }), S) === "two_sided_paper_volume_unknown");
  check("floor ON + undefined volume field → two_sided_paper_volume_unknown",
    twoSidedPaperActivityFloorReason({ tvl: 2_717_097 }, S) === "two_sided_paper_volume_unknown");
  check("floor ON + empty-string volume → two_sided_paper_volume_unknown (strictNumeric)",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: "" }), S) === "two_sided_paper_volume_unknown");
  // Number(null)===0 trap: missing must NOT be silently read as a genuine 0.
  const missing = twoSidedPaperActivityFloorReason(jitoSolDead({ volume: null }), S);
  const genuineZero = twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 0 }), S);
  check("missing volume reason != genuine-0 reason (no null->0 fabrication)", missing !== genuineZero);
  check("...missing = *_unknown", missing === "two_sided_paper_volume_unknown");
  check("...genuine 0 = below-floor (a real, measured dead pool)", genuineZero.startsWith("two_sided_paper volume 0 below"));
  // volume_window fallback shape
  check("reads volume_window when volume absent", twoSidedPaperActivityFloorReason({ volume_window: 800 }, S) === null);
}

console.log("\n— 5. fee/TVL floor: OFF by default, gates fail-closed when enabled —");
{
  check("fee/TVL floor OFF (0) → not gated (only volume applies)",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 1000, fee_active_tvl_ratio: 0 }), S) === null);
  const Sfee = { ...S, twoSidedPaperMinFeeTvlRatio: 0.0005 };
  check("fee/TVL floor ON + below → rejected",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 1000, fee_active_tvl_ratio: 0.0001 }), Sfee)
      === "two_sided_paper fee/TVL 0.0001 below twoSidedPaperMinFeeTvlRatio 0.0005");
  check("fee/TVL floor ON + above → passes",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 1000, fee_active_tvl_ratio: 0.001 }), Sfee) === null);
  check("fee/TVL floor ON + missing → fail-closed reject",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 1000, fee_active_tvl_ratio: null }), Sfee)
      === "two_sided_paper_fee_tvl_unknown");
  // volume floor is checked FIRST (primary): a pool failing both reports volume.
  check("volume floor takes precedence over fee/TVL floor",
    twoSidedPaperActivityFloorReason(jitoSolDead({ volume: 10, fee_active_tvl_ratio: 0.0001 }), Sfee)
      .startsWith("two_sided_paper volume"));
}

console.log("\n— 6. COMPOSITION: structure gates bite BEFORE the activity floor —");
{
  // A thin fake-bluechip pool with $0 vol is rejected on TVL (structure) first, NOT on
  // the activity floor — structure/stability precedence is preserved.
  check("thin pool ($5k TVL) → rejected on bluechipMinTvl first",
    twoSidedPaperBluechipGateReason(jitoSolDead({ tvl: 5_000 }), S) === "two_sided_paper tvl 5000 below bluechipMinTvl 200000");
  check("small-cap base → rejected on bluechipMinMcap first",
    twoSidedPaperBluechipGateReason(jitoSolDead({ token_x: { mint: JITOSOL, market_cap: 1_000_000 } }), S)
      === "two_sided_paper mcap 1000000 below bluechipMinMcap 50000000");
  check("wild-vol de-peg → rejected on bluechipMaxVolatility before activity",
    twoSidedPaperBluechipGateReason(jitoSolDead({ volatility: 3.0 }), S)
      === "two_sided_paper volatility 3 above bluechipMaxVolatility 1.5");
  check("structure OK + dead vol → activity floor is the reason",
    twoSidedPaperBluechipGateReason(jitoSolDead(), S).startsWith("two_sided_paper volume"));
}

console.log("\n— 7. LIVE-PROBE REPLAY (2026-07-18 distribution — anti-dormancy guard) —");
{
  // The 22 surfaced two-sided paper candidates, (volume, feeTvl) from the live probe.
  const universe = [
    { volume: 6759, fee_active_tvl_ratio: 0.00294 }, // cbBTC-SOL — live
    { volume: 1335, fee_active_tvl_ratio: 0.00187 }, // cbBTC-SOL — live
    { volume: 734,  fee_active_tvl_ratio: 0.00053 }, // USDC-SOL  — live
    { volume: 451,  fee_active_tvl_ratio: 0.00058 }, // JLP-SOL
    { volume: 374,  fee_active_tvl_ratio: 0.00734 }, // cbBTC-SOL
    { volume: 175,  fee_active_tvl_ratio: 0.00454 }, // JLP-SOL
    { volume: 39,   fee_active_tvl_ratio: 0.00051 }, // cbBTC-SOL
    { volume: 6,    fee_active_tvl_ratio: 0.00001 }, // mSOL-SOL
    { volume: 2,    fee_active_tvl_ratio: 0.00134 }, // cbBTC-SOL
    { volume: 0,    fee_active_tvl_ratio: 0.00008 }, // USDC-SOL
    { volume: 0,    fee_active_tvl_ratio: 0 },       // JitoSOL-SOL $2.7M zombie
    // remaining 11 pools all $0 vol / 0 fee-TVL
    ...Array.from({ length: 11 }, () => ({ volume: 0, fee_active_tvl_ratio: 0 })),
  ];
  // structural fields so only the activity floor decides
  const full = universe.map((u) => ({
    tvl: 2_717_097, volatility: 0.05, token_x: { mint: JITOSOL, market_cap: 2_500_000_000 }, token_y: { mint: WSOL }, ...u,
  }));
  check("universe has 22 candidates", full.length === 22);
  const surviveDefault = full.filter((p) => twoSidedPaperBluechipGateReason(p, S) === null).length;
  check("default $500 floor keeps EXACTLY 3 (not 0 → anti-dormancy satisfied)", surviveDefault === 3);
  const surviveOff = full.filter((p) => twoSidedPaperBluechipGateReason(p, S_OFF) === null).length;
  check("floor OFF keeps all 22 (incl. the zombie → judge waste)", surviveOff === 22);
  // The income bar (0.03) would zero the funnel — the regression the fix must NOT re-introduce.
  const Sincome = { ...S, twoSidedPaperMinVolume: 50_000 };
  const surviveIncome = full.filter((p) => twoSidedPaperBluechipGateReason(p, Sincome) === null).length;
  check("re-imposing the $50k income volume bar zeroes the funnel (why we DON'T)", surviveIncome === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
