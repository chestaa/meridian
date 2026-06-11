// Test for verdict-log.js — per-candidate verdict persistence (calibration audit).
// Run: node scripts/test-verdict-log.js
// No LLM tokens spent. Uses an isolated temp VERDICT_LOG_DIR so it never touches
// real ./logs. Asserts: append (not overwrite), full fields, both confidence
// scales, both paths labeled distinctly.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate writes to a throwaway dir BEFORE importing the module.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-log-test-"));
process.env.VERDICT_LOG_DIR = TMP_DIR;

const { recordNativeVerdict, recordNativeVerdicts, recordSignalVerdict } =
  await import("../verdict-log.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

function readAllRows() {
  return fs.readdirSync(TMP_DIR)
    .filter((f) => f.startsWith("verdicts-") && f.endsWith(".jsonl"))
    .flatMap((f) =>
      fs.readFileSync(path.join(TMP_DIR, f), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    );
}

// ---- File naming follows logger.js daily-rotation convention ----
const dateStr = new Date().toISOString().split("T")[0];
recordNativeVerdict(
  { pool_address: "PoolAAA111", decision: "enter", confidence: 72, reason: "good fee/tvl", recommended_bins_below: 50 },
  {
    pool: { pool: "PoolAAA111", name: "AAA-SOL", base_mint: "MintAAA", mcap: 800000, tvl: 50000, volume_window: 12000, organic_score: 75, fee_active_tvl_ratio: 0.08, volatility: 3.2 },
    ti: { audit: { top_holders_pct: 40, bot_holders_pct: 12 } },
  }
);
const filePath = path.join(TMP_DIR, `verdicts-${dateStr}.jsonl`);
check("daily-rotating file verdicts-YYYY-MM-DD.jsonl created", fs.existsSync(filePath));

let rows = readAllRows();
check("native verdict appended (1 row)", rows.length === 1);

const nv = rows[0];
check("native: path=native", nv.path === "native");
check("native: source=orion", nv.source === "orion");
check("native: confidence_scale 0-100", nv.confidence_scale === "0-100");
check("native: verdict enter|skip", nv.verdict === "enter" || nv.verdict === "skip");
check("native: confidence in 0..100 range", nv.confidence === 72);
check("native: pool persisted", nv.pool === "PoolAAA111");
check("native: symbol persisted", nv.symbol === "AAA-SOL");
check("native: base_mint persisted", nv.base_mint === "MintAAA");
check("native: reason persisted", typeof nv.reason === "string" && nv.reason.length > 0);
check("native: recommended_bins_below persisted", nv.recommended_bins_below === 50);
check("native: metrics.mcap", nv.metrics.mcap === 800000);
check("native: metrics.tvl", nv.metrics.tvl === 50000);
check("native: metrics.volume", nv.metrics.volume === 12000);
check("native: metrics.organic", nv.metrics.organic === 75);
check("native: metrics.top10_pct", nv.metrics.top10_pct === 40);
check("native: timestamp present", typeof nv.ts === "string" && nv.ts.includes("T"));

// ---- Append, NOT overwrite: batch of 2 must leave 3 total ----
recordNativeVerdicts(
  [
    { pool_address: "PoolBBB222", decision: "skip", confidence: 18, reason: "bots high" },
    { pool_address: "PoolCCC333", decision: "enter", confidence: 88, reason: "real launch" },
  ],
  [
    { pool: { pool: "PoolBBB222", name: "BBB-SOL", mcap: 200000 }, ti: {} },
    { pool: { pool: "PoolCCC333", name: "CCC-SOL", mcap: 1500000 }, ti: {} },
  ]
);
rows = readAllRows();
check("append (not overwrite): 1 + 2 = 3 rows", rows.length === 3);
check("append: original row still present", rows[0].pool === "PoolAAA111");
check("append: skip verdict recorded with low confidence", rows[1].verdict === "skip" && rows[1].confidence === 18);

// ---- Signal path: 0-1 scale, enter|watch|skip enum ----
recordSignalVerdict(
  { symbol: "SIGX", tokenAddress: "MintSIGX", mcapUsd: 950000, vol5mUsd: 4200, tvl: 30000, organicScore: 64, holders: 1200, poolAddress: "PoolSIG999" },
  { decision: "watch", confidence: 0.55, reason: "thin liquidity, watching", maxPositionSol: 0.03, model: "test-model" }
);
rows = readAllRows();
check("signal verdict appended (4 rows total)", rows.length === 4);

const sv = rows[3];
check("signal: path=signal", sv.path === "signal");
check("signal: source=signal-judge", sv.source === "signal-judge");
check("signal: confidence_scale 0-1", sv.confidence_scale === "0-1");
check("signal: watch verdict allowed", sv.verdict === "watch");
check("signal: confidence in 0..1 range", sv.confidence === 0.55);
check("signal: symbol persisted", sv.symbol === "SIGX");
check("signal: base_mint = tokenAddress", sv.base_mint === "MintSIGX");
check("signal: max_position_sol persisted", sv.max_position_sol === 0.03);
check("signal: model persisted", sv.model === "test-model");
check("signal: metrics.mcap from mcapUsd", sv.metrics.mcap === 950000);
check("signal: metrics.volume from vol5mUsd", sv.metrics.volume === 4200);
check("signal: metrics.holders persisted", sv.metrics.holders === 1200);

// ---- Scale separation: scales are explicitly labeled so analysis won't mix them ----
const nativeRows = rows.filter((r) => r.path === "native");
const signalRows = rows.filter((r) => r.path === "signal");
check("native rows all labeled 0-100", nativeRows.every((r) => r.confidence_scale === "0-100"));
check("signal rows all labeled 0-1", signalRows.every((r) => r.confidence_scale === "0-1"));

// ---- Fail-safe: unknown decision coerces to skip, never throws ----
recordSignalVerdict({ symbol: "WEIRD" }, { decision: "garbage", confidence: 0.1, reason: "x", maxPositionSol: 0 });
rows = readAllRows();
check("unknown signal decision coerced to skip", rows[4].verdict === "skip");

// Cleanup temp dir.
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
