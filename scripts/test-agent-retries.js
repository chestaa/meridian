// Test for Vega+Lyra fix #1 (HOTFIX-6) + Orion deeper fix (2026-05-19) —
// 400 retry/fallback ladder in agent.js.
// Run: node scripts/test-agent-retries.js
// Asserts:
//   - is400Error detects thrown-status, error.code, and message-based 400s
//   - is400Error matches OpenRouter's exact "400 Provider returned error" envelope
//   - is400Error does NOT match 502/503/529 transients
//   - On 400, agentLoop walks the provider-diverse fallback ladder
//   - First fallback is deepseek/deepseek-chat (sibling paid model), NOT stepfun free
//   - On repeated 400 across all rungs, the error bubbles up (no infinite loop)
//   - Ladder skips the failing model (no self-fallback)

import assert from "node:assert/strict";

// Stub env BEFORE importing — OpenAI client is constructed at import time.
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";
process.env.LLM_BASE_URL ||= "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

const {
  is400Error,
  __setCreateForTests,
  agentLoop,
  next400Fallback,
  FALLBACK_LADDER_400,
} = await import("../agent.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// 1) is400Error unit assertions ----------------------------------------------------
check("is400Error detects thrown APIError (status=400)", is400Error({ status: 400 }));
check("is400Error detects response.error.code=400 wrapper", is400Error({ error: { code: 400, message: "bad" } }));
check("is400Error detects 400 in message text", is400Error(new Error("HTTP 400 bad request from upstream")));
check("is400Error matches OpenRouter '400 Provider returned error' envelope (deeper fix)",
  is400Error(new Error("400 Provider returned error")));
check("is400Error rejects 502 transient", !is400Error({ status: 502 }));
check("is400Error rejects 529 transient", !is400Error({ status: 529 }));
check("is400Error rejects generic Error", !is400Error(new Error("network down")));

// 1b) next400Fallback ladder unit assertions (Orion deeper fix) --------------------
check("FALLBACK_LADDER_400 is non-empty",
  Array.isArray(FALLBACK_LADDER_400) && FALLBACK_LADDER_400.length > 0);
// Pillar A reshape (2026-05-23): ladder is now [mimo, deepseek-v4-pro, stepfun]
// to preserve provider diversity after routing collapsed to deepseek-v4-flash everywhere.
// Deprecation refresh (2026-07-10, Orion): ids realigned to current OpenRouter catalog
// (mimo-v2.5-pro, deepseek-v4-pro, step-3.7-flash) after v2 family + stepfun :free retired.
check("ladder first rung is xiaomi/mimo-v2.5-pro (distinct provider, not free)",
  FALLBACK_LADDER_400[0] === "xiaomi/mimo-v2.5-pro");
check("ladder contains premium tier sibling (deepseek/deepseek-v4-pro)",
  FALLBACK_LADDER_400.includes("deepseek/deepseek-v4-pro"));
check("ladder ends with stepfun step-3.7-flash as last resort",
  FALLBACK_LADDER_400[FALLBACK_LADDER_400.length - 1] === "stepfun/step-3.7-flash");
check("next400Fallback skips the failing model (no self-fallback)",
  next400Fallback("xiaomi/mimo-v2.5-pro", new Set()) !== "xiaomi/mimo-v2.5-pro");
check("next400Fallback skips already-attempted rungs",
  next400Fallback("deepseek/deepseek-v4-flash", new Set(["xiaomi/mimo-v2.5-pro"])) === "deepseek/deepseek-v4-pro");
check("next400Fallback returns null when all rungs exhausted",
  next400Fallback("deepseek/deepseek-v4-flash", new Set(FALLBACK_LADDER_400)) === null);

// 2) agentLoop falls back to first ladder rung (deepseek-chat) on 400 then completes
// We avoid the full screener network of imports by driving GENERAL goal with NO tool
// expectation — the model returns final text in one turn.
const FALLBACK_MODEL = "stepfun/step-3.7-flash";
// Pillar A reshape (2026-05-23): first rung is now xiaomi/mimo-v2.5-pro (2026-07-10 refresh)
const EXPECTED_FIRST_RUNG = "xiaomi/mimo-v2.5-pro";
const callLog = [];

let attemptIdx = 0;
__setCreateForTests(async (payload) => {
  callLog.push({ model: payload.model, attempt: attemptIdx });
  if (attemptIdx === 0) {
    attemptIdx += 1;
    const err = new Error("HTTP 400 bad request: invalid_request_error from deepseek/deepseek-v4-flash");
    err.status = 400;
    throw err;
  }
  attemptIdx += 1;
  // Second attempt: return a valid final-answer response
  return {
    id: "chatcmpl-retry",
    model: payload.model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "fallback succeeded", tool_calls: null },
    }],
    usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
  };
});

