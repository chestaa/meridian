import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
// SCREENER tool-set is intentionally LEAN. Every candidate's enrichment
// (holders/top10/bots/fees, narrative, smart-wallets, OKX risk/tags, active_bin,
// pool memory, mcap/tvl/vol/fee-tvl/organic/volatility/age) is PREFETCHED into
// the candidate blocks of the screening goal (index.js ~line 984) BEFORE this
// loop starts. Exposing the enrichment tools here let the LLM re-fetch data it
// already had — burning ~17s/call and looping until max-steps without ever
// committing to deploy_position (the [SCREENER_STALL] root cause). With the
// re-fetch tools removed, the only forward moves are deploy_position or
// finish/skip — the model is forced to commit on the data already in-prompt.
// Removed: get_top_candidates, check_smart_wallets_on_pool, get_token_holders,
// get_token_narrative, get_token_info, search_pools, get_pool_memory.
// Kept: deploy_position (the action), get_active_bin (per-candidate fallback if
// a prefetch active_bin was null), get_my_positions / get_wallet_balance
// (deploy-time safety reads — pre-deploy count + SOL coverage).
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import { recordLlmUsage } from "./llm-usage.js";
import { assertWithinBudget, BudgetExceededError, getBudgetStatus } from "./cost-guard.js";
import { notifyBudgetExceeded } from "./telegram.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4-flash";

function estimateTokens(messages, tools) {
  return Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools || []).length) / 3.5);
}

export function pickModel(agentType, messages, tools, override) {
  if (override) return { model: override, tier: "override", tokens: null };
  const roleKey = agentType === "SCREENER" ? "screening"
                : agentType === "MANAGER"  ? "management" : "general";
  const tiers = config.llm.routing?.[roleKey];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { model: config.llm[`${roleKey}Model`] || DEFAULT_MODEL, tier: "default", tokens: null };
  }
  const tokens = estimateTokens(messages, tools);
  const sorted = [...tiers].sort((a, b) => (a.maxInputTokens ?? Infinity) - (b.maxInputTokens ?? Infinity));
  const chosen = sorted.find(t => tokens <= (t.maxInputTokens ?? Infinity)) || sorted[sorted.length - 1];
  return { model: chosen.model, tier: chosen.name || chosen.model, tokens };
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

// Vega+Lyra fix #1 — treat OpenRouter 400s as transient (sometimes deepseek/deepseek-v4-flash
// emits bad-request envelopes that succeed on retry with a fallback model). Detect via both
// thrown APIError (error.status) and response-body error code shapes.
function is400Error(error) {
  if (error?.status === 400) return true;
  if (error?.error?.code === 400) return true;
  const message = String(error?.message || error?.error?.message || error || "");
  // OpenRouter's exact 400 envelope is "400 Provider returned error" — match that too.
  if (/\b400\b/.test(message) && /provider returned error/i.test(message)) return true;
  return /\b400\b/.test(message) && /(bad request|invalid_request_error|invalid request)/i.test(message);
}

// Orion deeper fix (2026-05-19) — provider-diverse 400 fallback ladder.
// Diagnostic showed 5/5 of 400s in the 48h window all came from deepseek/deepseek-v4-flash
// via OpenRouter's intermittent upstream routing. Single fallback to a free model is brittle
// (rate-limited, tool-handling weaker). The ladder tries a sibling paid model first, then a
// premium model already in routing, and only then the free model as last resort. Each step
// is provider-diverse so a regional/upstream issue on one route doesn't poison the others.
//
// Ordering rule: skip any model that equals the currently-failing one (no self-fallback).
// Ladder cap = total attempts in the outer for-loop (3) so this can never run forever.
// Pillar A reshape (2026-05-23) — provider-diverse ladder after kimi-k2/mimo-v2-pro
// retirement from routing. Routing now defaults to deepseek/deepseek-v4-flash across
// all rungs, so the fallback ladder MUST use different providers to recover from
// upstream/regional OR outages. Order: mimo-v2.5-pro (xiaomi, distinct provider) →
// deepseek-v4-pro (sibling paid, different upstream) → step-3.7-flash (last resort).
// Deprecation refresh (2026-07-10, Orion) — OpenRouter retired the ENTIRE v2 xiaomi
// family (v2 → v2.5) and the stepfun `step-3.5-flash:free` free variant, which surfaced
// as intermittent "This model has been deprecated" errors on the screening/health cron
// whenever a deepseek-v4-flash 400 tripped the ladder. Aligned to current valid ids
// (verified against OpenRouter /api/v1/models): mimo-v2.5-pro, deepseek-v4-pro (still
// valid), step-3.7-flash. NOTE for Lyra: rung 3 is no longer a $0 free model — the
// stepfun free tier was removed; step-3.7-flash is paid. Only ever hit as a last-resort
// after two prior 400s, so cost impact is negligible.
const FALLBACK_LADDER_400 = [
  "xiaomi/mimo-v2.5-pro",        // distinct provider (xiaomi) — first defense vs deepseek upstream issues
  "deepseek/deepseek-v4-pro",    // sibling paid model — different model id, still deepseek but premium tier
  "stepfun/step-3.7-flash",      // provider-diverse last-resort (was step-3.5-flash:free, now deprecated)
];

