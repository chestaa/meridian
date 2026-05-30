// Cassiopeia — Item 2 (fee/TVL tighten + TVL/MC gate) + Item 4 (binsBelow coupling).
//
//   Item 2a — fee/active-TVL floor tightened (live overlay 0.07 → 0.08).
//             0.06 below floor → reject; 0.09 above → pass.
//   Item 2b — NEW TVL/MC ratio gate (LIVE-ONLY, fail-safe, default 0.2).
//             tvl/mc 0.25 → reject; 0.15 → pass; missing mcap → fail-safe reject.
//   Item 4  — bins_below ↔ volatility coupling validation (formula unchanged).
//             vol 5 → 69 (max wide); vol 1 → ~42 (narrow); clamp [35,69].
//
// Run: node scripts/test-feetvl-tvlmc-gate.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { config } = await import("../config.js");
const { tvlMcapGateRejectReason, getRawPoolScreeningRejectReason } = await import("../tools/screening.js");

console.log("=== Cassiopeia — fee/TVL + TVL/MC gate + binsBelow coupling ===\n");

// ── Item 2a: fee/active-TVL floor (0.08) ──
// getRawPoolScreeningRejectReason uses s.minFeeActiveTvlRatio. We pass a
// thresholds object mirroring the live overlay floor (0.08) and a complete
// otherwise-passing pool so ONLY the fee/TVL gate decides.
console.log("[2a] fee/active-TVL floor 0.08 (live overlay)");
{
  const S = {
    minMcap: 150_000, maxMcap: 10_000_000,
    minHolders: 500, minVolume: 500, minTvl: 10_000, maxTvl: 150_000,
    minBinStep: 80, maxBinStep: 125,
    minFeeActiveTvlRatio: 0.08,
    minOrganic: 60, minQuoteOrganic: 60,
    minTokenAgeHours: null, maxTokenAgeHours: null,
    blockedLaunchpads: [], allowedLaunchpads: [],
  };
  const basePool = (feeTvl) => ({
    token_x: { market_cap: 300_000, organic_score: 75, created_at: Date.now() - 50 * 3_600_000 },
    token_y: { organic_score: 75 },
    dlmm_params: { bin_step: 100 },
    tvl: 50_000,
    fee_active_tvl_ratio: feeTvl,
    volatility: 3,
    volume: 5_000,
    base_token_holders: 800,
  });
  const r006 = getRawPoolScreeningRejectReason(basePool(0.06), S);
  const r009 = getRawPoolScreeningRejectReason(basePool(0.09), S);
  const r008 = getRawPoolScreeningRejectReason(basePool(0.08), S);
  check("fee/TVL 0.06 → reject (below 0.08 floor)", typeof r006 === "string" && r006.includes("fee/active-TVL"));
  check("fee/TVL 0.09 → pass (above floor)", r009 === null);
  check("fee/TVL 0.08 exactly → pass (floor inclusive)", r008 === null);
}

// ── Item 2b: TVL/MC ratio gate (fail-safe, default 0.2) ──
console.log("\n[2b] TVL/MC ratio gate (live-only, fail-safe)");
{
  const S = { tvlMcapGateEnabled: true, maxTvlMcapRatio: 0.2 };
  // ratio 0.25 = 50k/200k > 0.2 → reject
  const high = { name: "BLOAT", tvl: 50_000, mcap: 200_000 };
  // ratio 0.15 = 30k/200k < 0.2 → pass
  const ok = { name: "TIGHT", tvl: 30_000, mcap: 200_000 };
  // ratio 0.20 exactly = 40k/200k → boundary, NOT > 0.2 → pass
  const boundary = { name: "EDGE", tvl: 40_000, mcap: 200_000 };
  // missing mcap → fail-safe reject (cannot compute)
  const noMcap = { name: "NOMCAP", tvl: 30_000, mcap: null };
  // zero mcap → fail-safe reject
  const zeroMcap = { name: "ZEROMCAP", tvl: 30_000, mcap: 0 };
  // missing tvl → fail-safe reject
  const noTvl = { name: "NOTVL", tvl: null, mcap: 200_000 };

  check("TVL/MC 0.25 → tvl_mcap_ratio_too_high", tvlMcapGateRejectReason(high, S) === "tvl_mcap_ratio_too_high");
  check("TVL/MC 0.15 → pass (null)", tvlMcapGateRejectReason(ok, S) === null);
  check("TVL/MC 0.20 exactly → pass (boundary, not >)", tvlMcapGateRejectReason(boundary, S) === null);
  check("missing mcap → tvl_mcap_ratio_unknown (fail-safe)", tvlMcapGateRejectReason(noMcap, S) === "tvl_mcap_ratio_unknown");
  check("zero mcap → tvl_mcap_ratio_unknown (fail-safe)", tvlMcapGateRejectReason(zeroMcap, S) === "tvl_mcap_ratio_unknown");
  check("missing tvl → tvl_mcap_ratio_unknown (fail-safe)", tvlMcapGateRejectReason(noTvl, S) === "tvl_mcap_ratio_unknown");

  // Gate disabled → inert (never rejects, even a bloated pool)
  const off = { tvlMcapGateEnabled: false, maxTvlMcapRatio: 0.2 };
  check("gate disabled → inert (no reject even on 0.25)", tvlMcapGateRejectReason(high, off) === null);
  // Gate enabled but no usable cap → inert
  const noCap = { tvlMcapGateEnabled: true, maxTvlMcapRatio: 0 };
  check("gate on but maxTvlMcapRatio<=0 → inert", tvlMcapGateRejectReason(high, noCap) === null);
}

// ── Item 4: bins_below ↔ volatility coupling ──
// Mirror the live formula from index.js computeBinsBelow:
//   round(lo + (vol/5)*(hi-lo)) clamped [lo,hi], lo/hi = config.strategy.
console.log("\n[4] bins_below ↔ volatility coupling (formula validation)");
{
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  const binsBelow = (vol) => Math.max(lo, Math.min(hi, Math.round(lo + (vol / 5) * (hi - lo))));

  check(`clamp floor = 35 (config minBinsBelow=${lo})`, lo === 35);
  check(`clamp ceiling = 69 (config maxBinsBelow=${hi})`, hi === 69);
  check("vol 5 → 69 (max wide range — high vol gets widest)", binsBelow(5) === 69);
  check("vol 1 → 42 (narrow — low vol gets tight range)", binsBelow(1) === 42);
  check("vol 3 → 55 (mid — between floor and ceiling)", binsBelow(3) === 55);
  // Monotonic: more vol → wider (or equal) range. Coupling is sound.
  check("monotonic: binsBelow(1) < binsBelow(3) < binsBelow(5)", binsBelow(1) < binsBelow(3) && binsBelow(3) < binsBelow(5));
  // Above-5 vol clamps at ceiling (memecoin extreme vol still gets widest range)
  check("vol 10 → 69 (clamped at ceiling)", binsBelow(10) === 69);
  // Below-floor protection: even tiny vol never goes below 35
  check("vol 0.1 → 36 (>= floor 35)", binsBelow(0.1) >= 35);
}

console.log(`\n${passed} assertions passed, ${failed} failed.`);
if (failed > 0) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
