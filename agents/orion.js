// Orion-int — LLM Judge (PR 1 of internal multi-agent refactor)
//
// Single-shot LLM judge that pre-scores DLMM candidates BEFORE the fat
// screener agentLoop runs. Modeled on signal-judge.js (proven pattern).
//
// One LLM call PER candidate. Chosen over a single batched call because:
//   - tool_choice=required + one tool schema yields tighter, more reliable
//     structured output from small/free models
//   - per-call token budgets stay tiny (under 1.5KB user msg) so cheap tier
//     of pickModel routing fires consistently
//   - failure of one verdict does not poison the rest; we fall back to a
//     per-candidate "skip" with reason="judge timeout"/"judge error"
//
// The fat screener LLM still runs after Orion — verdicts are advisory.

import "dotenv/config";
import OpenAI from "openai";
import { config, computeDeployAmount } from "../config.js";
import { pickModel } from "../agent.js";
import { log } from "../logger.js";
import { recordLlmUsage } from "../llm-usage.js";
import { assertWithinBudget, BudgetExceededError, getBudgetStatus } from "../cost-guard.js";
import { notifyBudgetExceeded } from "../telegram.js";
import { recordNativeVerdicts } from "../verdict-log.js";

const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

let client = apiKey ? new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey,
  timeout: 60_000,
}) : null;

// Test-only seam: allow scripts/test-orion.js to inject a fake client.
// Production code never calls this.
export function __setClientForTests(fakeClient) { client = fakeClient; }

