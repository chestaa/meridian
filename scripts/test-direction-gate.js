// Cassiopeia — Track-B tests (B2 direction gate + B1 fee-density ranking / edge floor).
//
// B2 — directionGateRejectReason (pure, FAIL-OPEN):
//   A single-side-SOL narrow position deployed into a token ALREADY falling at entry
//   has an asymmetric payoff (limited bounce, full bleed). This gate PAUSES such a
//   deploy. It is a DIRECTIONAL/QUALITY gate (not rug/safety) → fails OPEN on missing
//   data (never a blind freeze), following the marketRegimeGate precedent.
//   Covers:
//     - gate OFF                                   → no-op (null) even on a downtrend
//     - measured downtrend + flow-confirm OFF      → pause (price-only reject)
//     - measured downtrend + bearish flow          → pause (flow confirms)
//     - measured downtrend + bullish flow          → allow (buyers stepping in)
//     - measured downtrend + flow ON but flow MISSING → FAIL-OPEN allow
//     - price above threshold                       → allow (not a downtrend)
//     - price_change_pct missing/null              → FAIL-OPEN allow (never freeze)
//     - price_change_pct = 0 (genuine flat)        → allow (strictNumeric, not fabricated)
//     - threshold boundary (exactly at)            → inclusive pause
//     - respects directionRequireFlowConfirm toggle
//
// B1 — fee-density ranking + edge floor 0.10:
//     - feeTvlHighBonus floats a fee-dense pool above a sparse one (scoreCandidate)
//     - bonus is funnel-neutral (>= 0, never a reject)
//     - edge filter floor 0.10 ADMITS a [0.10,0.20) pool that the old 0.2 floor rejected
//
// Run: node scripts/test-direction-gate.js

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
  directionGateRejectReason,
  feeTvlHighBonus,
  scoreCandidate,
  edgeFilterRejectReason,
} = await import("../tools/screening.js");

// Base config for the direction gate (mirrors config.js defaults).
const DG = {
  directionGateEnabled: true,
  directionMaxNegPriceChangePct: -4,
  directionRequireFlowConfirm: true,
  directionMinBuyShare: 0.40,
};

// ─── B2: directionGateRejectReason ──────────────────────────────────
console.log("\nB2 — directionGateRejectReason (pure, fail-open):");

// gate OFF → no-op even on a clear downtrend
check("gate OFF → null (no-op) even with -20% price",
  directionGateRejectReason({ price_change_pct: -20, buy_vol: 10, sell_vol: 90 }, { ...DG, directionGateEnabled: false }) === null);

// downtrend + flow-confirm OFF → price-only pause
check("downtrend -10% + flow-confirm OFF → pause",
  directionGateRejectReason({ price_change_pct: -10 }, { ...DG, directionRequireFlowConfirm: false }) === "direction_downtrend_at_entry");

// downtrend + bearish flow (buy_share 0.10 < 0.40) → pause
check("downtrend -10% + bearish flow (10/90) → pause",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 10, sell_vol: 90 }, DG) === "direction_downtrend_at_entry");

// downtrend + bullish flow (buy_share 0.70 >= 0.40) → allow (buyers stepping in)
check("downtrend -10% + bullish flow (70/30) → allow",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 70, sell_vol: 30 }, DG) === null);

// downtrend + flow-confirm ON but flow MISSING → FAIL-OPEN allow
check("downtrend -10% + flow-confirm ON but flow missing → FAIL-OPEN allow",
  directionGateRejectReason({ price_change_pct: -10 }, DG) === null);
check("downtrend -10% + flow-confirm ON but buy_vol null → FAIL-OPEN allow",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: null, sell_vol: 50 }, DG) === null);
check("downtrend -10% + flow-confirm ON but zero total flow → FAIL-OPEN allow",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 0, sell_vol: 0 }, DG) === null);

// price above threshold → allow (not a downtrend at entry)
check("price +5% → allow (uptrend)",
  directionGateRejectReason({ price_change_pct: 5, buy_vol: 10, sell_vol: 90 }, DG) === null);
check("price -3.9% (just inside band) → allow",
  directionGateRejectReason({ price_change_pct: -3.9 }, { ...DG, directionRequireFlowConfirm: false }) === null);

// threshold boundary: exactly at -4 → inclusive pause (price-only mode)
check("price -4% (exact threshold) + flow-confirm OFF → pause (inclusive)",
  directionGateRejectReason({ price_change_pct: -4 }, { ...DG, directionRequireFlowConfirm: false }) === "direction_downtrend_at_entry");

// FAIL-OPEN on missing price_change_pct (never a freeze)
check("price_change_pct undefined → FAIL-OPEN allow",
  directionGateRejectReason({ buy_vol: 10, sell_vol: 90 }, { ...DG, directionRequireFlowConfirm: false }) === null);
check("price_change_pct null → FAIL-OPEN allow",
  directionGateRejectReason({ price_change_pct: null }, { ...DG, directionRequireFlowConfirm: false }) === null);
check("price_change_pct NaN string → FAIL-OPEN allow",
  directionGateRejectReason({ price_change_pct: "n/a" }, { ...DG, directionRequireFlowConfirm: false }) === null);

// strictNumeric: a GENUINE 0% (flat) must NOT be treated as missing, and 0 > -4 → allow
check("price_change_pct = 0 (genuine flat) → allow (not fabricated, 0 > -4)",
  directionGateRejectReason({ price_change_pct: 0 }, { ...DG, directionRequireFlowConfirm: false }) === null);

