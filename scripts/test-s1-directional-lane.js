/**
 * Strategy S1 — Directional Memecoin lane fix. Cassiopeia 👁️
 *
 * GROUND TRUTH (Lyra, 115 real closed trades, wallet-truth realized_sol_delta):
 *   - fee/TVL EV is INVERTED vs "high = king": bucket [0.7,∞) WORST (-0.1137, n=42);
 *     only [0.4,0.7) non-negative (+0.0002). The old feeTvlHighBonus RAMP steered the
 *     judge slice toward the losing tail. Fix: kill the ramp (default OFF) + a BAND
 *     preference bonus that credits ONLY [0.4,0.7) and ZERO outside (incl. high tail).
 *   - volatility EV: ONLY 4.5+ positive (+0.0021); [2.5,3.5) (n=47) still -0.0032.
 *     Floor stays 3.0 (anti-dormancy — a hard 3.5 cut the funnel to 1 pool). Fix: a
 *     ranking ramp 3.5→4.5 floats the +EV bucket up WITHOUT a hard cut.
 *
 * Contract under test:
 *   feeTvlBandPreferenceBonus:
 *     - inside [low,high] → full weight; below low OR above high → 0 (incl. losing tail)
 *     - missing/non-finite/negative fee/TVL → 0 (NEUTRAL, anti-pattern #2)
 *     - flag OFF (default) → 0; NEVER a gate (returns a number only, never rejects)
 *   volatilityHighBonus:
 *     - >= target → full weight; <= floor → 0; ramp between; capped above target
 *     - missing/non-finite/non-positive vol → 0 (NEUTRAL, anti-pattern #2)
 *     - reads pool.volatility, falls back to pool.volatilityScore
 *     - flag OFF (default) → 0; NEVER a gate
 *   scoreCandidate integration: band + vol bonuses influence ranking when enabled
 *   directionGate (verify effective live config): fires at price <= -4 price-only mode
 *
 * Run: node scripts/test-s1-directional-lane.js
 */
import assert from "assert";
import {
  feeTvlBandPreferenceBonus,
  volatilityHighBonus,
  feeTvlHighBonus,
  scoreCandidate,
  directionGateRejectReason,
} from "../tools/screening.js";

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

const BAND_ON = {
  feeTvlBandPreferenceEnabled: true, feeTvlBandPreferenceWeight: 400,
  feeTvlBandLow: 0.40, feeTvlBandHigh: 0.70,
};
const BAND_OFF = { ...BAND_ON, feeTvlBandPreferenceEnabled: false };

const VOL_ON = {
  volatilityHighBonusEnabled: true, volatilityHighBonusWeight: 300,
  volatilityHighBonusFloor: 3.5, volatilityHighBonusTarget: 4.5,
};
const VOL_OFF = { ...VOL_ON, volatilityHighBonusEnabled: false };

console.log("\nStrategy S1 — directional lane fix — Cassiopeia 👁️\n");

// ── feeTvlBandPreferenceBonus ────────────────────────────────────────────────
console.log("feeTvlBandPreferenceBonus (Lyra-inverted):");

// inside the sweet band → full weight
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.50 }, BAND_ON), 400);
ok("inside band (0.50) -> full weight 400");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.40 }, BAND_ON), 400);
ok("at low edge (0.40) -> full weight (inclusive)");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.70 }, BAND_ON), 400);
ok("at high edge (0.70) -> full weight (inclusive)");

// LOSING tail gets ZERO — the core inversion fix
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.90 }, BAND_ON), 0);
ok("high losing tail (0.90 > 0.70) -> 0 credit (NOT steered to loser)");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 5.0 }, BAND_ON), 0);
ok("extreme fee/TVL (5.0) -> 0 credit");
// below band → 0
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.20 }, BAND_ON), 0);
ok("below band (0.20) -> 0 credit");

// fail-safe neutral
assert.strictEqual(feeTvlBandPreferenceBonus({}, BAND_ON), 0);
ok("missing fee/TVL -> 0 (NEUTRAL, anti-pattern #2)");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: null }, BAND_ON), 0);
ok("null fee/TVL -> 0 (NEUTRAL)");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: "abc" }, BAND_ON), 0);
ok("non-finite fee/TVL -> 0 (NEUTRAL)");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: -1 }, BAND_ON), 0);
ok("negative fee/TVL -> 0 (NEUTRAL)");

