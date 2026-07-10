import fs from "fs";

const LLM_USAGE_FILE = "./llm-usage.json";
const MAX_RECORDS = 2000;

// Pricing in USD per 1M tokens. Best-effort estimates — verify against
// OpenRouter docs (https://openrouter.ai/models) periodically. Override via
// LLM_PRICING_OVERRIDE_JSON env (a JSON object keyed by model name).
// Fields: { input: number, output: number }
export const MODEL_PRICING_USD_PER_1M = {
  "moonshotai/kimi-k2": { input: 0.55, output: 2.20 },
  // Pillar A (2026-05-23): V4 Flash output corrected 0.30 → 0.20 (stale entry was
  // overcharging cost-guard's daily projection, biasing budget alerts too early).
  "deepseek/deepseek-v4-flash": { input: 0.10, output: 0.20 },
  "deepseek/deepseek-chat": { input: 0.10, output: 0.30 },
  // Pillar A (2026-05-23): deepseek-v4-pro added — premium-tier sibling promoted
  // into screening routing (replaced mimo-v2-pro). Pricing best-effort pending
  // verification against OpenRouter docs; override via LLM_PRICING_OVERRIDE_JSON.
  "deepseek/deepseek-v4-pro": { input: 0.27, output: 1.10 },
  // HOTFIX-1 (2026-05-17): openrouter/hunter-alpha deprecated, replaced by
  // xiaomi/mimo-v2-pro. Pricing below is a best-effort estimate pending
  // confirmation from OpenRouter docs — verify and override via env if needed.
  "xiaomi/mimo-v2-pro": { input: 1.50, output: 5.00 },
  // HOTFIX-4 (2026-05-17): openrouter/healer-alpha deprecated, replaced by
  // xiaomi/mimo-v2-omni. Pricing below is a best-effort estimate (same as
  // mimo-v2-pro) pending confirmation from OpenRouter docs.
  "xiaomi/mimo-v2-omni": { input: 1.50, output: 5.00 },
  "openrouter/healer-alpha": { input: 3.00, output: 15.00 },
  "stepfun/step-3.5-flash:free": { input: 0, output: 0 },  // deprecated (:free removed) — kept for historical audit
  // Deprecation refresh (2026-07-10, Orion) — current fallback-ladder ids after the
  // xiaomi v2 family + stepfun :free tier were retired from OpenRouter. Rates best-effort
  // (mimo-v2.5-pro = same tier as mimo-v2-pro; step-3.7-flash is now PAID, not free)
  // pending OpenRouter-docs confirmation; override via LLM_PRICING_OVERRIDE_JSON.
  "xiaomi/mimo-v2.5-pro": { input: 1.50, output: 5.00 },
  "stepfun/step-3.7-flash": { input: 0.20, output: 0.20 },
  // Conservative catch-all for unknown models
  default: { input: 1.00, output: 3.00 },
};

// Apply env override at module load (non-fatal on parse failure)
try {
  if (process.env.LLM_PRICING_OVERRIDE_JSON) {
    const override = JSON.parse(process.env.LLM_PRICING_OVERRIDE_JSON);
    if (override && typeof override === "object") {
      for (const [k, v] of Object.entries(override)) {
        if (v && typeof v === "object" && Number.isFinite(Number(v.input)) && Number.isFinite(Number(v.output))) {
          MODEL_PRICING_USD_PER_1M[k] = { input: Number(v.input), output: Number(v.output) };
        }
      }
    }
  }
} catch {
  // ignore malformed override
}

export function priceFor(model) {
  if (model && typeof model === "string") {
    if (MODEL_PRICING_USD_PER_1M[model]) return MODEL_PRICING_USD_PER_1M[model];
    // :free suffix is always zero-cost regardless of base model
    if (model.endsWith(":free")) return { input: 0, output: 0 };
  }
  return MODEL_PRICING_USD_PER_1M.default;
}

export function computeCost(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const inputCost = promptTokens * p.input / 1_000_000;
  const outputCost = completionTokens * p.output / 1_000_000;
  return inputCost + outputCost;
}

function defaultState() {
  return {
    totals: {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    },
    records: [],
  };
}

function load() {
  if (!fs.existsSync(LLM_USAGE_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, "utf8"));
    return {
      totals: {
        requests: Number(parsed?.totals?.requests || 0),
        prompt_tokens: Number(parsed?.totals?.prompt_tokens || 0),
        completion_tokens: Number(parsed?.totals?.completion_tokens || 0),
        total_tokens: Number(parsed?.totals?.total_tokens || 0),
        cost_usd: Number(parsed?.totals?.cost_usd || 0),
      },
      records: Array.isArray(parsed?.records) ? parsed.records : [],
    };
  } catch {
    return defaultState();
  }
}

function save(data) {
  fs.writeFileSync(LLM_USAGE_FILE, JSON.stringify(data, null, 2));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function recordLlmUsage(entry) {
  const data = load();
  const promptTokens = num(entry?.usage?.prompt_tokens);
  const completionTokens = num(entry?.usage?.completion_tokens);
  const totalTokens = num(entry?.usage?.total_tokens) || promptTokens + completionTokens;

  const model = entry?.model || "unknown";
  const cost_usd = computeCost(model, { prompt_tokens: promptTokens, completion_tokens: completionTokens });

  const record = {
    ts: new Date().toISOString(),
    agent_type: entry?.agentType || "GENERAL",
    model,
    step: entry?.step ?? null,
    finish_reason: entry?.finishReason || null,
    tool_calls: num(entry?.toolCalls),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost_usd,
  };

  data.records.push(record);
  data.records = data.records.slice(-MAX_RECORDS);
  data.totals.requests += 1;
  data.totals.prompt_tokens += promptTokens;
  data.totals.completion_tokens += completionTokens;
  data.totals.total_tokens += totalTokens;
  data.totals.cost_usd = Number(data.totals.cost_usd || 0) + cost_usd;
  save(data);
  return record;
}

export function getLlmUsageSummary({ hours = 24 } = {}) {
  const data = load();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recent = data.records.filter((record) => {
    const ts = new Date(record.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const byModel = {};
  const byAgent = {};
  for (const record of recent) {
    const model = record.model || "unknown";
    const agent = record.agent_type || "GENERAL";
    byModel[model] ||= { requests: 0, total_tokens: 0 };
    byAgent[agent] ||= { requests: 0, total_tokens: 0 };
    byModel[model].requests += 1;
    byModel[model].total_tokens += num(record.total_tokens);
    byAgent[agent].requests += 1;
    byAgent[agent].total_tokens += num(record.total_tokens);
  }

  return {
    window_hours: hours,
    total_requests: recent.length,
    prompt_tokens: recent.reduce((sum, record) => sum + num(record.prompt_tokens), 0),
    completion_tokens: recent.reduce((sum, record) => sum + num(record.completion_tokens), 0),
    total_tokens: recent.reduce((sum, record) => sum + num(record.total_tokens), 0),
    tool_call_turns: recent.filter((record) => num(record.tool_calls) > 0).length,
    by_model: byModel,
    by_agent: byAgent,
    lifetime_totals: data.totals,
  };
}
