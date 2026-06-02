// scripts/test-fast-bidask.js
// Vega — Item 1 "Fast bid-ask bonus stage" (intel @bengsharksol, 83% WR claim).
//
// Tests the PURE helper isFastBidAskBonus(token_age_hours, volatility, cfg)
// AND the deployPosition strategy-resolution interaction with the regime picker.
//
// Proves:
//   - fresh (age <= max) + volatile (vol >= min) + flag ON → override true
//   - mature pool (age > max) → no override (false)
//   - calm pool (vol < min) → no override (false)
//   - flag OFF → never override (false), no behavior change
//   - missing/zero/non-finite age or volatility → false (FAIL-SAFE, no silent flip)
//   - explicit strategy always wins (fast-BA never touches it)
//   - end-to-end resolution: regime picks spot for high-vol fresh pool, fast-BA
//     flips it to bid_ask (the materially-different case)
//
// Pure helpers only — no on-chain calls, no DRY_RUN dependency.

import assert from "node:assert/strict";
import { isFastBidAskBonus, pickRegimeStrategy } from "../tools/dlmm.js";

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
}
function eq(a, b, msg) {
  assert.equal(a, b, msg);
  pass++;
}

// Baseline fast-BA config (defaults per config.js), flag ON for the helper tests.
const cfgOn = {
  strategy: "bid_ask",
  fastBidAskBonusEnabled: true,
  fastBidAskMaxAgeHours: 24,
  fastBidAskMinVolatility: 3,
  // regime knobs (used in end-to-end resolution tests below)
  volumeRegimeHighThreshold: 50000,
  volumeRegimeMaxVolForSpot: 100, // set high so the regime guard does NOT itself force bid_ask
};
const cfgOff = { ...cfgOn, fastBidAskBonusEnabled: false };

// ── 1. Fresh + volatile + flag ON → override true ──
ok(isFastBidAskBonus(2, 5, cfgOn), "age 2h + vol 5 (fresh+volatile) → fast-BA true");
ok(isFastBidAskBonus(24, 3, cfgOn), "age exactly maxAge + vol exactly minVol → true (boundaries inclusive)");
ok(isFastBidAskBonus(0.5, 8, cfgOn), "very fresh + very volatile → true");

// ── 2. Mature pool → no override ──
eq(isFastBidAskBonus(25, 5, cfgOn), false, "age 25h (> maxAge 24) → false");
eq(isFastBidAskBonus(720, 9, cfgOn), false, "age 720h (old) → false even if volatile");

// ── 3. Calm pool → no override ──
eq(isFastBidAskBonus(2, 2, cfgOn), false, "vol 2 (< minVol 3) → false even if fresh");
eq(isFastBidAskBonus(2, 2.99, cfgOn), false, "vol just below minVol → false");

// ── 4. Flag OFF → never override ──
eq(isFastBidAskBonus(2, 5, cfgOff), false, "flag OFF → false (no behavior change)");
eq(isFastBidAskBonus(1, 9, cfgOff), false, "flag OFF → false even for textbook fresh+volatile");

// ── 5. FAIL-SAFE: missing/zero/non-finite metrics → false (no silent flip) ──
eq(isFastBidAskBonus(null, 5, cfgOn), false, "null age → false");
eq(isFastBidAskBonus(0, 5, cfgOn), false, "0 age → false (unknown, not 'infinitely fresh')");
eq(isFastBidAskBonus(-1, 5, cfgOn), false, "negative age → false");
eq(isFastBidAskBonus(NaN, 5, cfgOn), false, "NaN age → false");
eq(isFastBidAskBonus(undefined, 5, cfgOn), false, "undefined age → false");
eq(isFastBidAskBonus("x", 5, cfgOn), false, "non-numeric age → false");
eq(isFastBidAskBonus(2, null, cfgOn), false, "null volatility → false");
eq(isFastBidAskBonus(2, 0, cfgOn), false, "0 volatility → false (unusable feed)");
eq(isFastBidAskBonus(2, -3, cfgOn), false, "negative volatility → false");
eq(isFastBidAskBonus(2, NaN, cfgOn), false, "NaN volatility → false");

