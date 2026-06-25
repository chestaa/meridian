#!/usr/bin/env node
/**
 * test-capture-schema.js — Cassiopeia 👁️
 * Pure (no-network) unit assertions on the capture row schema + verdict logic.
 */
import { buildPoolRow, configHash, utcDay, SCHEMA_VERSION } from "./capture-logger.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${msg}`); }
}

// Permissive thresholds so a fully-populated pool PASSES the gate.
const s = {
  minMcap: 100_000, maxMcap: 50_000_000,
  minHolders: 200, minVolume: 1_000,
  minTvl: 1_000, maxTvl: null,
  minBinStep: 1, maxBinStep: 500,
  minFeeActiveTvlRatio: 0.01,
  minVolatility: 0,
  minTokenAgeHours: 0, maxTokenAgeHours: null,
  requireMintRenounced: false, requireFreezeRenounced: false,
  rejectRugpullFlag: false,
};

const goodPool = {
  pool_address: "PoolGoodAddr111111111111111111111111111111",
  name: "GOOD-SOL",
  pool_type: "dlmm",
  token_x: { symbol: "GOOD", address: "MintGood", market_cap: 500_000, organic_score: 80, created_at: Date.now() - 50 * 3600_000 },
  token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
  dlmm_params: { bin_step: 80 },
  tvl: 50_000, active_tvl: 40_000, fee: 200, volume: 100_000,
  fee_active_tvl_ratio: 0.15, volatility: 4.0, base_token_holders: 800,
  pool_price: 1.23, pool_price_change_pct: 5.1, min_price: 1.0, max_price: 1.5,
};

const ctx = { snapshotTs: 1_700_000_000_000, cfgHash: "abc123", tier: "tier1", enriched: false };
const goodRow = buildPoolRow(goodPool, s, ctx);

// Required envelope fields on every row.
ok(goodRow.schema_version === SCHEMA_VERSION, "row carries schema_version");
ok(goodRow.config_hash === "abc123", "row carries config_hash");
ok(goodRow.snapshot_ts === 1_700_000_000_000, "row carries snapshot_ts");
ok(goodRow.tier === "tier1", "row carries tier");
ok(goodRow.enriched === false, "row carries enriched flag");
ok("reject_reason" in goodRow, "row carries reject_reason key");
ok("gate_pass" in goodRow, "row carries gate_pass key");

// Verdict: good pool passes.
ok(goodRow.gate_pass === true, "good pool gate_pass=true");
ok(goodRow.reject_reason === null, "good pool reject_reason=null");
ok(goodRow.gate_error === null, "good pool no gate_error");

// Field extraction fidelity.
ok(goodRow.mcap === 500_000, "mcap extracted");
ok(goodRow.holders === 800, "holders extracted");
ok(goodRow.bin_step === 80, "bin_step extracted");
ok(goodRow.fee_active_tvl_ratio === 0.15, "fee/TVL extracted");
ok(goodRow.base_mint === "MintGood", "base_mint extracted");

// Missing-data fidelity: null stays null, NEVER coerced to 0 (anti-pattern #2).
const sparsePool = { pool_address: "P2", name: "SPARSE", token_x: {}, token_y: {} };
const sparseRow = buildPoolRow(sparsePool, s, ctx);
ok(sparseRow.holders === null, "missing holders → null (not 0)");
ok(sparseRow.mcap === null, "missing mcap → null (not 0)");
ok(sparseRow.volatility === null, "missing volatility → null (not 0)");
ok(sparseRow.gate_pass === false, "sparse pool fails gate");
ok(typeof sparseRow.reject_reason === "string" && sparseRow.reject_reason.length > 0, "sparse pool has a reject_reason");

// A reject pool: mcap below floor.
const lowMcapRow = buildPoolRow({ ...goodPool, token_x: { ...goodPool.token_x, market_cap: 1_000 } }, s, ctx);
ok(lowMcapRow.gate_pass === false, "low mcap → gate_pass=false");
ok(/mcap/.test(lowMcapRow.reject_reason), "low mcap reject_reason mentions mcap");

// configHash is deterministic regardless of key order.
ok(configHash({ a: 1, b: 2 }) === configHash({ b: 2, a: 1 }), "configHash key-order stable");
ok(configHash({ a: 1 }) !== configHash({ a: 2 }), "configHash sensitive to value");

// utcDay format.
ok(utcDay(0) === "1970-01-01", "utcDay formats UTC YYYY-MM-DD");

console.log(`\n[capture-schema] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
