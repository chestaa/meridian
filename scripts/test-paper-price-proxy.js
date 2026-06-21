/**
 * scripts/test-paper-price-proxy.js
 * Vega honesty-audit 2026-06-21 — FIX #3: sane paper price-proxy PnL.
 *
 * ROOT CAUSE: the paper snapshot price source was not unit-consistent with
 * entry_price. entry_price = pool-quoted price at deploy; the snapshot fell back
 * from detail.pool_price to token.price (a USD price ~150x off) → fabricated
 * thousands-of-percent PnL (ANSEM 6827%, Islands 7585%), poisoning bluechip
 * paper-soak validation.
 *
 * FIX: computePriceProxyPnl compares same-unit prices and REJECTS an implausible
 * ratio (unit mismatch / stale snapshot) → null (uncomputable), never a fabricated
 * or clamped-but-still-fake number. Missing price → null. FAIL-SAFE throughout.
 *
 * Asserts:
 *   (a) normal same-unit move → correct realistic PnL
 *   (b) the 6827% garbage class (≈69x ratio) → uncomputable null + reason
 *   (c) a USD-vs-pool unit mismatch (~150x) → uncomputable null
 *   (d) catastrophic <-90% implausible (≈0.05x) → uncomputable null
 *   (e) boundary at the sane-ratio edges → still computed (not over-eager)
 *   (f) missing / non-positive price → uncomputable null (no fabrication)
 *   (g) a genuine modest loss stays negative and finite
 */
import assert from "node:assert/strict";

const {
  computePriceProxyPnl,
  PROXY_SANE_RATIO_MAX,
  PROXY_SANE_RATIO_MIN,
} = await import("../paper-trades.js");

let n = 0;
function check(label, fn) { fn(); n++; console.log(`  PASS ${label}`); }

console.log("Vega FIX #3 — paper price-proxy honesty\n");

// (a) normal same-unit move: entry 0.001, current 0.0011 → +10%
check("(a) normal +10% move computes correctly", () => {
  const r = computePriceProxyPnl(0.001, 0.0011);
  assert.equal(r.uncomputable, false);
  assert.ok(Math.abs(r.pnl_pct - 10) < 1e-6, `expected +10%, got ${r.pnl_pct}`);
});

// (b) the 6827% class: ratio ≈ 69.27 → implausible, uncomputable
check("(b) 6827% garbage (≈69x ratio) → uncomputable null (not fabricated)", () => {
  const r = computePriceProxyPnl(0.001, 0.069);
  assert.equal(r.pnl_pct, null, "must NOT report a multi-thousand-percent PnL");
  assert.equal(r.uncomputable, true);
  assert.ok(/implausible_price_ratio/.test(r.reason), `reason should flag ratio: ${r.reason}`);
});

// (c) USD-vs-pool unit mismatch ~150x (the actual fallback bug) → uncomputable
check("(c) USD/pool unit mismatch (~150x) → uncomputable null", () => {
  const r = computePriceProxyPnl(0.0066, 1.0); // pool-quoted vs USD price
  assert.equal(r.pnl_pct, null);
  assert.equal(r.uncomputable, true);
});

// (d) catastrophic implausible <-90% (ratio 0.05) → uncomputable
check("(d) ratio 0.05 (≈-95%) → uncomputable null (suspect unit/stale)", () => {
  const r = computePriceProxyPnl(1.0, 0.05);
  assert.equal(r.pnl_pct, null);
  assert.equal(r.uncomputable, true);
});

// (e) boundary: exactly at MAX/MIN ratio is still accepted (not over-eager)
check("(e) ratio exactly at sane MAX edge → still computed", () => {
  const r = computePriceProxyPnl(1.0, PROXY_SANE_RATIO_MAX); // ratio 10 → +900%
  assert.equal(r.uncomputable, false);
  assert.ok(Math.abs(r.pnl_pct - 900) < 1e-6, `expected +900%, got ${r.pnl_pct}`);
});
check("(e2) ratio exactly at sane MIN edge → still computed", () => {
  const r = computePriceProxyPnl(1.0, PROXY_SANE_RATIO_MIN); // ratio 0.1 → -90%
  assert.equal(r.uncomputable, false);
  assert.ok(Math.abs(r.pnl_pct - (-90)) < 1e-6, `expected -90%, got ${r.pnl_pct}`);
});

// (f) missing / non-positive prices → uncomputable null, never fabricated
check("(f1) null current price → uncomputable null", () => {
  const r = computePriceProxyPnl(0.001, null);
  assert.equal(r.pnl_pct, null);
  assert.equal(r.uncomputable, true);
});
check("(f2) zero entry price → uncomputable null", () => {
  const r = computePriceProxyPnl(0, 0.001);
  assert.equal(r.pnl_pct, null);
  assert.equal(r.uncomputable, true);
});
check("(f3) NaN price → uncomputable null", () => {
  const r = computePriceProxyPnl(0.001, NaN);
  assert.equal(r.pnl_pct, null);
  assert.equal(r.uncomputable, true);
});

// (g) genuine modest loss stays negative + finite
check("(g) modest -7% move stays finite & negative", () => {
  const r = computePriceProxyPnl(1.0, 0.93);
  assert.equal(r.uncomputable, false);
  assert.ok(Math.abs(r.pnl_pct - (-7)) < 1e-6, `expected -7%, got ${r.pnl_pct}`);
});

console.log(`\nALL ${n} ASSERTIONS PASS — paper price-proxy is honest (no 6827% garbage)`);