// flag off / misconfig
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.50 }, BAND_OFF), 0);
ok("flag OFF (default) -> 0");
assert.strictEqual(feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.50 }, null), 0);
ok("null cfg -> 0");
assert.strictEqual(
  feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.50 }, { ...BAND_ON, feeTvlBandHigh: 0.40 }),
  0);
ok("misconfig high<=low -> 0");

// NEVER a gate — always a number
assert.strictEqual(typeof feeTvlBandPreferenceBonus({ fee_active_tvl_ratio: 0.9 }, BAND_ON), "number");
ok("returns a number, never a reject string (NEVER a gate)");

// ── volatilityHighBonus ──────────────────────────────────────────────────────
console.log("\nvolatilityHighBonus (+EV bucket bias):");

assert.strictEqual(volatilityHighBonus({ volatility: 4.5 }, VOL_ON), 300);
ok("at target (4.5) -> full weight 300");
assert.strictEqual(volatilityHighBonus({ volatility: 6.0 }, VOL_ON), 300);
ok("above target (6.0) -> full weight (capped, no over-reward)");
assert.strictEqual(volatilityHighBonus({ volatility: 3.5 }, VOL_ON), 0);
ok("at floor (3.5) -> 0 credit");
assert.strictEqual(volatilityHighBonus({ volatility: 3.0 }, VOL_ON), 0);
ok("below floor (3.0, still deployable) -> 0 credit");
// midpoint ramp: 4.0 -> (4.0-3.5)/(4.5-3.5)=0.5 -> 150
assert.strictEqual(volatilityHighBonus({ volatility: 4.0 }, VOL_ON), 150);
ok("midpoint (4.0) -> half weight 150 (linear ramp)");

// volatilityScore fallback
assert.strictEqual(volatilityHighBonus({ volatilityScore: 4.5 }, VOL_ON), 300);
ok("volatilityScore fallback (4.5) -> full weight");
assert.strictEqual(volatilityHighBonus({ volatility: 4.5, volatilityScore: 3.0 }, VOL_ON), 300);
ok("volatility takes precedence over volatilityScore");

// fail-safe neutral
assert.strictEqual(volatilityHighBonus({}, VOL_ON), 0);
ok("missing volatility -> 0 (NEUTRAL, anti-pattern #2)");
assert.strictEqual(volatilityHighBonus({ volatility: null }, VOL_ON), 0);
ok("null volatility -> 0 (NEUTRAL)");
assert.strictEqual(volatilityHighBonus({ volatility: 0 }, VOL_ON), 0);
ok("zero volatility -> 0 (NEUTRAL, not treated as valid low-vol)");
assert.strictEqual(volatilityHighBonus({ volatility: -2 }, VOL_ON), 0);
ok("negative volatility -> 0 (NEUTRAL)");
assert.strictEqual(volatilityHighBonus({ volatility: "x" }, VOL_ON), 0);
ok("non-finite volatility -> 0 (NEUTRAL)");

// flag off / misconfig
assert.strictEqual(volatilityHighBonus({ volatility: 4.5 }, VOL_OFF), 0);
ok("flag OFF (default) -> 0");
assert.strictEqual(volatilityHighBonus({ volatility: 4.5 }, null), 0);
ok("null cfg -> 0");
assert.strictEqual(
  volatilityHighBonus({ volatility: 4.5 }, { ...VOL_ON, volatilityHighBonusTarget: 3.0 }),
  0);
ok("misconfig target<=floor -> 0");

// NEVER a gate
assert.strictEqual(typeof volatilityHighBonus({ volatility: 3.0 }, VOL_ON), "number");
ok("returns a number, never a reject string (NEVER a gate)");

// ── scoreCandidate integration ───────────────────────────────────────────────
console.log("\nscoreCandidate integration:");

const base = { fee_active_tvl_ratio: 0.50, organic_score: 50, volume_window: 1000, holders: 300 };
// band bonus lifts an in-band pool above an out-of-band one with identical base metrics
const inBand  = { ...base, fee_active_tvl_ratio: 0.50 };
const hiTail  = { ...base, fee_active_tvl_ratio: 0.90 };
const sIn  = scoreCandidate(inBand, BAND_ON);
const sHi  = scoreCandidate(hiTail, BAND_ON);
// note base term (feeTvl*1000) still favors hiTail by 400; band bonus (400) offsets it exactly.
// The point: band ON does NOT ADD credit to the losing tail (only in-band gets +400).
const sInOff = scoreCandidate(inBand, BAND_OFF);
const sHiOff = scoreCandidate(hiTail, BAND_OFF);
assert.strictEqual(sIn - sInOff, 400);
ok("band ON adds +400 to in-band pool");
assert.strictEqual(sHi - sHiOff, 0);
ok("band ON adds 0 to high-tail pool (no steer to loser)");

