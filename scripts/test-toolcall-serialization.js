// Orion malformed tool-call serialization fix (2026-07-19) — VPS 2026-07-18/19 incident.
// Run: node scripts/test-toolcall-serialization.js
//
// Root cause under test: a degraded provider emits a tool_call whose
// function.arguments is empty (""), missing (null/undefined), or a non-object JSON
// primitive. The old repair guard `if (tc.function?.arguments)` skipped the
// empty/missing case, so the malformed assistant message was pushed VERBATIM into
// `messages` and poisoned the NEXT request with a REQUEST-side 400
// ("Assistant tool call function.arguments must be a JSON object"). That 400 is not
// model-transient, so the whole fallback ladder re-sent the poisoned payload and
// failed too → cycle threw (CRON_ERROR).
//
// Asserts:
//   - normalizeToolCallArgs coerces empty/missing/non-object args to a valid "{}"
//     and flags them unrecoverable; repairs recoverable single-quote JSON; preserves
//     already-valid object args.
//   - isMalformedToolCallRequestError matches the exact OpenRouter envelope, rejects
//     generic 400 / 502.
//   - sanitizeMessagesToolArgs fixes poisoned assistant tool_calls in-place, is
//     idempotent (0 changes on clean history), ignores non-assistant/no-tool msgs.
//   - agentLoop: a step-0 tool_call with EMPTY args is blocked (not executed) AND the
//     assistant message that lands in history carries arguments "{}" — proving the
//     next request is NOT poisoned; the loop completes without throwing.
//   - agentLoop: a malformed-tool-call REQUEST 400 triggers a same-model
//     sanitize+retry (NOT a model-ladder walk) and recovers.

import assert from "node:assert/strict";

// Stub env BEFORE importing — OpenAI client is constructed at import time.
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";
process.env.LLM_BASE_URL ||= "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

