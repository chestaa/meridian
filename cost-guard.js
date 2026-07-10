// cost-guard.js
// Hard daily + weekly USD caps on LLM spend, enforced before every chat.completions.create call.
// Reads usage from llm-usage.js (which stores only token counts) and converts tokens → USD
// via a per-model blended rate table. Errors out with BudgetExceededError when caps are hit.
//
// Owned by Vega (execution agent). Spec: docs/audits/2026-05-14-cost-audit-baseline.md (§4, G2).
//
// Usage:
//   import { assertWithinBudget, getBudgetStatus, BudgetExceededError } from "./cost-guard.js";
//   try { assertWithinBudget(); } catch (e) { if (e instanceof BudgetExceededError) { ... } }

import { getLlmUsageSummary } from "./llm-usage.js";

// Daily cap raised 0.75 → 1.10 (Vega, 2026-06-01). Rationale: $0.75 hit at 12:01
// halting LLM rest of day (blind-out) while weekly sat at $1.25/$5. With Orion's
// screener fix (v4-pro → flash, projected ~$0.05/day) actual burn is far below this;
// the higher daily is purely a spike safety-margin. Weekly $5 is the REAL backstop
// and is UNCHANGED — a runaway day still gets caught by the weekly window.
export const DAILY_CAP_USD = 1.10;
export const WEEKLY_CAP_USD = 5.00;
export const ALERT_THRESHOLD_PCT = 0.80;

// Blended USD per 1k tokens (prompt+completion combined).
// Observed values from signal-results.jsonl (see audit Appendix A).
// Unknown models fall through to DEFAULT_RATE_PER_1K — set conservatively high
// so we'd rather over-estimate burn and trigger the cap early than under-count.
const RATE_PER_1K_USD = {
  // Pillar A (2026-05-23): V4 Flash blended rate recalibrated 0.00017 → 0.00015
  // after llm-usage.js pricing correction (output 0.30 → 0.20). Blended avg of
  // (input 0.10 + output 0.20) / 2 = 0.15 per 1M → 0.00015 per 1k.
  "deepseek/deepseek-v4-flash": 0.00015,
  // Pillar A (2026-05-23): deepseek-v4-pro added — premium screening rung.
  // Blended (input 0.27 + output 1.10) / 2 = 0.685 per 1M → 0.000685 per 1k.
  "deepseek/deepseek-v4-pro": 0.000685,
  // HOTFIX-4 (2026-05-17): openrouter/healer-alpha deprecated, kept for audit
  // of historical records. Active replacement: xiaomi/mimo-v2-omni.
  "openrouter/healer-alpha": 0.00017,
  "xiaomi/mimo-v2-omni": 0.000325,        // deprecated (v2 retired) — kept for historical audit
  "xiaomi/mimo-v2-pro": 0.000325,         // deprecated (v2 retired) — kept for historical audit
  "stepfun/step-3.5-flash:free": 0.0,     // deprecated (:free removed) — kept for historical audit
  // Deprecation refresh (2026-07-10, Orion) — current fallback-ladder ids. Rates are
  // best-effort (same tier as their predecessors) pending OpenRouter-docs confirmation.
  "xiaomi/mimo-v2.5-pro": 0.000325,
  "stepfun/step-3.7-flash": 0.0002,
  "minimax/minimax-m2.5": 0.000399,
  "minimax/minimax-m2.7": 0.000399,
};
const DEFAULT_RATE_PER_1K = 0.0005;

export class BudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BudgetExceededError";
    this.details = details;
  }
}

function rateFor(model) {
  if (!model) return DEFAULT_RATE_PER_1K;
  if (Object.prototype.hasOwnProperty.call(RATE_PER_1K_USD, model)) {
    return RATE_PER_1K_USD[model];
  }
  return DEFAULT_RATE_PER_1K;
}

// Convert the by_model token counts from getLlmUsageSummary() into estimated USD.
function estimateUsdFromSummary(summary) {
  const byModel = summary?.by_model || {};
  let usd = 0;
  for (const [model, stats] of Object.entries(byModel)) {
    const tokens = Number(stats?.total_tokens || 0);
    usd += (tokens / 1000) * rateFor(model);
  }
  return usd;
}

/**
 * Snapshot of current burn vs caps. Safe to call cheaply; reads llm-usage.json.
 * @returns {{
 *   daily: { spent: number, cap: number, pct: number, window_hours: 24 },
 *   weekly: { spent: number, cap: number, pct: number, window_hours: 168 },
 *   alertThresholdPct: number
 * }}
 */
export function getBudgetStatus() {
  const daily = getLlmUsageSummary({ hours: 24 });
  const weekly = getLlmUsageSummary({ hours: 168 });
  const dailySpent = estimateUsdFromSummary(daily);
  const weeklySpent = estimateUsdFromSummary(weekly);
  return {
    daily: {
      spent: dailySpent,
      cap: DAILY_CAP_USD,
      pct: DAILY_CAP_USD > 0 ? dailySpent / DAILY_CAP_USD : 0,
      window_hours: 24,
    },
    weekly: {
      spent: weeklySpent,
      cap: WEEKLY_CAP_USD,
      pct: WEEKLY_CAP_USD > 0 ? weeklySpent / WEEKLY_CAP_USD : 0,
      window_hours: 168,
    },
    alertThresholdPct: ALERT_THRESHOLD_PCT,
  };
}

/**
 * Throws BudgetExceededError if today's or this week's estimated spend has reached the cap.
 * Call BEFORE every client.chat.completions.create(). Catch it at the agent loop boundary
 * and abort the cycle gracefully — never let it crash the cron tick.
 */
export function assertWithinBudget() {
  const status = getBudgetStatus();
  if (status.daily.spent >= status.daily.cap) {
    throw new BudgetExceededError(
      `Daily LLM budget exceeded: $${status.daily.spent.toFixed(4)} >= $${status.daily.cap.toFixed(2)}`,
      { scope: "daily", ...status.daily },
    );
  }
  if (status.weekly.spent >= status.weekly.cap) {
    throw new BudgetExceededError(
      `Weekly LLM budget exceeded: $${status.weekly.spent.toFixed(4)} >= $${status.weekly.cap.toFixed(2)}`,
      { scope: "weekly", ...status.weekly },
    );
  }
  return status;
}
