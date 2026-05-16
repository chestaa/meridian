// Smoke test for backtest-harness.js — Lyra
// Run: node scripts/test-backtest-harness.js
// Mocks the OpenAI client via agents/orion.js __setClientForTests seam.
// No real LLM spend.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

// 1) Build fake client. Decision alternates: cand[0]=skip, cand[1]=enter, cand[2]=skip.
let calls = 0;
const fakeClient = {
  chat: { completions: { create: async (payload) => {
    calls += 1;
    const userMsg = payload.messages?.find?.((m) => m.role === "user")?.content || "";
    let parsed = {};
    try { parsed = JSON.parse(userMsg); } catch { /* */ }
    const poolAddr = parsed?.candidate?.pool_address || "UNKNOWN";
    const decision = calls === 2 ? "enter" : "skip";
    const args = {
      pool_address: poolAddr,
      decision,
      confidence: decision === "enter" ? 70 : 20,
      reason: decision === "enter" ? "synthetic enter for test" : "synthetic skip for test",
      recommended_bins_below: 50,
    };
    return {
      id: "chatcmpl-test",
      model: payload.model || "test-model",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `c_${calls}`, type: "function", function: { name: "judge_candidate", arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    };
  }}},
};

const { __setClientForTests } = await import("../agents/orion.js");
__setClientForTests(fakeClient);

// 2) Prepare synthetic fixture JSONL — three candidates, varied so the
// signal-mode Cassiopeia stage will let them all through (mcap in 5k-80k,
// vol >= 1000, distributed >= 0.2).
const fixtureDir = "./.tmp-backtest-test";
const fixtureFile = path.join(fixtureDir, "fixture.jsonl");
if (!fs.existsSync(fixtureDir)) fs.mkdirSync(fixtureDir, { recursive: true });
const fixtureRecords = [
  { ts: "2026-05-16T00:00:00Z", file: "synth1.txt", signal: { source: "manual", name: "Alpha", symbol: "ALPHA", tokenAddress: "Alpha111aaaaapump", mcapUsd: 25000, vol5mUsd: 12000, distributedSol: 0.4, recipientPct: 100 }, llm: { decision: "skip" } },
  { ts: "2026-05-16T00:01:00Z", file: "synth2.txt", signal: { source: "manual", name: "Beta",  symbol: "BETA",  tokenAddress: "Beta222bbbbbbpump", mcapUsd: 40000, vol5mUsd: 18000, distributedSol: 0.9, recipientPct: 80  }, llm: { decision: "skip" } },
  { ts: "2026-05-16T00:02:00Z", file: "synth3.txt", signal: { source: "manual", name: "Gamma", symbol: "GAMM",  tokenAddress: "Gamma333ccccccpump", mcapUsd: 8000,  vol5mUsd: 3000,  distributedSol: 0.5, recipientPct: 90  }, llm: { decision: "enter" } },
];
fs.writeFileSync(fixtureFile, fixtureRecords.map((r) => JSON.stringify(r)).join("\n"), "utf8");

// 3) Run harness — set sentinel so the CLI auto-run block doesn't fire on import.
process.env.BACKTEST_IMPORTED = "1";
const { runBacktest } = await import("./backtest-harness.js");
const outFile = "./.tmp-backtest-test/report.md";
const result = await runBacktest({ source: "jsonl-file", path: fixtureFile, limit: 10, dry: true, orionOnly: false, noLlm: false, output: outFile });

// 4) Cost estimator self-test
const { estimate } = await import("./backtest-cost-estimator.js");
const costEst = estimate({ source: "jsonl-file", path: fixtureFile, limit: 10, model: "moonshotai/kimi-k2" });

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else      { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

check("result.outFile === requested",            result.outFile === outFile);
check("report file exists",                       fs.existsSync(outFile));
check("summary.total === 3",                      result.summary.total === 3);
check("summary.cassPass + cassFail === total",    result.summary.cassPass + result.summary.cassFail === result.summary.total);
check("orionEnter + orionSkip + orionSkipped === total", result.summary.orionEnter + result.summary.orionSkip + result.summary.orionSkipped === result.summary.total);
check("at least one Orion verdict produced",      result.summary.orionEnter + result.summary.orionSkip >= 1);
check("fake client was invoked",                  calls >= 1);
check("rows array matches total",                 result.rows.length === result.summary.total);
check("every row has pool address",               result.rows.every((r) => typeof r.pool === "string" && r.pool.length > 0));
check("every row has cassiopeia object",          result.rows.every((r) => r.cassiopeia && typeof r.cassiopeia.pass === "boolean"));
check("contradictions count is a number",         typeof result.summary.contradictions === "number");
check("totalCostUsd is a number",                 typeof result.totalCostUsd === "number" && result.totalCostUsd >= 0);
check("totalLatencyMs is a number",               typeof result.totalLatencyMs === "number" && result.totalLatencyMs >= 0);

// Report content shape
const report = fs.readFileSync(outFile, "utf8");
check("report has Summary header",                report.includes("## Summary"));
check("report has Per-candidate Results",         report.includes("## Per-candidate Results"));
check("report has Contradictions section",        report.includes("## Highlights"));
check("report has Lyra signoff",                  report.trim().endsWith("— Lyra"));
check("report mentions a synthetic pool",         report.includes("Alpha111aaaaapump") || report.includes("Beta222bbbbbbpump") || report.includes("Gamma333ccccccpump"));

// Cost estimator
check("cost estimator returns 3 candidates",      costEst.candidates === 3);
check("cost estimator returns positive cost",     costEst.costUsd > 0);
check("cost estimator model echoed",              costEst.model === "moonshotai/kimi-k2");

// Cleanup
try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