function next400Fallback(currentModel, attemptedFallbacks) {
  for (const candidate of FALLBACK_LADDER_400) {
    if (candidate === currentModel) continue;
    if (attemptedFallbacks.has(candidate)) continue;
    return candidate;
  }
  return null;
}

// Vega+Lyra fix #2 — extract Orion ENTER verdicts from the screener goal text so the
// agentLoop can both (a) force tool_choice and (b) detect a stall when ENTER existed
// but no deploy_position fired. Returns array of { pool, confidence } parsed from
// lines of the form: "- <pool> (enter, NN%): <reason>".
function parseOrionEnterVerdicts(goal) {
  if (!goal || typeof goal !== "string") return [];
  if (!/ORION PRE-JUDGMENT/i.test(goal)) return [];
  const out = [];
  const re = /^\s*-\s+([A-Za-z0-9]{20,})\s+\(enter,\s*(\d+)%\)/gim;
  let m;
  while ((m = re.exec(goal)) !== null) {
    out.push({ pool: m[1], confidence: parseInt(m[2], 10) });
  }
  return out;
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  // Vega+Lyra fix #2/#3 — capture Orion ENTER verdicts referenced in this cycle.
  // Used to (a) escalate tool_choice on the first SCREENER step when a high-confidence
  // ENTER exists, and (b) detect SCREENER_STALL when the loop exits without deploy.
  const orionEnterVerdicts = parseOrionEnterVerdicts(goal);
  const hasHighConfEnter = orionEnterVerdicts.some((v) => v.confidence >= 70);
  let deployToolFired = false;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const roleTools = getToolsForRole(agentType, goal);
      const picked = pickModel(agentType, messages, roleTools, model);
      const activeModel = picked.model;
      log("llm_route", `role=${agentType} tier=${picked.tier} model=${picked.model} tokens=${picked.tokens ?? "n/a"} step=${step + 1}`);

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.7-flash";
      let response;
      let usedModel = activeModel;
      // Orion deeper fix — track which fallback models we've already tried for 400 errors
      // this step. Combined with FALLBACK_LADDER_400 to give provider-diverse retries.
      const attempted400Fallbacks = new Set();
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      // Vega+Lyra fix #2 — SCREENER escalation: when Orion has emitted at least one
      // ENTER verdict with confidence >= 70% AND deploy hasn't fired yet, force
      // tool_choice=required so the model can't end with a free-text "Let me verify..."
      // Polaris guidance: only at >=70% confidence — too aggressive at lower conf
      // risks forcing low-quality deploys. MANAGER + GENERAL preserved (auto/intent).
      if (agentType === "SCREENER" && hasHighConfEnter && !deployToolFired && toolChoice !== "required") {
        toolChoice = "required";
        log("agent", `[SCREENER_TOOL_CHOICE_FORCED] orion_enter_high_conf=${orionEnterVerdicts.filter(v => v.confidence >= 70).length} step=${step + 1}`);
      }

      // Vega+Lyra fix #1 (HOTFIX-6) + Orion deeper fix (2026-05-19) — 400 retry budget.
      // Capped at 3 total attempts (initial + up to 2 fallback rungs on the ladder).
      // Resets per-step. Multi-rung tracking is done via attempted400Fallbacks (Set).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Cost guard — hard daily/weekly USD cap. Throws BudgetExceededError if reached.
          // Caught below at the outer try/catch boundary for graceful cycle abort.
          assertWithinBudget();
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: roleTools,
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          // Vega+Lyra fix #1 (HOTFIX-6) + Orion deeper fix (2026-05-19) — OpenRouter
          // intermittently 400s on deepseek/deepseek-v4-flash via routing variability.
          // Walk a provider-diverse fallback ladder before giving up. Each rung is a
          // distinct paid provider so a single upstream regional issue can't poison
          // the chain. Free model is last resort (preserves HOTFIX-6 behavior).
          if (is400Error(error)) {
            attempted400Fallbacks.add(usedModel);
            const nextModel = next400Fallback(usedModel, attempted400Fallbacks);
            if (nextModel) {
              log("agent", `[LLM_400_RETRY] model=${usedModel} 400 → falling back to ${nextModel} (rung ${attempted400Fallbacks.size}/${FALLBACK_LADDER_400.length})`);
              usedModel = nextModel;
              attempt -= 1;
              continue;
            }
            log("agent", `[LLM_400_EXHAUSTED] all ladder rungs failed for model=${activeModel}. Ladder=${[...attempted400Fallbacks].join(",")}`);
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      recordLlmUsage({
        agentType,
        model: usedModel,
        step: step + 1,
        finishReason: response.choices[0]?.finish_reason || null,
        toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
        usage: response.usage || {},
      });
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            // Vega+Lyra fix #3 — stall on tool-required exhaustion path too.
            if (agentType === "SCREENER" && !deployToolFired && orionEnterVerdicts.length > 0) {
              const enterCount = orionEnterVerdicts.length;
              const highConfCount = orionEnterVerdicts.filter(v => v.confidence >= 70).length;
              const snippet = String(msg.content || "").slice(0, 200).replace(/\s+/g, " ");
              log("screener_stall", `Orion ENTER but tool-required exhausted without deploy. enter_verdicts=${enterCount} high_conf=${highConfCount}. Final text: ${snippet}`);
            }
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        // Vega+Lyra fix #3 — SCREENER stall detection. If Orion emitted at least one
        // ENTER verdict for this cycle but the screener loop exited without ever
        // calling deploy_position, log loudly. This makes "Good candidate. Let me
        // verify..." style stalls visible immediately instead of post-hoc.
        if (agentType === "SCREENER" && !deployToolFired && orionEnterVerdicts.length > 0) {
          const enterCount = orionEnterVerdicts.length;
          const highConfCount = orionEnterVerdicts.filter(v => v.confidence >= 70).length;
          const snippet = String(msg.content || "").slice(0, 200).replace(/\s+/g, " ");
          log("screener_stall", `Orion ENTER but loop exited without deploy. enter_verdicts=${enterCount} high_conf=${highConfCount}. Final text: ${snippet}`);
        }
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        if (functionName === "deploy_position") deployToolFired = true;
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      // Budget guard: abort current cycle gracefully without crashing the cron tick.
      if (error instanceof BudgetExceededError) {
        log("error", `Cost guard triggered: ${error.message}`);
        // Vega fix #1 — loud, dedicated Telegram alert (12h throttled in helper).
        // Wrapped: alert failure must NOT escalate the budget error.
        try {
          await notifyBudgetExceeded({ status: getBudgetStatus(), caller: "agent.js" });
        } catch (alertErr) {
          log("telegram_error", `Budget alert dispatch failed: ${alertErr.message}`);
        }
        return {
          content: `LLM budget cap reached (${error.details?.scope || "?"}). Cycle aborted to preserve spend. Reset or raise caps in cost-guard.js to resume.`,
          userMessage: goal,
          budgetExceeded: true,
          budgetDetails: error.details || null,
        };
      }
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  // Vega+Lyra fix #3 — also fire SCREENER_STALL on max-steps exit (loop ran out
  // without ever deploying despite Orion ENTER signal).
  if (agentType === "SCREENER" && !deployToolFired && orionEnterVerdicts.length > 0) {
    const enterCount = orionEnterVerdicts.length;
    const highConfCount = orionEnterVerdicts.filter(v => v.confidence >= 70).length;
    log("screener_stall", `Orion ENTER but max-steps reached without deploy. enter_verdicts=${enterCount} high_conf=${highConfCount}.`);
  }
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test seam — let unit tests stub the OpenAI completions.create call.
// Production code never calls this; it overwrites the create() method only.
export function __setCreateForTests(fakeCreate) {
  client.chat.completions.create = fakeCreate;
}

// Exposed for unit testing — not part of the public agent API.
export { is400Error, parseOrionEnterVerdicts, next400Fallback, FALLBACK_LADDER_400, getToolsForRole, SCREENER_TOOLS };
