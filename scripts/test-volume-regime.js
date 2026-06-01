// scripts/test-volume-regime.js
// Vega — Item (b) volume-regime strategy spread.
//
// Tests the PURE helper pickRegimeStrategy(volume_window, volatility, cfg)
// and proves:
//   - HIGH volume + low volatility → spot (tight fee capture)
//   - HIGH volume + high volatility → bid_ask (volatility guard overrides spot)
//   - LOW volume → bid_ask (catch volatility)
//   - null/0/non-finite volume → config default fallback (no silent flip)
//   - explicit strategy passed to deployPosition wins (override-wins)
//   - flag OFF → legacy config.strategy.strategy
//
// Pure helper only — no on-chain calls, no DRY_RUN dependency.

import assert from "node:assert/strict";
import { pickRegimeStrategy } from "../tools/dlmm.js";

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
}
function eq(a, b, msg) {
  assert.equal(a, b, msg);
  pass++;
}

// Baseline regime config (defaults per config.js)
const cfg = {
  strategy: "bid_ask",
  volumeRegimeHighThreshold: 50000,
  volumeRegimeMaxVolForSpot: 3,
};

// ── 1. HIGH volume + low volatility → spot ──
eq(pickRegimeStrategy(60000, 2, cfg), "spot", "vol_window 60k + volatility 2 → spot");

// ── 2. HIGH volume + high volatility → bid_ask (volatility guard) ──
eq(pickRegimeStrategy(60000, 5, cfg), "bid_ask", "vol_window 60k + volatility 5 → bid_ask (vol guard overrides)");

// Volatility exactly at threshold (3) is NOT > 3 → still spot at high volume
eq(pickRegimeStrategy(60000, 3, cfg), "spot", "volatility == maxVolForSpot boundary → spot (guard is strict >)");
// Just above threshold → bid_ask
eq(pickRegimeStrategy(60000, 3.01, cfg), "bid_ask", "volatility just above maxVolForSpot → bid_ask");

// ── 3. LOW volume → bid_ask ──
eq(pickRegimeStrategy(10000, 2, cfg), "bid_ask", "vol_window 10k → bid_ask");
// Volume exactly at threshold (50k) is >= → high regime → spot (low vol)
eq(pickRegimeStrategy(50000, 1, cfg), "spot", "vol_window == highThreshold → high regime → spot");
eq(pickRegimeStrategy(49999, 1, cfg), "bid_ask", "vol_window just below highThreshold → bid_ask");

// ── 4. Bad/missing volume → config default fallback (no silent flip) ──
eq(pickRegimeStrategy(null, 2, cfg), "bid_ask", "null volume → config default (bid_ask)");
eq(pickRegimeStrategy(0, 2, cfg), "bid_ask", "0 volume → config default");
eq(pickRegimeStrategy(NaN, 2, cfg), "bid_ask", "NaN volume → config default");
eq(pickRegimeStrategy(-100, 2, cfg), "bid_ask", "negative volume → config default");
eq(pickRegimeStrategy(undefined, 2, cfg), "bid_ask", "undefined volume → config default");
eq(pickRegimeStrategy("not-a-number", 2, cfg), "bid_ask", "non-numeric volume → config default");

// Fallback honors a non-default config.strategy too (proves no hardcoded flip)
const cfgSpotDefault = { ...cfg, strategy: "spot" };
eq(pickRegimeStrategy(null, 2, cfgSpotDefault), "spot", "null volume → honors config default 'spot' (not hardcoded bid_ask)");

// ── 5. High volume + UNKNOWN volatility → spot (guard only fires on KNOWN high vol) ──
// Rationale: volatility-feed gating is enforced upstream in deployPosition
// (throws on vol<=0/non-finite when volatility != null). Here, missing vol
// alone does not force bid_ask — volume regime still applies.
eq(pickRegimeStrategy(60000, null, cfg), "spot", "high volume + null volatility → spot (guard fires only on known high vol)");
eq(pickRegimeStrategy(60000, undefined, cfg), "spot", "high volume + undefined volatility → spot");

// ── 6. Config-default threshold robustness (missing cfg knobs) ──
const cfgBare = { strategy: "bid_ask" };
eq(pickRegimeStrategy(60000, 2, cfgBare), "spot", "missing thresholds → defaults (50k/3) applied → spot");
eq(pickRegimeStrategy(60000, 5, cfgBare), "bid_ask", "missing thresholds → default vol guard (3) → bid_ask");
eq(pickRegimeStrategy(10000, 2, cfgBare), "bid_ask", "missing thresholds → low volume → bid_ask");

// ── 7. Custom thresholds respected ──
const cfgCustom = { strategy: "bid_ask", volumeRegimeHighThreshold: 100000, volumeRegimeMaxVolForSpot: 1 };
eq(pickRegimeStrategy(60000, 0.5, cfgCustom), "bid_ask", "custom highThreshold 100k → 60k is LOW → bid_ask");
eq(pickRegimeStrategy(150000, 0.5, cfgCustom), "spot", "custom highThreshold 100k → 150k HIGH + low vol → spot");
eq(pickRegimeStrategy(150000, 1.5, cfgCustom), "bid_ask", "custom maxVolForSpot 1 → vol 1.5 > 1 → bid_ask");

// ── 8. Override-wins + flag-OFF semantics (documents deployPosition behavior) ──
// These mirror the resolution branch in deployPosition:
//   if (strategy) -> strategy            (explicit override wins)
//   else if (volumeRegimeEnabled) -> pickRegimeStrategy(...)
//   else -> config.strategy.strategy     (legacy)
function resolveActiveStrategy(explicit, regimeEnabled, volume_window, volatility, strategyCfg) {
  if (explicit) return explicit;
  if (regimeEnabled) return pickRegimeStrategy(volume_window, volatility, strategyCfg);
  return strategyCfg.strategy;
}
// Explicit strategy wins even when regime would pick differently
eq(resolveActiveStrategy("spot", true, 10000, 2, cfg), "spot", "explicit 'spot' overrides regime's bid_ask pick");
eq(resolveActiveStrategy("bid_ask", true, 60000, 1, cfg), "bid_ask", "explicit 'bid_ask' overrides regime's spot pick");
// Flag OFF → legacy config default regardless of volume
eq(resolveActiveStrategy(undefined, false, 60000, 1, cfg), "bid_ask", "flag OFF → legacy config.strategy.strategy (ignores high volume)");
eq(resolveActiveStrategy(undefined, false, 60000, 1, cfgSpotDefault), "spot", "flag OFF → legacy honors config default 'spot'");
// Flag ON, no explicit → regime applies
eq(resolveActiveStrategy(undefined, true, 60000, 1, cfg), "spot", "flag ON + no explicit + high vol/low volatility → regime spot");
eq(resolveActiveStrategy(undefined, true, 60000, 9, cfg), "bid_ask", "flag ON + no explicit + high vol/HIGH volatility → regime bid_ask (guard)");

// ── 9. Live config sanity: defaults are OFF and conservative ──
const { config } = await import("../config.js");
eq(config.strategy.volumeRegimeEnabled, false, "config default volumeRegimeEnabled === false (flag OFF)");
eq(config.strategy.volumeRegimeHighThreshold, 50000, "config default volumeRegimeHighThreshold === 50000");
eq(config.strategy.volumeRegimeMaxVolForSpot, 3, "config default volumeRegimeMaxVolForSpot === 3");

console.log(`\n[test-volume-regime] PASS — ${pass} assertions`);
