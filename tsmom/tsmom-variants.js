// tsmom/tsmom-variants.js — named, pre-registered TSMOM config_versions.
//
// WHY THIS EXISTS
// ---------------
// Each parameter set we test is a SEPARATE config_version, declared up front and
// judged on its OWN forward periods — NEVER cherry-picked from a curve sweep
// (the named overfitting failure mode, see tsmom-backtest.js). Centralizing the
// variants here means the deep-backtest runner AND the forward paper-soak runner
// read the EXACT same param object for a given config_version — no drift, no
// "the soak ran a slightly different config than the backtest" reconcile mess.
//
// v3-btc-long — THE PRE-REGISTERED HYPOTHESIS (not a curve-fit)
// ------------------------------------------------------------
// The v2-deephistory deep run (Yahoo daily, BTC 11.8yr / ETH 8.6yr / SOL 6.2yr,
// multi-regime, walk-forward, no-peek) produced a MEASURED, regime-split result:
//
//   * BTC: EDGE_POSITIVE  (n=193, t=4.14). The edge is driven by the UPTREND
//     bucket (t=3.36) and the CHOP bucket (t=2.17). The DOWNTREND bucket is
//     NOISE (t=1.17) — i.e. the short/bear leg did NOT carry the edge.
//   * ETH: NOISE (n=138, t=0.14, negative in chop).
//   * SOL: NOISE (n=96, t=1.40).
//
// Two findings drive this variant, BOTH pre-registered from that run (we are NOT
// peeking forward, we are NOT re-sweeping params to maximize a forward curve):
//
//   FINDING 1 — BTC-ONLY. 2 of 3 majors showed no edge. A 3-asset "book" would
//     dilute a real BTC edge with two noise streams. So this variant trades BTC
//     ONLY. (ETH/SOL keep getting forward-soaked under their own neutral config
//     if Bro wants, but they are NOT in this variant.)
//
//   FINDING 2 — LONG/FLAT (no short). The bear-short hypothesis INVERTED in the
//     deep data: the edge lives in UPTREND + CHOP, the DOWNTREND/short bucket is
//     noise. A short leg therefore adds variance + (real-world) borrow/funding
//     cost for no measured expectancy. So `allowShort=false`: positive trailing
//     momentum => LONG (vol-scaled); non-positive => FLAT (cash, weight 0).
//
// EVERYTHING ELSE IS HELD MECHANICALLY IDENTICAL to the validated v2 spec —
// same 252d lookback, same 21d rebalance, same 60d vol window, same 0.40 target
// vol, same 2.0 max leverage, same 365 trading-days/yr. We change ONLY the two
// things the data told us to change (asset set + short toggle). Holding the rest
// fixed is the anti-curve-fit guarantee: this is the validated config minus the
// two legs the regime split said were dead weight, NOT a new optimization.
//
// HONESTY: a backtest "validation" is in-sample to the period we HAD. v3-btc-long
// must now earn its keep on FORWARD periods (tsmom-paper-soak.js) before capital.
// The backtest is the reason to forward-test, not the permission to deploy.

import { DEFAULT_PARAMS } from "./tsmom-signal.js";

// The single source of truth for v3-btc-long. Frozen so no caller can mutate it
// (a mutated shared params object is exactly how a soak silently diverges from
// the backtest it claims to validate).
export const V3_BTC_LONG_PARAMS = Object.freeze({
  ...DEFAULT_PARAMS,
  // — the two pre-registered changes —
  allowShort: false, // FINDING 2: long/flat only; short bucket was noise.
  // — everything else mechanically identical to validated v2 —
  lookbackDays: 252,
  rebalanceDays: 21,
  volWindowDays: 60,
  targetAnnualVol: 0.40,
  maxLeverage: 2.0,
  tradingDaysPerYear: 365,
});

// The asset this variant trades. BTC ONLY (FINDING 1). Kept as a named export so
// the soak runner and tests can't disagree about scope.
export const V3_BTC_LONG_ASSET = "BTC";

export const V3_BTC_LONG_VERSION = "v3-btc-long";

// Registry of named variants. Add a NEW key for any future param set — never
// edit an existing one (that would retroactively rewrite what a logged
// config_version meant). Returns a frozen params object + its asset scope.
export const TSMOM_VARIANTS = Object.freeze({
  [V3_BTC_LONG_VERSION]: {
    version: V3_BTC_LONG_VERSION,
    asset: V3_BTC_LONG_ASSET,
    params: V3_BTC_LONG_PARAMS,
    rationale:
      "BTC-only, long/flat. Pre-registered from v2-deephistory regime split: BTC " +
      "EDGE_POSITIVE (t=4.14) via UPTREND+CHOP; DOWNTREND/short bucket NOISE; ETH/SOL NOISE.",
  },
});

// Resolve a variant by version string. Throws (loudly) on unknown version so a
// typo in a systemd unit can never silently fall back to a different config.
export function getVariant(version) {
  const v = TSMOM_VARIANTS[version];
  if (!v) {
    throw new Error(
      `unknown TSMOM variant "${version}"; known: ${Object.keys(TSMOM_VARIANTS).join(", ")}`
    );
  }
  return v;
}