export const judgeCandidateSchema = {
  type: "function",
  function: {
    name: "judge_candidate",
    description: "Score and decide on a DLMM pool candidate for Meridian LP entry.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pool_address", "decision", "confidence", "reason"],
      properties: {
        pool_address: { type: "string" },
        decision: { type: "string", enum: ["enter", "skip"] },
        confidence: { type: "number", minimum: 0, maximum: 100 },
        reason: { type: "string", maxLength: 400 },
        recommended_bins_below: { type: "number" },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  "You are Orion, Meridian's cautious DLMM pool judge.",
  "Score ONE candidate per call. Output exactly one tool call to judge_candidate.",
  "Decide enter vs skip from: fee/TVL ratio, volume, TVL band, volatility (>0 required),",
  "organic score, holder concentration (top10, bots), bundle/sniper %, narrative quality,",
  "smart wallet presence (boost), pool memory cooldowns (heavy penalty if recent OOR/loss),",
  "launchpad reputation, and mcap band.",
  "Prefer skip when distribution/liquidity quality is unclear or volatility is 0/null.",
  // ── Profit-potential factor (NOT a hard gate) ──────────────────────────────
  // A pool can be perfectly SAFE yet still uneconomic for OUR small position. We
  // earn roughly: our_position / pool_TVL  ×  pool_fees  ×  time_in_range. So the
  // SAME fee/TVL ratio pays us far more in a small-TVL pool than a huge-TVL pool,
  // because our share of the fees scales with our_position/TVL.
  "PROFIT-POTENTIAL FACTOR (weigh it, do NOT hard-reject on it alone): your profit",
  "≈ (our_position / pool_TVL) × pool_fees × time_in_range. Use our_position_sol from",
  "the payload (our typical deploy). GREEN flag: fee/TVL >= 0.10 AND pool TVL small enough",
  "that our_position/TVL gives a non-trivial fee share -> meaningful profit, lean enter.",
  "RED flag: pool TVL so large vs our_position that our fee share is micro (< ~0.05% of",
  "the pool) -> our take is dust ($0.001-class micro-profit), economically not worth the",
  "gas + IL risk even if the pool is 'safe' -> lower confidence / prefer skip. This is a",
  "FACTOR among many, not a new gate: a strong pool with healthy fee/TVL and decent volume",
  "still enters even at larger TVL — only let micro-share DEMOTE a pool that is otherwise",
  "merely borderline. Never skip a clearly good pool solely on TVL size (no dormancy).",
  "confidence is 0-100. reason <= 400 chars, specific and terse.",
  "If you'd enter, suggest recommended_bins_below in [35,69]: low vol -> 35, vol>=5 -> 69, linear.",
].join(" ");

function compactCandidate(c) {
  const pool = c.pool || {};
  const sw = c.sw || {};
  const n = c.n || {};
  const ti = c.ti || {};
  const mem = c.mem || null;
  return {
    pool_address: pool.pool,
    name: pool.name,
    metrics: {
      bin_step: pool.bin_step,
      fee_pct: pool.fee_pct,
      fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
      volume: pool.volume_window,
      tvl: pool.tvl ?? pool.active_tvl,
      volatility: pool.volatility,
      organic: pool.organic_score,
      mcap: pool.mcap,
      age_hours: pool.token_age_hours,
    },
    audit: {
      top10_pct: ti?.audit?.top_holders_pct,
      bot_pct: ti?.audit?.bot_holders_pct,
      fees_paid_sol: ti?.global_fees_sol,
      launchpad: ti?.launchpad ?? null,
    },
    okx: {
      risk_level: pool.risk_level,
      bundle_pct: pool.bundle_pct,
      sniper_pct: pool.sniper_pct,
      suspicious_pct: pool.suspicious_pct,
      rugpull: pool.is_rugpull,
      wash: pool.is_wash,
      smart_money_buy: pool.smart_money_buy ?? false,
      dev_sold_all: pool.dev_sold_all ?? false,
    },
    smart_wallets_in_pool: Array.isArray(sw?.in_pool) ? sw.in_pool.length : 0,
    smart_wallet_names: Array.isArray(sw?.in_pool) ? sw.in_pool.map(w => w.name).slice(0, 5) : [],
    narrative: (n?.narrative || "").slice(0, 280) || null,
    memory: typeof mem === "string" ? mem.slice(0, 280) : null,
  };
}

function skipVerdict(pool_address, reason) {
  return { pool_address, decision: "skip", confidence: 0, reason };
}

/**
 * Pure profit-share hint for the judge prompt (PIECE 1).
 *
 * Computes a DETERMINISTIC, pre-chewed estimate of how much of the pool's fee
 * flow OUR position would capture — small LLMs are unreliable at arithmetic, so
 * we hand them the share % + a tier word instead of asking them to divide.
 *
 *   fee_share_pct ≈ our_position_sol / pool_tvl_sol  (× 100)
 *
 * This is the multiplier on pool fees that lands in OUR pocket. A huge-TVL pool
 * shrinks it toward dust regardless of fee/TVL ratio → the $0.001 micro-profit
 * trap Bro hates. A small-TVL pool with healthy fee/TVL makes it meaningful.
 *
 * FAIL-SAFE (anti-pattern #2): missing/zero/non-finite TVL or position → null
 * (NEUTRAL — no hint, the LLM falls back to its other factors; never fabricate).
 * NOT a gate: returns a hint object only; the decision stays with the LLM.
 *
 * @param {number} positionSol  our typical deploy size in SOL
 * @param {number} tvlUsd        pool TVL in USD
 * @param {number} solUsd        SOL/USD price (to convert position to USD); default 1 keeps it unitless-safe
 * @returns {{ fee_share_pct: number, tier: string }|null}
 */
export function profitShareHint(positionSol, tvlUsd, solUsd = null) {
  const pos = Number(positionSol);
  const tvl = Number(tvlUsd);
  if (!Number.isFinite(pos) || pos <= 0) return null;
  if (!Number.isFinite(tvl) || tvl <= 0) return null;
  // Convert our position to the SAME unit as TVL (USD) when a price is known;
  // when no price is available, compare raw (the RATIO's tier thresholds are
  // chosen to be robust to the unit since TVL >> position either way).
  const price = Number.isFinite(Number(solUsd)) && Number(solUsd) > 0 ? Number(solUsd) : null;
  const posValue = price != null ? pos * price : pos;
  const sharePct = (posValue / tvl) * 100;
  // Tiers: micro share = dust; thin = marginal; healthy = meaningful capture.
  // 0.05% is the RED line from Bro's brief (our take below it = $0.001-class).
  const tier = sharePct < 0.05 ? "micro" : sharePct < 0.2 ? "thin" : "healthy";
  return { fee_share_pct: Number(sharePct.toFixed(4)), tier };
}

async function judgeOne(candidate, context) {
  const pool_address = candidate.pool?.pool;
  if (!pool_address) return skipVerdict("unknown", "missing pool address");
  if (!client) return skipVerdict(pool_address, "LLM API key missing");

  try {
    assertWithinBudget();
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      try { await notifyBudgetExceeded({ status: getBudgetStatus(), caller: "agents/orion.js" }); } catch { /* swallow */ }
      return skipVerdict(pool_address, `budget cap reached (${error.details?.scope || "?"})`);
    }
    throw error;
  }

  const summary = compactCandidate(candidate);

  // PIECE 1 — profit-share hint. Our economic take ≈ our_position/TVL × pool fees.
  // Size our typical deploy from the live wallet when known (computeDeployAmount),
  // else the configured floor. Then hand the LLM a pre-computed fee-share % + tier
  // so it weighs micro-profit ($0.001 trap) WITHOUT having to do arithmetic.
  const walletSol = Number(context?.portfolio?.sol);
  const ourPositionSol = Number.isFinite(walletSol) && walletSol > 0
    ? computeDeployAmount(walletSol)
    : (config.management?.deployAmountSol ?? 0.5);
  const tvlUsd = summary?.metrics?.tvl ?? null;
  const solUsd = Number(context?.solUsd);
  const share = profitShareHint(ourPositionSol, tvlUsd, Number.isFinite(solUsd) ? solUsd : null);

  const userPayload = {
    portfolio_sol: context?.portfolio?.sol ?? null,
    open_positions: context?.positions?.total_positions ?? null,
    our_position_sol: Number(ourPositionSol.toFixed(3)),
    // null when TVL/position unknown → LLM ignores the factor (fail-safe neutral).
    profit_share: share, // { fee_share_pct, tier } | null
    candidate: summary,
  };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ];

  // Phase 3 smart routing — model is picked from config.llm.routing per token estimate.
  const picked = pickModel("SCREENER", messages, [judgeCandidateSchema], null);
  const model = picked.model;

  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: [judgeCandidateSchema],
      tool_choice: { type: "function", function: { name: "judge_candidate" } },
      temperature: 0.1,
      max_tokens: 512,
    });

    const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
    recordLlmUsage({
      agentType: "ORION_JUDGE",
      model,
      step: 1,
      finishReason: response.choices?.[0]?.finish_reason || null,
      toolCalls: toolCall ? 1 : 0,
      usage: response.usage || {},
    });

    if (!toolCall?.function?.arguments) return skipVerdict(pool_address, "judge returned no tool call");

    let args;
    try { args = JSON.parse(toolCall.function.arguments); }
    catch { return skipVerdict(pool_address, "judge returned malformed JSON"); }

    const decision = args.decision === "enter" ? "enter" : "skip";
    const confidence = Math.max(0, Math.min(100, Number(args.confidence ?? 0)));
    const reason = String(args.reason ?? "no reason").slice(0, 400);
    const out = { pool_address: args.pool_address || pool_address, decision, confidence, reason };
    if (args.recommended_bins_below != null && Number.isFinite(Number(args.recommended_bins_below))) {
      out.recommended_bins_below = Number(args.recommended_bins_below);
    }

    // Cassiopeia Option C — live confidence floor. Only active when dryRun===false
    // AND liveOverrides.orionMinConfidence is set. Forces low-confidence enters
    // to skip without changing paper-mode behavior.
    const liveMinConf = (config.dryRun === false && config.liveOverrides?.orionMinConfidence) ?? 0;
    if (out.decision === "enter" && out.confidence < liveMinConf) {
      return {
        ...out,
        decision: "skip",
        reason: `confidence ${out.confidence}% < live floor ${liveMinConf}%; ${out.reason}`,
      };
    }
    return out;
  } catch (error) {
    log("agent", `[ORION] judge error for ${pool_address}: ${error.message}`);
    return skipVerdict(pool_address, `judge timeout/error: ${String(error.message || error).slice(0, 120)}`);
  }
}

