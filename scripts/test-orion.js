// Test for agents/orion.js — mocks OpenAI HTTP layer via global fetch stub.
// Run: node scripts/test-orion.js
// Does NOT spend real LLM tokens. Asserts verdict shape on 3 synthetic candidates.

import assert from "node:assert/strict";

// 1) Stub env BEFORE importing orion (so the OpenAI client is constructed).
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

// 2) Build a fake OpenAI-shaped client and inject via the test seam.
let fetchCallCount = 0;
const fakeClient = {
  chat: {
    completions: {
      create: async (payload) => {
        fetchCallCount += 1;
        const userMsg = payload.messages?.find?.((m) => m.role === "user")?.content || "";
        let parsedUser = {};
        try { parsedUser = JSON.parse(userMsg); } catch { /* ignore */ }
        const poolAddr = parsedUser?.candidate?.pool_address || "UNKNOWN_POOL";
        const decision = fetchCallCount % 2 === 0 ? "enter" : "skip";
        const args = {
          pool_address: poolAddr,
          decision,
          confidence: decision === "enter" ? 72 : 18,
          reason: decision === "enter" ? "good fee/tvl and smart wallets" : "low volatility and bots high",
          recommended_bins_below: 50,
        };
        return {
          id: "chatcmpl-test",
          model: payload.model || "test-model",
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_test_" + fetchCallCount,
                type: "function",
                function: { name: "judge_candidate", arguments: JSON.stringify(args) },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        };
      },
    },
  },
};

// 3) Import orion AFTER env is set, then inject fake client.
const { judgeCandidates, formatOrionVerdicts, judgeCandidateSchema, __setClientForTests } = await import("../agents/orion.js");
__setClientForTests(fakeClient);

// 4) Synthetic candidates matching index.js `passing` shape.
const candidates = [
  {
    pool: { pool: "PoolAAA111", name: "AAA-SOL", bin_step: 100, fee_pct: 1, fee_active_tvl_ratio: 0.08, volume_window: 12000, tvl: 50000, volatility: 3.2, organic_score: 75, mcap: 800000, token_age_hours: 24 },
    sw: { in_pool: [{ name: "kol1" }] },
    n: { narrative: "trending meme" },
    ti: { audit: { top_holders_pct: 40, bot_holders_pct: 12 }, global_fees_sol: 80, launchpad: null },
    mem: null,
  },
  {
    pool: { pool: "PoolBBB222", name: "BBB-SOL", bin_step: 100, fee_pct: 1, fee_active_tvl_ratio: 0.04, volume_window: 600, tvl: 12000, volatility: 1.1, organic_score: 62, mcap: 200000, token_age_hours: 10 },
    sw: { in_pool: [] },
    n: { narrative: null },
    ti: { audit: { top_holders_pct: 58, bot_holders_pct: 25 }, global_fees_sol: 35, launchpad: null },
    mem: "OOR twice last week",
  },
  {
    pool: { pool: "PoolCCC333", name: "CCC-SOL", bin_step: 80, fee_pct: 0.8, fee_active_tvl_ratio: 0.12, volume_window: 25000, tvl: 80000, volatility: 4.8, organic_score: 88, mcap: 1500000, token_age_hours: 48 },
    sw: { in_pool: [{ name: "alpha1" }, { name: "alpha2" }] },
    n: { narrative: "real product launch" },
    ti: { audit: { top_holders_pct: 35, bot_holders_pct: 8 }, global_fees_sol: 120, launchpad: null },
    mem: null,
  },
];

// 5) Assertions.
const verdicts = await judgeCandidates(candidates, { portfolio: { sol: 2.5 }, positions: { total_positions: 0 } });

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

check("schema export name", judgeCandidateSchema?.function?.name === "judge_candidate");
check("verdicts is array", Array.isArray(verdicts));
check("verdicts length matches candidates", verdicts.length === 3);
check("fetch was called once per candidate", fetchCallCount === 3);

for (let i = 0; i < verdicts.length; i++) {
  const v = verdicts[i];
  check(`verdict[${i}] has pool_address`, typeof v.pool_address === "string" && v.pool_address.length > 0);
  check(`verdict[${i}] decision is enter|skip`, v.decision === "enter" || v.decision === "skip");
  check(`verdict[${i}] confidence 0..100`, typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 100);
  check(`verdict[${i}] reason is string`, typeof v.reason === "string" && v.reason.length > 0);
  check(`verdict[${i}] pool_address matches candidate`, v.pool_address === candidates[i].pool.pool);
}

const formatted = formatOrionVerdicts(verdicts);
check("formatOrionVerdicts returns string", typeof formatted === "string" && formatted.includes("PoolAAA111"));
check("formatOrionVerdicts contains decision tag", /\((enter|skip),/.test(formatted));

// Empty input contract.
const empty = await judgeCandidates([], {});
check("empty input returns []", Array.isArray(empty) && empty.length === 0);

console.log(`\n${passed} assertions passed.`);

if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
