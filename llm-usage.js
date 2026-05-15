import fs from "fs";

const LLM_USAGE_FILE = "./llm-usage.json";
const MAX_RECORDS = 2000;

function defaultState() {
  return {
    totals: {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
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

  const record = {
    ts: new Date().toISOString(),
    agent_type: entry?.agentType || "GENERAL",
    model: entry?.model || "unknown",
    step: entry?.step ?? null,
    finish_reason: entry?.finishReason || null,
    tool_calls: num(entry?.toolCalls),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };

  data.records.push(record);
  data.records = data.records.slice(-MAX_RECORDS);
  data.totals.requests += 1;
  data.totals.prompt_tokens += promptTokens;
  data.totals.completion_tokens += completionTokens;
  data.totals.total_tokens += totalTokens;
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