const {
  normalizeToolCallArgs,
  isMalformedToolCallRequestError,
  sanitizeMessagesToolArgs,
  __setCreateForTests,
  agentLoop,
} = await import("../agent.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// 1) normalizeToolCallArgs -----------------------------------------------------------
// The reported failure mode: empty string args (falsy — the old guard skipped these).
{
  const r = normalizeToolCallArgs("");
  check("empty-string args → '{}' and NOT recoverable", r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs(null);
  check("null args → '{}' and NOT recoverable", r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs(undefined);
  check("undefined args → '{}' and NOT recoverable", r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs("   ");
  check("whitespace-only args → '{}' and NOT recoverable", r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs('{"pool_address":"abc","amount_y":0.1}');
  check("valid object-string args pass through, recoverable",
    r.recoverable === true && JSON.parse(r.normalized).amount_y === 0.1);
}
{
  // jsonrepair recovers single-quote JSON — this must stay EXECUTABLE (recoverable).
  const r = normalizeToolCallArgs("{'amount_y': 0.1}");
  check("repairable single-quote JSON → recoverable with real args",
    r.recoverable === true && JSON.parse(r.normalized).amount_y === 0.1);
}
{
  const r = normalizeToolCallArgs("<<<garbage>>>");
  check("unrepairable garbage → '{}' and NOT recoverable", r.normalized === "{}" && r.recoverable === false);
}
// Valid JSON but NOT an object → OpenRouter still rejects it as "must be a JSON object".
{
  const r = normalizeToolCallArgs("null");
  check("JSON 'null' (valid JSON, not object) → '{}' and NOT recoverable",
    r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs("[1,2,3]");
  check("JSON array (valid JSON, not object) → '{}' and NOT recoverable",
    r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs('"hello"');
  check("JSON string primitive → '{}' and NOT recoverable",
    r.normalized === "{}" && r.recoverable === false);
}
{
  const r = normalizeToolCallArgs("42");
  check("JSON number primitive → '{}' and NOT recoverable",
    r.normalized === "{}" && r.recoverable === false);
}
// Some providers hand back an already-parsed object rather than a string.
{
  const r = normalizeToolCallArgs({ amount_y: 0.2 });
  check("object (already parsed, not string) → recoverable canonical string",
    r.recoverable === true && JSON.parse(r.normalized).amount_y === 0.2);
}

// 2) isMalformedToolCallRequestError -------------------------------------------------
check("detects exact OpenRouter envelope",
  isMalformedToolCallRequestError(new Error("Assistant tool call function.arguments must be a JSON object")));
check("detects snake_case tool_call variant",
  isMalformedToolCallRequestError(new Error("tool_call arguments must be a json object")));
check("detects error.error.message shape",
  isMalformedToolCallRequestError({ error: { message: "Assistant tool call function.arguments must be a JSON object" } }));
check("rejects a generic 400 (bad request)",
  !isMalformedToolCallRequestError(new Error("400 Provider returned error")));
check("rejects a 502 transient",
  !isMalformedToolCallRequestError(new Error("502 Bad Gateway")));

// 3) sanitizeMessagesToolArgs --------------------------------------------------------
{
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [
      { id: "t1", type: "function", function: { name: "deploy_position", arguments: "" } },
      { id: "t2", type: "function", function: { name: "get_active_bin", arguments: '{"pool":"x"}' } },
    ] },
  ];
  const fixed = sanitizeMessagesToolArgs(messages);
  check("sanitize fixes the empty-arg tool_call only (count=1)", fixed === 1);
  check("poisoned tool_call arg is now '{}'",
    messages[2].tool_calls[0].function.arguments === "{}");
  check("already-valid tool_call arg is untouched",
    messages[2].tool_calls[1].function.arguments === '{"pool":"x"}');
  // Idempotent — second pass changes nothing.
  check("sanitize is idempotent (0 changes on second pass)",
    sanitizeMessagesToolArgs(messages) === 0);
}
{
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "no tools here" },
    { role: "tool", tool_call_id: "z", content: "{}" },
  ];
  check("sanitize ignores non-assistant / no-tool-call messages (0 changes)",
    sanitizeMessagesToolArgs(messages) === 0);
}

// 4) agentLoop — empty-args tool_call is blocked AND history stays un-poisoned -------
// Step 0: model emits a deploy_position tool_call with arguments "" (empty).
// Expectation: it is NOT executed (blocked as invalid args), and the assistant
// message that lands in `messages` carries arguments "{}" — so the step-1 request
// is NOT poisoned. Step 1: model returns a final answer, loop completes.
{
  const seenPayloads = [];
  let call = 0;
  __setCreateForTests(async (payload) => {
    seenPayloads.push(payload);
    call += 1;
    if (call === 1) {
      return {
        id: "c0", model: payload.model,
        choices: [{
          index: 0, finish_reason: "tool_calls",
          message: {
            role: "assistant", content: null,
            tool_calls: [{ id: "tc_empty", type: "function", function: { name: "deploy_position", arguments: "" } }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      };
    }
    // Step 1: final answer
    return {
      id: "c1", model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done, no deploy", tool_calls: null } }],
      usage: { prompt_tokens: 110, completion_tokens: 4, total_tokens: 114 },
    };
  });

  let threw = false;
  let result;
  try {
    result = await agentLoop("deploy into the best pool now", 5, [], "GENERAL", null, 256);
  } catch {
    threw = true;
  }
  check("empty-args tool_call did NOT crash the loop", !threw);
  check("loop reached a final answer after blocking the empty-args deploy",
    result?.content === "done, no deploy");
  // The step-1 request payload must contain the assistant tool_call with arguments "{}"
  // (normalized), NEVER the empty string — this is the anti-poison assertion.
  const step1 = seenPayloads[1];
  const assistantMsg = step1?.messages?.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
  const deployTc = assistantMsg?.tool_calls?.find(tc => tc.function?.name === "deploy_position");
  check("step-1 request carries the tool_call with normalized '{}' args (no poison)",
    deployTc?.function?.arguments === "{}");
  // And crucially it must be valid JSON that parses to an object.
  let parsedOk = false;
  try { const o = JSON.parse(deployTc.function.arguments); parsedOk = o && typeof o === "object" && !Array.isArray(o); } catch { /* noop */ }
  check("normalized args are valid JSON-object (OpenRouter would accept)", parsedOk);
}

// 5) agentLoop — malformed-tool-call REQUEST 400 → same-model sanitize+retry ---------
// Seed a poisoned sessionHistory (empty-arg tool_call). First create() throws the
// exact request-side 400; the loop should sanitize the history and RETRY THE SAME
// MODEL (not walk the model ladder), then succeed on the cleaned payload.
{
  const models = [];
  let call = 0;
  __setCreateForTests(async (payload) => {
    models.push(payload.model);
    call += 1;
    if (call === 1) {
      const err = new Error("Assistant tool call function.arguments must be a JSON object");
      err.status = 400;
      throw err;
    }
    return {
      id: "cok", model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "recovered", tool_calls: null } }],
      usage: { prompt_tokens: 90, completion_tokens: 3, total_tokens: 93 },
    };
  });

  const poisonedHistory = [
    { role: "user", content: "earlier" },
    { role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "get_wallet_balance", arguments: "" } }] },
    { role: "tool", tool_call_id: "old", content: "{}" },
  ];

  const result = await agentLoop("what is my balance", 5, poisonedHistory, "GENERAL", null, 256);
  check("malformed-request 400 recovered via sanitize+retry", result?.content === "recovered");
  check("recovery used the SAME model (no ladder walk)",
    models.length === 2 && models[0] === models[1]);
  // The poisoned history arg must have been sanitized in place to "{}".
  const histAssistant = poisonedHistory.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
  check("poisoned sessionHistory tool_call arg was sanitized to '{}'",
    histAssistant?.tool_calls?.[0]?.function?.arguments === "{}");
}

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