// vol bonus lifts a 4.5+ pool
const volPool = { ...base, volatility: 4.5 };
assert.strictEqual(scoreCandidate(volPool, VOL_ON) - scoreCandidate(volPool, VOL_OFF), 300);
ok("vol ON adds +300 to a 4.5+ pool");
const lowVolPool = { ...base, volatility: 3.0 };
assert.strictEqual(scoreCandidate(lowVolPool, VOL_ON) - scoreCandidate(lowVolPool, VOL_OFF), 0);
ok("vol ON adds 0 to a below-floor (3.0) pool");

// old high-ramp bonus defaults OFF now (kill the steer)
assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.9 }, {}), 0);
ok("feeTvlHighBonus with empty cfg -> 0 (steer disabled by default)");

// ── direction gate — verify LIVE-EFFECTIVE behavior (price-only, -4) ──────────
console.log("\ndirectionGate — live-effective config (price-only, threshold -4):");

// Effective live VPS (verified 2026-07-17): directionGateEnabled=true,
// directionMaxNegPriceChangePct=-4 (config.js default; key ABSENT in user-config),
// directionRequireFlowConfirm=false (price-only mode, explicit in user-config).
const LIVE_DIR = {
  directionGateEnabled: true,
  directionMaxNegPriceChangePct: -4,
  directionRequireFlowConfirm: false,
};
assert.strictEqual(
  directionGateRejectReason({ price_change_pct: -11.7 }, LIVE_DIR),
  "direction_downtrend_at_entry");
ok("febu-SOL case (-11.7%) -> paused (gate catches the extreme)");
assert.strictEqual(
  directionGateRejectReason({ price_change_pct: -4 }, LIVE_DIR),
  "direction_downtrend_at_entry");
ok("at threshold (-4%) -> paused (inclusive)");
// DOCUMENTED GAP: the mild down-drift band leaks under the -4 threshold.
assert.strictEqual(directionGateRejectReason({ price_change_pct: -3.5 }, LIVE_DIR), null);
ok("GAP: -3.5% pool drift LEAKS (> -4 threshold) -> deploy (flagged for Lyra calib)");
assert.strictEqual(directionGateRejectReason({ price_change_pct: -2.5 }, LIVE_DIR), null);
ok("GAP: -2.5% pool drift LEAKS -> deploy (flagged for Lyra calib)");
// fail-open on missing data
assert.strictEqual(directionGateRejectReason({}, LIVE_DIR), null);
ok("missing price_change_pct -> FAIL-OPEN (deploy, never freeze)");
assert.strictEqual(directionGateRejectReason({ price_change_pct: null }, LIVE_DIR), null);
ok("null price_change_pct -> FAIL-OPEN (strictNumeric, no fabricated 0)");
// NUANCE (documented): the pure-fn reads the threshold via numeric(), and
// numeric(null) === 0 (Number(null)===0). So a LITERAL null passed straight to the
// fn does NOT fail-open — it coerces to 0 and the gate fires on ANY negative pct.
// This is why config.js MUST normalize with `?? -4` (nullish) BEFORE the fn ever
// sees the value: an absent/null user-config key becomes -4, not 0. Verified:
assert.strictEqual(
  directionGateRejectReason({ price_change_pct: -1 }, { directionGateEnabled: true, directionMaxNegPriceChangePct: null, directionRequireFlowConfirm: false }),
  "direction_downtrend_at_entry");
ok("threshold literal-null coerces to 0 via numeric() -> fires on any negative (config.js ?? -4 must guard this)");
// A truly absent (undefined) threshold -> numeric(undefined)===null -> no-op fail-open.
assert.strictEqual(
  directionGateRejectReason({ price_change_pct: -20 }, { directionGateEnabled: true, directionRequireFlowConfirm: false }),
  null);
ok("threshold undefined (no key) -> numeric()===null -> no-op fail-open (defensive)");

console.log(`\n👁️  Cassiopeia: ${passed} assertions passed.\n`);
