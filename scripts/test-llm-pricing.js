// scripts/test-llm-pricing.js
// Orion — verify cost_usd is populated correctly in llm-usage.json records.
//
// Strategy: redirect LLM_USAGE_FILE indirection via a temp file isolated to
// this test by writing to a sibling path and asserting via the exported
// computeCost/priceFor (pure functions).

import { computeCost, priceFor, MODEL_PRICING_USD_PER_1M } from "../llm-usage.js";

let passed = 0;
let failed = 0;
const results = [];

function assert(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    results.push(`PASS  ${name}`);
  } else {
    failed += 1;
    results.push(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

// 1. kimi-k2: 1000 input + 500 output → 0.55*1000/1M + 2.20*500/1M = 0.00055 + 0.0011 = 0.00165
{
  const cost = computeCost("moonshotai/kimi-k2", { prompt_tokens: 1000, completion_tokens: 500 });
  assert("kimi-k2 cost = 0.00165", approx(cost, 0.00165), `got ${cost}`);
}

// 2. deepseek v4 flash: 1000 + 500 → 0.10*1000/1M + 0.20*500/1M = 0.0001 + 0.0001 = 0.0002
// Pillar A (2026-05-23): output rate corrected 0.30 → 0.20.
{
  const cost = computeCost("deepseek/deepseek-v4-flash", { prompt_tokens: 1000, completion_tokens: 500 });
  assert("deepseek-v4-flash cost = 0.0002", approx(cost, 0.0002), `got ${cost}`);
}

// 3. healer-alpha (premium): 1000 + 500 → 3.0*1000/1M + 15.0*500/1M = 0.003 + 0.0075 = 0.0105
{
  const cost = computeCost("openrouter/healer-alpha", { prompt_tokens: 1000, completion_tokens: 500 });
  assert("healer-alpha cost = 0.0105", approx(cost, 0.0105), `got ${cost}`);
}

// 4. :free model — always zero
{
  const cost = computeCost("stepfun/step-3.5-flash:free", { prompt_tokens: 5000, completion_tokens: 2000 });
  assert(":free model cost = 0", cost === 0, `got ${cost}`);
}

// 5. Arbitrary :free suffix (model not in map but ends with :free) — zero
{
  const cost = computeCost("some/unknown-model:free", { prompt_tokens: 10000, completion_tokens: 5000 });
  assert("unknown :free model cost = 0", cost === 0, `got ${cost}`);
}

// 6. Unknown model — uses default pricing (1.0 / 3.0)
//    1000 + 500 → 1.0*1000/1M + 3.0*500/1M = 0.001 + 0.0015 = 0.0025
{
  const cost = computeCost("totally/unknown-model", { prompt_tokens: 1000, completion_tokens: 500 });
  assert("unknown model uses default = 0.0025", approx(cost, 0.0025), `got ${cost}`);
}

// 7. Zero tokens → zero cost
{
  const cost = computeCost("moonshotai/kimi-k2", { prompt_tokens: 0, completion_tokens: 0 });
  assert("zero tokens cost = 0", cost === 0, `got ${cost}`);
}

// 8. No usage object → zero
{
  const cost = computeCost("moonshotai/kimi-k2", null);
  assert("null usage cost = 0", cost === 0, `got ${cost}`);
}

// 9. priceFor returns object with input/output
{
  const p = priceFor("moonshotai/kimi-k2");
  assert("priceFor returns {input, output}", typeof p.input === "number" && typeof p.output === "number");
}

// 10. priceFor unknown → default
{
  const p = priceFor("nonexistent/model");
  assert("priceFor unknown → default", p === MODEL_PRICING_USD_PER_1M.default);
}

// 11. Map contains all expected models
{
  const expected = [
    "moonshotai/kimi-k2",
    "deepseek/deepseek-v4-flash",
    "xiaomi/mimo-v2-pro",
    "openrouter/healer-alpha",
    "stepfun/step-3.5-flash:free",
    "default",
  ];
  const missing = expected.filter(k => !MODEL_PRICING_USD_PER_1M[k]);
  assert("all expected models present", missing.length === 0, `missing: ${missing.join(",")}`);
}

// 12. End-to-end: recordLlmUsage populates cost_usd field
{
  // We test in isolation by importing recordLlmUsage and inspecting the returned record.
  // Note: this writes to ./llm-usage.json — acceptable as it appends a real record.
  const { recordLlmUsage } = await import("../llm-usage.js");
  const rec = recordLlmUsage({
    agentType: "TEST_PRICING",
    model: "moonshotai/kimi-k2",
    step: 0,
    finishReason: "test",
    toolCalls: 0,
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
  });
  assert("recordLlmUsage returns cost_usd", approx(rec.cost_usd, 0.00165), `got ${rec.cost_usd}`);
}

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) process.exit(1);