/**
 * Judge an array of pre-filtered candidates. Returns one verdict per candidate.
 * @param {Array} candidates - shape from index.js `passing`: [{ pool, sw, n, ti, mem }]
 * @param {Object} context   - { portfolio, positions, lessons, smartWalletHits }
 * @returns {Promise<Array<{pool_address,decision,confidence,reason,recommended_bins_below?}>>}
 */
export async function judgeCandidates(candidates, context = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const verdicts = await Promise.all(candidates.map((c) => judgeOne(c, context)));
  const enter = verdicts.filter(v => v.decision === "enter").length;
  const skip = verdicts.length - enter;
  log("agent", `[ORION] judged ${verdicts.length} candidates: ${enter} enter, ${skip} skip`);
  // Calibration-audit persistence: one JSONL row per verdict (verdict-log.js).
  // Pure local append, no extra LLM cost; never alters verdict behavior.
  recordNativeVerdicts(verdicts, candidates);
  return verdicts;
}

export function formatOrionVerdicts(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return null;
  return verdicts.map(v => `- ${v.pool_address} (${v.decision}, ${Math.round(v.confidence)}%): ${v.reason}${v.recommended_bins_below != null ? ` [rec bins_below=${v.recommended_bins_below}]` : ""}`).join("\n");
}
