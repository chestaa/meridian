/**
 * Vega regression — entry_features FABRICATED-ZEROS bug (2026-07-14).
 *
 * ROOT CAUSE: every entry_features numeric-coercion helper used the naive
 *   `Number.isFinite(Number(v)) ? Number(v) : null`
 * pattern. But `Number(null) === 0`, `Number('') === 0`, `Number(false) === 0`
 * are all FINITE, so a genuinely-missing (null/''/false) regime / flow / mcap was
 * silently FABRICATED as a flat 0 — poisoning the direction-gate dataset with fake
 * measurements (anti-pattern #2). The prior test only fed `undefined` (→NaN→null),
 * so the null path was never exercised and the bug shipped.
 *
 * This test drives the FULL capture chain with literal null / '' / false / real
 * values and asserts: genuinely-missing → null (NEVER 0); real values (incl. a real
 * −3.48 SOL regime) flow through unchanged end-to-end.
 *
 * Run: node scripts/test-entry-features-null-not-zero.js
 * (chdir's to a throwaway cwd so trackPosition writes a temp ./state.json.)
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEntryFeatures as dlmmBuildEntryFeatures } from "../tools/dlmm.js";
import { buildEntryFeatures as screeningBuildEntryFeatures } from "../tools/screening.js";
import { config } from "../config.js";
import {
  deployFromOrionVerdict,
  __setExecuteToolForTests,
  __setDetectMarketRegimeForTests,
  __setGetWalletBalancesForTests,
} from "../agents/vega.js";

let passed = 0;
function check(desc, fn) {
  fn();
  passed++;
  console.log(`  ok - ${desc}`);
}

// ─── 1. dlmm.buildEntryFeatures — the AUTHORITATIVE assembler ──────────────
console.log("\n1. dlmm.buildEntryFeatures — null/''/false must NOT become 0:");

check("literal null inputs → all null (REGRESSION: was 0 via Number(null)===0)", () => {
  const r = dlmmBuildEntryFeatures({
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_vol: null,
    sell_vol: null,
    mcap: null,
  });
  assert.strictEqual(r.sol_regime_24h_pct, null);
  assert.strictEqual(r.token_price_change_1h, null);
  assert.strictEqual(r.token_price_change_24h, null);
  assert.strictEqual(r.buy_sell_flow_ratio, null);
  assert.strictEqual(r.mcap, null);
});

check("empty-string + false inputs → null (Number('')===0 / Number(false)===0 trap)", () => {
  const r = dlmmBuildEntryFeatures({
    sol_regime_24h_pct: "",
    token_price_change_1h: false,
    mcap: "",
    buy_vol: false,
    sell_vol: "",
  });
  assert.strictEqual(r.sol_regime_24h_pct, null);
  assert.strictEqual(r.token_price_change_1h, null);
  assert.strictEqual(r.mcap, null);
  assert.strictEqual(r.buy_sell_flow_ratio, null);
});

check("real −3.48 regime + real flow/mcap flow through (not 0)", () => {
  const r = dlmmBuildEntryFeatures({
    sol_regime_24h_pct: -3.48,
    token_price_change_1h: 2.1,
    token_price_change_24h: -8.0,
    buy_vol: 30000,
    sell_vol: 10000,
    mcap: 850000,
  });
  assert.strictEqual(r.sol_regime_24h_pct, -3.48);
  assert.notStrictEqual(r.sol_regime_24h_pct, 0);
  assert.strictEqual(r.buy_sell_flow_ratio, 0.75);
  assert.strictEqual(r.mcap, 850000);
});

check("numeric STRING preserved (e.g. '-3.48' → -3.48)", () => {
  const r = dlmmBuildEntryFeatures({ sol_regime_24h_pct: "-3.48", mcap: "850000" });
  assert.strictEqual(r.sol_regime_24h_pct, -3.48);
  assert.strictEqual(r.mcap, 850000);
});

check("one flow leg null, other real → ratio null (missing leg NOT treated as 0 vol)", () => {
  const r = dlmmBuildEntryFeatures({ buy_vol: 5000, sell_vol: null });
  assert.strictEqual(r.buy_sell_flow_ratio, null); // was: 5000/(5000+0)=1.0 fabricated
});

check("real value 0 (legit zero) is preserved as 0 — genuine measurement, not missing", () => {
  const r = dlmmBuildEntryFeatures({ sol_regime_24h_pct: 0 });
  assert.strictEqual(r.sol_regime_24h_pct, 0);
});

// ─── 2. state.normalizeEntryFeatures (via trackPosition) ───────────────────
console.log("\n2. state.js normalizeEntryFeatures — null-valued object stays null:");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vega-efz-"));
fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
process.chdir(tmpDir);
const { trackPosition, getTrackedPosition } = await import("../state.js");

trackPosition({
  position: "POS_NULLVALS",
  pool: "POOL_NV",
  pool_name: "NV-SOL",
  strategy: "bid_ask",
  amount_sol: 0.1,
  active_bin: 100,
  bin_step: 80,
  // a fully null-VALUED object (fields present but null) — the exact shape a
  // failed upstream capture produces. Must stay null, NOT be coerced to 0.
  entry_features: {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  },
});
check("null-valued entry_features persisted as null (REGRESSION: was all 0)", () => {
  const rec = getTrackedPosition("POS_NULLVALS");
  assert.deepStrictEqual(rec.entry_features, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  });
});

trackPosition({
  position: "POS_REALVALS",
  pool: "POOL_RV",
  pool_name: "RV-SOL",
  strategy: "bid_ask",
  amount_sol: 0.1,
  active_bin: 200,
  bin_step: 100,
  entry_features: {
    sol_regime_24h_pct: -3.48,
    token_price_change_1h: 2.1,
    token_price_change_24h: -8.0,
    buy_sell_flow_ratio: 0.75,
    mcap: 850000,
  },
});
check("real values survive normalizeEntryFeatures unchanged", () => {
  const rec = getTrackedPosition("POS_REALVALS");
  assert.strictEqual(rec.entry_features.sol_regime_24h_pct, -3.48);
  assert.strictEqual(rec.entry_features.mcap, 850000);
  assert.strictEqual(rec.entry_features.buy_sell_flow_ratio, 0.75);
});

// recordPerformance forwards `tracked.entry_features ?? null` (passthrough) — so the
// null-object above is exactly what reaches lessons.js. Assert the passthrough shape.
check("recordPerformance-forward shape == tracked null-object (no re-fabrication)", () => {
  const rec = getTrackedPosition("POS_NULLVALS");
  const forwarded = rec.entry_features ?? null; // mirrors dlmm.js recordPerformance forward
  assert.deepStrictEqual(forwarded, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  });
});

// ─── 3. screening.buildEntryFeatures (Cassiopeia in-cycle capture) ─────────
console.log("\n3. screening.js buildEntryFeatures — missing → null:");

check("regime null + candidate missing fields → nulls (not 0)", () => {
  const r = screeningBuildEntryFeatures({}, { regime: "NEUTRAL", sol24hChangePct: null });
  assert.strictEqual(r.sol_24h_change_pct, null); // REGRESSION: was 0
  assert.strictEqual(r.price_change_pct, null);
  assert.strictEqual(r.buy_vol, null);
  assert.strictEqual(r.mcap, null);
});

check("real regime + real candidate fields flow through", () => {
  const r = screeningBuildEntryFeatures(
    { price_change_pct: 4.1, buy_vol: 30000, sell_vol: 10000, mcap: 850000 },
    { regime: "DOWNTREND", sol24hChangePct: -3.48, source: "coingecko" },
  );
  assert.strictEqual(r.sol_24h_change_pct, -3.48);
  assert.notStrictEqual(r.sol_24h_change_pct, 0);
  assert.strictEqual(r.mcap, 850000);
  assert.strictEqual(r.regime, "DOWNTREND");
});

// ─── 4. vega.js deployFromOrionVerdict — END-TO-END scalar wiring ──────────
console.log("\n4. agents/vega.js deploy path — real values wired, missing → null:");

// Turn the flag ON for the test (default OFF in prod). Restore after.
const prevFlag = config.internalAgents?.vegaDeterministicDeploy;
config.internalAgents = config.internalAgents || {};
config.internalAgents.vegaDeterministicDeploy = true;
// Neutralize the live-confidence floor + wallet fetch for deterministic capture.
__setGetWalletBalancesForTests(async () => ({ sol: 1.0 }));

let capturedArgs = null;
__setExecuteToolForTests(async (_name, args) => {
  capturedArgs = args;
  return { position: { address: "POS_X" }, txs: ["SIG_X"] };
});

// Case A — real regime + candidate carries Cassiopeia entry_features.
__setDetectMarketRegimeForTests(async () => ({ regime: "DOWNTREND", sol24hChangePct: -3.48, source: "coingecko" }));
const candReal = {
  pool: {
    pool: "POOL_REAL",
    name: "REAL-SOL",
    volatility: 4.0,
    bin_step: 100,
    buy_vol: 30000,
    sell_vol: 10000,
    mcap: 850000,
    entry_features: {
      regime: "DOWNTREND",
      sol_24h_change_pct: -3.48,
      price_change_pct: 4.1,
      buy_vol: 30000,
      sell_vol: 10000,
      mcap: 850000,
    },
  },
  ti: { stats_1h: { price_change: 2.1 }, stats_24h: { price_change: -8.0 } },
};
const verdictReal = { pool_address: "POOL_REAL", decision: "enter", confidence: 80 };
await deployFromOrionVerdict(verdictReal, candReal, { deployAmountOverride: 0.1 });
check("real deploy: sol_regime_24h_pct === -3.48 wired to args (not 0)", () => {
  assert.strictEqual(capturedArgs.sol_regime_24h_pct, -3.48);
  assert.notStrictEqual(capturedArgs.sol_regime_24h_pct, 0);
});
check("real deploy: flow + mcap wired to args", () => {
  assert.strictEqual(capturedArgs.buy_vol, 30000);
  assert.strictEqual(capturedArgs.sell_vol, 10000);
  assert.strictEqual(capturedArgs.mcap, 850000);
  assert.strictEqual(capturedArgs.token_price_change_1h, 2.1);
});
check("real deploy: buildEntryFeatures(args) → real snapshot (end-to-end, not 0)", () => {
  const ef = dlmmBuildEntryFeatures(capturedArgs);
  assert.strictEqual(ef.sol_regime_24h_pct, -3.48);
  assert.strictEqual(ef.buy_sell_flow_ratio, 0.75);
  assert.strictEqual(ef.mcap, 850000);
});

// Case B — regime read returns null + candidate has NO flow/mcap/entry_features.
capturedArgs = null;
__setDetectMarketRegimeForTests(async () => ({ regime: "NEUTRAL", sol24hChangePct: null }));
const candMissing = {
  pool: { pool: "POOL_MISS", name: "MISS-SOL", volatility: 4.0, bin_step: 100 },
  ti: {},
};
const verdictMiss = { pool_address: "POOL_MISS", decision: "enter", confidence: 80 };
await deployFromOrionVerdict(verdictMiss, candMissing, { deployAmountOverride: 0.1 });
check("missing deploy: sol_regime_24h_pct === null (REGRESSION: null regime was 0)", () => {
  assert.strictEqual(capturedArgs.sol_regime_24h_pct, null);
});
check("missing deploy: flow + mcap + price-change all null (not 0)", () => {
  assert.strictEqual(capturedArgs.buy_vol, null);
  assert.strictEqual(capturedArgs.sell_vol, null);
  assert.strictEqual(capturedArgs.mcap, null);
  assert.strictEqual(capturedArgs.token_price_change_1h, null);
  assert.strictEqual(capturedArgs.token_price_change_24h, null);
});
check("missing deploy: buildEntryFeatures(args) → all-null snapshot (honest gap, not 0s)", () => {
  const ef = dlmmBuildEntryFeatures(capturedArgs);
  assert.deepStrictEqual(ef, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  });
});

// ─── cleanup ───────────────────────────────────────────────────────────────
config.internalAgents.vegaDeterministicDeploy = prevFlag;
__setExecuteToolForTests(null);
__setDetectMarketRegimeForTests(null);
__setGetWalletBalancesForTests(null);
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* best-effort */ }

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
