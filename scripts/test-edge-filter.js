// Cassiopeia — H3 edge filter (2026-06-28). The safety paid for by re-opening the
// memecoin DEPLOY lane. Keeps only the positive-EV 2x2 cell from the 59-real-trade
// brain analysis: fee_active_tvl_ratio ∈ [0.2, 1.0) AND volatility ≥ 2.5.
// (flips in-sample book −$1.74 → +$9.36, stop-losses 14→3.)
//
// Run: node scripts/test-edge-filter.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { edgeFilterRejectReason } = await import("../tools/screening.js");

// Effective thresholds with the filter ON, at default band.
const sOn = {
  edgeFilterEnabled: true,
  edgeFilterFtvlMin: 0.2,
  edgeFilterFtvlMax: 1.0,
  edgeFilterMinVolatility: 2.5,
};
const sOff = { ...sOn, edgeFilterEnabled: false };

console.log("=== Cassiopeia — H3 edge filter ===\n");

// ── Disabled = byte-for-byte no-op (opt-in default) ──
console.log("── disabled (default OFF) ──");
check("disabled → null even on a would-reject pool", edgeFilterRejectReason({ fee_active_tvl_ratio: 5.0, volatility: 0.1 }, sOff) === null);
check("undefined s → null (inert)", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 3 }, undefined) === null);

// ── Positive cell (the +EV intersection) passes ──
console.log("\n── positive cell passes ──");
check("ftvl 0.5, vol 3.0 → pass", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 3.0 }, sOn) === null);
check("ftvl 0.2 (lower edge, inclusive), vol 2.5 (floor, inclusive) → pass", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.2, volatility: 2.5 }, sOn) === null);
check("ftvl 0.99 (just under upper), vol 8 → pass", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.99, volatility: 8 }, sOn) === null);

// ── ftvl band edges (the inverted king-line: ≥1.0 is NEGATIVE) ──
console.log("\n── ftvl band ──");
check("ftvl 0.19 below min → ftvl_below_band", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.19, volatility: 5 }, sOn) === "edge_filter_ftvl_below_band");
check("ftvl 1.0 (upper exclusive) → ftvl_above_band", edgeFilterRejectReason({ fee_active_tvl_ratio: 1.0, volatility: 5 }, sOn) === "edge_filter_ftvl_above_band");
check("ftvl 2.5 (extreme spike) → ftvl_above_band (the n=9 EV−0.50 cell)", edgeFilterRejectReason({ fee_active_tvl_ratio: 2.5, volatility: 7 }, sOn) === "edge_filter_ftvl_above_band");

// ── volatility floor (slow-bleed band) ──
console.log("\n── volatility floor ──");
check("vol 2.49 below floor → volatility_below_floor", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 2.49 }, sOn) === "edge_filter_volatility_below_floor");
check("vol 0.5 (dead slow-bleed) → volatility_below_floor", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 0.5 }, sOn) === "edge_filter_volatility_below_floor");

// ── FAIL-CLOSED: missing data → reject, never default to safe (anti-pattern #2) ──
console.log("\n── fail-closed (anti-pattern #2) ──");
check("missing ftvl → data_unknown", edgeFilterRejectReason({ volatility: 5 }, sOn) === "edge_filter_data_unknown");
check("null ftvl → data_unknown (NOT coerced to 0)", edgeFilterRejectReason({ fee_active_tvl_ratio: null, volatility: 5 }, sOn) === "edge_filter_data_unknown");
check("missing vol → data_unknown", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5 }, sOn) === "edge_filter_data_unknown");
check("null vol → data_unknown (NOT coerced to 0)", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: null }, sOn) === "edge_filter_data_unknown");
check("NaN ftvl → data_unknown", edgeFilterRejectReason({ fee_active_tvl_ratio: NaN, volatility: 5 }, sOn) === "edge_filter_data_unknown");
check("Infinity vol → data_unknown", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: Infinity }, sOn) === "edge_filter_data_unknown");
// strictNumeric parses a numeric string (codebase contract) — a valid reading, not missing.
check("numeric-string ftvl '0.5' is a valid reading → pass", edgeFilterRejectReason({ fee_active_tvl_ratio: "0.5", volatility: 5 }, sOn) === null);
check("non-numeric string ftvl → data_unknown", edgeFilterRejectReason({ fee_active_tvl_ratio: "abc", volatility: 5 }, sOn) === "edge_filter_data_unknown");

// ── FAIL-CLOSED: misconfigured bound → reject rather than pass everything ──
console.log("\n── fail-closed bounds ──");
check("missing ftvlMin → data_unknown (don't pass-all on misconfig)", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 5 }, { edgeFilterEnabled: true, edgeFilterFtvlMax: 1.0, edgeFilterMinVolatility: 2.5 }) === "edge_filter_data_unknown");

// ── Tunability: a different band reshapes the gate ──
console.log("\n── tunable band ──");
const sTight = { edgeFilterEnabled: true, edgeFilterFtvlMin: 0.3, edgeFilterFtvlMax: 0.8, edgeFilterMinVolatility: 6.0 };
check("ftvl 0.25 fails tighter min 0.3", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.25, volatility: 7 }, sTight) === "edge_filter_ftvl_below_band");
check("vol 4 fails tighter floor 6.0 (the vol≥6 won-all cell)", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 4 }, sTight) === "edge_filter_volatility_below_floor");
check("ftvl 0.5 vol 6 passes tighter band", edgeFilterRejectReason({ fee_active_tvl_ratio: 0.5, volatility: 6 }, sTight) === null);

// Sanity: condensed pool uses the same field names the gate reads.
assert.equal(typeof edgeFilterRejectReason, "function");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
