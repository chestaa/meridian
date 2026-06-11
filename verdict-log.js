// verdict-log.js — per-candidate judge verdict persistence for CALIBRATION AUDIT.
//
// WHY this exists (Orion observability fix):
//   agents/orion.js only logged "judged N: X enter, Y skip" — the per-candidate
//   verdict + confidence + reason + key metrics were NEVER persisted. We were
//   BLIND to the judge's confidence distribution and could not audit whether the
//   judge is over/under-strict without raw data. This file records every verdict
//   so "is the judge over-strict?" can be answered with NUMBERS, not guesses.
//
// WHY a separate file (not decision-log.json):
//   decision-log.json is a capped (100) prompt-context summary log read back into
//   LLM prompts via getDecisionSummary. Dumping per-candidate verdicts there would
//   (a) blow the 100-cap in a single screening cycle and (b) pollute prompt context.
//   So we use a DEDICATED daily-rotating JSONL — same pattern as logger.js
//   actions-YYYY-MM-DD.jsonl — append-only, one row per verdict, never overwrite.
//
// COST: pure local file append. NO extra LLM call. Zero added LLM cost.
//
// This module does NOT change any judge/verdict logic — it only RECORDS verdicts.

import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const LOG_DIR = process.env.VERDICT_LOG_DIR || "./logs";

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v, maxLen = 400) {
  if (v == null) return null;
  return String(v).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

// Daily-rotating JSONL, mirrors logger.js actions-*.jsonl convention.
function verdictFile(ts) {
  const dateStr = ts.split("T")[0];
  return path.join(LOG_DIR, `verdicts-${dateStr}.jsonl`);
}

function appendRow(row) {
  try {
    ensureDir();
    fs.appendFileSync(verdictFile(row.ts), JSON.stringify(row) + "\n");
  } catch (error) {
    // Persistence must NEVER break the judge path — log and swallow.
    log("verdict_log_warn", `Failed to append verdict: ${error.message}`);
  }
}

/**
 * Record a NATIVE screener verdict (agents/orion.js).
 *   - confidence scale: 0-100
 *   - verdict enum: enter | skip
 * @param {Object} verdict   - { pool_address, decision, confidence, reason }
 * @param {Object} candidate - the `passing` shape { pool, sw, n, ti, mem }
 */
export function recordNativeVerdict(verdict, candidate = {}) {
  const ts = new Date().toISOString();
  const pool = candidate.pool || {};
  const ti = candidate.ti || {};
  appendRow({
    ts,
    path: "native",
    source: "orion",
    confidence_scale: "0-100",
    pool: verdict.pool_address || pool.pool || null,
    symbol: str(pool.name, 60),
    base_mint: pool.base_mint ?? pool.base_token ?? null,
    verdict: verdict.decision === "enter" ? "enter" : "skip",
    confidence: num(verdict.confidence),
    reason: str(verdict.reason, 400),
    recommended_bins_below: num(verdict.recommended_bins_below),
    metrics: {
      mcap: num(pool.mcap),
      tvl: num(pool.tvl ?? pool.active_tvl),
      volume: num(pool.volume_window),
      organic: num(pool.organic_score),
      fee_active_tvl_ratio: num(pool.fee_active_tvl_ratio),
      volatility: num(pool.volatility),
      top10_pct: num(ti?.audit?.top_holders_pct),
      bot_pct: num(ti?.audit?.bot_holders_pct),
    },
  });
}

/**
 * Record every native verdict in a batch (one row each). Order-aligned with
 * the candidates array passed to judgeCandidates.
 */
export function recordNativeVerdicts(verdicts = [], candidates = []) {
  if (!Array.isArray(verdicts)) return;
  for (let i = 0; i < verdicts.length; i++) {
    recordNativeVerdict(verdicts[i], candidates[i] || {});
  }
}

/**
 * Record a SIGNAL-path verdict (signal-judge.js via signal-runner.js).
 *   - confidence scale: 0-1
 *   - verdict enum: enter | watch | skip
 * @param {Object} signal - enriched signal (mcapUsd, vol5mUsd, tvl, organicScore, holders...)
 * @param {Object} llm    - judgeSignalWithLlm output { decision, confidence, reason, maxPositionSol, model }
 */
export function recordSignalVerdict(signal = {}, llm = {}) {
  const ts = new Date().toISOString();
  const e = signal.enrichment || {};
  const decision = ["enter", "watch", "skip"].includes(llm.decision) ? llm.decision : "skip";
  appendRow({
    ts,
    path: "signal",
    source: "signal-judge",
    confidence_scale: "0-1",
    pool: signal.poolAddress ?? e.poolAddress ?? null,
    symbol: str(signal.symbol || signal.name, 60),
    base_mint: signal.tokenAddress ?? null,
    verdict: decision,
    confidence: num(llm.confidence),
    reason: str(llm.reason, 400),
    max_position_sol: num(llm.maxPositionSol),
    model: str(llm.model, 80),
    metrics: {
      mcap: num(signal.mcapUsd ?? e.mcapUsd),
      tvl: num(signal.tvl ?? e.tvl),
      volume: num(signal.vol5mUsd ?? e.volume24h),
      organic: num(signal.organicScore ?? e.organicScore),
      holders: num(signal.holders ?? e.holders),
    },
  });
}