const goal1 = "show me the latest performance history";
const result1 = await agentLoop(goal1, 5, [], "GENERAL", null, 256);
check("agentLoop returned final content after 400 fallback", result1?.content === "fallback succeeded");
check("first attempt used the original (non-fallback) model", callLog[0]?.model && callLog[0].model !== FALLBACK_MODEL);
check("second attempt used FIRST LADDER RUNG (mimo-v2.5-pro, not stepfun)",
  callLog[1]?.model === EXPECTED_FIRST_RUNG);
check("first fallback is NOT the last-resort model (deeper fix prefers paid sibling)",
  callLog[1]?.model !== FALLBACK_MODEL);
check("exactly two attempts (no infinite retry)", callLog.length === 2);

// 2b) When BOTH first rung AND second rung fail with 400, agent climbs to third rung
const callLog1b = [];
attemptIdx = 0;
__setCreateForTests(async (payload) => {
  callLog1b.push({ model: payload.model });
  // First two attempts fail with 400, third succeeds
  if (callLog1b.length <= 2) {
    const err = new Error("400 Provider returned error");
    err.status = 400;
    throw err;
  }
  return {
    id: "chatcmpl-rung3",
    model: payload.model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "third rung succeeded", tool_calls: null },
    }],
    usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
  };
});

const result1b = await agentLoop("show performance again", 5, [], "GENERAL", null, 256);
check("ladder climbs through 3 rungs when first 2 fail with 400",
  result1b?.content === "third rung succeeded");
check("3rd attempt used a different model than 1st and 2nd",
  callLog1b.length === 3
    && callLog1b[2].model !== callLog1b[0].model
    && callLog1b[2].model !== callLog1b[1].model);
check("ladder progression: original → rung1 (mimo-v2.5-pro) → rung2 (deepseek-v4-pro)",
  callLog1b[1].model === "xiaomi/mimo-v2.5-pro"
    && callLog1b[2].model === "deepseek/deepseek-v4-pro");

// 3) Persistent 400 across ALL ladder rungs bubbles up (cap respected) -------------
attemptIdx = 0;
const callLog2 = [];
__setCreateForTests(async (payload) => {
  callLog2.push({ model: payload.model });
  const err = new Error("400 Provider returned error");
  err.status = 400;
  throw err;
});

let bubbled = false;
try {
  await agentLoop("show me the latest performance history again", 5, [], "GENERAL", null, 256);
} catch (e) {
  bubbled = true;
  check("error message references 400/bad request", /400|bad request/i.test(e.message));
}
check("persistent 400 bubbles up after entire ladder exhausted", bubbled);
// Ladder cap: 1 (original) + N ladder rungs. With FALLBACK_LADDER_400.length rungs
// the absolute upper bound is 1 + ladder.length. Self-fallback skip in ladder
// prevents repeats so this is finite and bounded.
check("no more than 1+ladder rungs attempts on persistent 400 (no runaway)",
  callLog2.length <= 1 + FALLBACK_LADDER_400.length);
check("ladder distinct models attempted (no self-retry)",
  new Set(callLog2.map(c => c.model)).size === callLog2.length);

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