// ── 6. Custom thresholds respected ──
const cfgCustom = { ...cfgOn, fastBidAskMaxAgeHours: 6, fastBidAskMinVolatility: 1 };
ok(isFastBidAskBonus(5, 1.5, cfgCustom), "custom maxAge 6 / minVol 1 → age 5 + vol 1.5 true");
eq(isFastBidAskBonus(7, 1.5, cfgCustom), false, "custom maxAge 6 → age 7 false");
eq(isFastBidAskBonus(5, 0.5, cfgCustom), false, "custom minVol 1 → vol 0.5 false");

// ── 7. Missing cfg knobs → defaults (24h / 3) applied ──
const cfgBare = { strategy: "bid_ask", fastBidAskBonusEnabled: true };
ok(isFastBidAskBonus(10, 4, cfgBare), "missing knobs → default 24h/3 → age 10 + vol 4 true");
eq(isFastBidAskBonus(30, 4, cfgBare), false, "missing knobs → default maxAge 24 → age 30 false");

// ── 8. End-to-end resolution (mirrors deployPosition logic) ──────────────────
// Resolution order in deployPosition (no explicit strategy, regime ON):
//   1. regime pick (pickRegimeStrategy)
//   2. fast-BA override → force bid_ask if isFastBidAskBonus(...)
function resolve(explicit, regimeEnabled, volume_window, volatility, token_age_hours, cfg) {
  if (explicit) return explicit; // explicit override wins — fast-BA never touches it
  let s;
  if (regimeEnabled) s = pickRegimeStrategy(volume_window, volatility, cfg);
  else s = cfg.strategy;
  if (isFastBidAskBonus(token_age_hours, volatility, cfg)) s = "bid_ask";
  return s;
}

// The MATERIALLY-DIFFERENT case: high-volume fresh pool. Regime would pick spot
// (high volume, vol under the regime guard 100), fast-BA flips it to bid_ask.
eq(
  pickRegimeStrategy(60000, 5, cfgOn),
  "spot",
  "sanity: regime picks spot for high-volume pool (vol under regime guard 100)",
);
eq(
  resolve(undefined, true, 60000, 5, 2, cfgOn),
  "bid_ask",
  "fresh+volatile high-volume pool: regime spot → fast-BA flips to bid_ask (the real win)",
);
// Mature high-volume pool: fast-BA does NOT fire → regime's spot stands.
eq(
  resolve(undefined, true, 60000, 5, 200, cfgOn),
  "spot",
  "mature high-volume pool: fast-BA does not fire → regime spot stands",
);
// Flag OFF: identical to pure regime behavior (no change).
eq(
  resolve(undefined, true, 60000, 5, 2, cfgOff),
  "spot",
  "flag OFF: fresh+volatile high-volume pool stays regime spot (no behavior change)",
);
// Explicit strategy wins even on a textbook fast-BA pool.
eq(
  resolve("spot", true, 10000, 9, 1, cfgOn),
  "spot",
  "explicit 'spot' wins — fast-BA never overrides an explicit strategy",
);
// Low-volume fresh+volatile: regime already bid_ask, fast-BA confirms (no-op).
eq(
  resolve(undefined, true, 10000, 5, 2, cfgOn),
  "bid_ask",
  "low-volume fresh+volatile: regime bid_ask, fast-BA confirms (no-op)",
);
// Regime OFF, legacy default bid_ask, fast-BA confirms (no-op).
eq(
  resolve(undefined, false, 60000, 5, 2, cfgOn),
  "bid_ask",
  "regime OFF: legacy bid_ask default, fast-BA confirms (no-op)",
);

// ── 9. Live config sanity: defaults are OFF and conservative ──
const { config } = await import("../config.js");
eq(config.strategy.fastBidAskBonusEnabled, false, "config default fastBidAskBonusEnabled === false (flag OFF)");
eq(config.strategy.fastBidAskMaxAgeHours, 24, "config default fastBidAskMaxAgeHours === 24");
eq(config.strategy.fastBidAskMinVolatility, 3, "config default fastBidAskMinVolatility === 3");

console.log(`\n[test-fast-bidask] PASS — ${pass} assertions`);