// flow-confirm toggle respected: same bearish flow, confirm ON pauses; a bullish flow ON allows
check("toggle: bearish flow, confirm ON → pause",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 5, sell_vol: 95 }, { ...DG, directionRequireFlowConfirm: true }) === "direction_downtrend_at_entry");
check("toggle: same bearish flow, confirm OFF → pause (price-only, flow ignored)",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 5, sell_vol: 95 }, { ...DG, directionRequireFlowConfirm: false }) === "direction_downtrend_at_entry");

// buy_share exactly at min (0.40) → NOT below → allow
check("downtrend + buy_share exactly 0.40 (40/60) → allow (not below min)",
  directionGateRejectReason({ price_change_pct: -10, buy_vol: 40, sell_vol: 60 }, DG) === null);

// ─── B1: fee-density ranking + edge floor 0.10 ──────────────────────
console.log("\nB1 — fee-density ranking (feeTvlHighBonus) + edge floor 0.10:");

const BONUS_CFG = {
  feeTvlHighBonusEnabled: true,
  feeTvlHighBonusWeight: 250,
  feeTvlHighBonusFloor: 0.10,
  feeTvlHighBonusTarget: 0.20,
};

const densePool  = { fee_active_tvl_ratio: 0.20 };  // at the "king" target → full bonus
const midPool    = { fee_active_tvl_ratio: 0.15 };  // midway → partial bonus
const sparsePool = { fee_active_tvl_ratio: 0.10 };  // at floor → 0 bonus

// bonus monotonic in fee density
check("feeTvlHighBonus: dense (0.20) > mid (0.15) > sparse (0.10)",
  feeTvlHighBonus(densePool, BONUS_CFG) > feeTvlHighBonus(midPool, BONUS_CFG)
  && feeTvlHighBonus(midPool, BONUS_CFG) > feeTvlHighBonus(sparsePool, BONUS_CFG));
check("feeTvlHighBonus: at target 0.20 → full weight 250",
  feeTvlHighBonus(densePool, BONUS_CFG) === 250);
check("feeTvlHighBonus: at floor 0.10 → 0",
  feeTvlHighBonus(sparsePool, BONUS_CFG) === 0);

// bonus is funnel-neutral: never negative, never a reject (it returns a number >= 0)
check("feeTvlHighBonus: always >= 0 (funnel-neutral, never penalize)",
  feeTvlHighBonus(densePool, BONUS_CFG) >= 0
  && feeTvlHighBonus(sparsePool, BONUS_CFG) >= 0
  && feeTvlHighBonus({ fee_active_tvl_ratio: null }, BONUS_CFG) === 0);

// scoreCandidate floats the fee-dense pool above the sparse one when the bonus is on.
// (identical pools apart from fee_active_tvl_ratio, so any ordering delta is the bonus)
const dense2  = { name: "DENSE",  tvl: 30000, volume: 40000, fee_active_tvl_ratio: 0.20, mcap: 500000, volatility: 4, holders: 800, organic_score: 75 };
const sparse2 = { name: "SPARSE", tvl: 30000, volume: 40000, fee_active_tvl_ratio: 0.10, mcap: 500000, volatility: 4, holders: 800, organic_score: 75 };
check("scoreCandidate: fee-dense pool ranks ABOVE sparse pool when bonus ON",
  scoreCandidate(dense2, BONUS_CFG) > scoreCandidate(sparse2, BONUS_CFG));

// edge filter floor 0.10 ADMITS a [0.10,0.20) pool (the whole point of B1's lowering).
const EDGE_CFG = {
  edgeFilterEnabled: true,
  edgeFilterFtvlMin: 0.10,   // B1: lowered from 0.2
  edgeFilterFtvlMax: 1.0,
  edgeFilterMinVolatility: 2.5,
};
// a pool at ftvl 0.14, vol 3.0 — inside [0.10,1.0) and above vol floor → ADMITTED
check("edge floor 0.10: pool ftvl 0.14 vol 3.0 → ADMITTED (null)",
  edgeFilterRejectReason({ fee_active_tvl_ratio: 0.14, volatility: 3.0 }, EDGE_CFG) === null);
// the SAME pool under the OLD 0.2 floor → rejected below-band (proves the floor moved)
check("old floor 0.2: same pool ftvl 0.14 → REJECTED below-band (regression guard)",
  edgeFilterRejectReason({ fee_active_tvl_ratio: 0.14, volatility: 3.0 }, { ...EDGE_CFG, edgeFilterFtvlMin: 0.2 }) === "edge_filter_ftvl_below_band");
// floor is still a floor: a pool below 0.10 is still rejected (not a total removal)
check("edge floor 0.10: pool ftvl 0.08 → still REJECTED below-band",
  edgeFilterRejectReason({ fee_active_tvl_ratio: 0.08, volatility: 3.0 }, EDGE_CFG) === "edge_filter_ftvl_below_band");
// vol floor + fail-closed still intact (edge filter is a safety gate, unchanged)
check("edge: missing volatility → fail-closed reject (unchanged)",
  edgeFilterRejectReason({ fee_active_tvl_ratio: 0.14, volatility: null }, EDGE_CFG) === "edge_filter_data_unknown");

console.log(`\n${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} assertion(s) failed`);
console.log("All Track-B (B1 + B2) assertions passed.");
