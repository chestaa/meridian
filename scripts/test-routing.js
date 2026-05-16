// Smoke test: stub env vars so OpenAI client init doesn't throw on import.
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.OPENAI_API_KEY ||= "test-stub-key";

const { pickModel } = await import("../agent.js");

const cases = [
  { name: "tiny screening",   agentType: "SCREENER", size: 500,    expectedTier: "compact" },
  { name: "medium screening", agentType: "SCREENER", size: 18000,  expectedTier: "workhorse" },
  { name: "large screening",  agentType: "SCREENER", size: 120000, expectedTier: "premium" },
  { name: "tiny mgmt",        agentType: "MANAGER",  size: 500,    expectedTier: "compact" },
  { name: "big mgmt",         agentType: "MANAGER",  size: 50000,  expectedTier: "workhorse" },
  { name: "override",         agentType: "GENERAL",  size: 500,    override: "anthropic/claude-3.5-sonnet", expectedTier: "override" },
  // Phase 3 fix: callers must pass null to trigger tier-based routing (not override)
  { name: "null override SCREENER", agentType: "SCREENER", size: 500,   override: null,      expectedTier: "compact" },
  { name: "null override MANAGER",  agentType: "MANAGER",  size: 50000, override: null,      expectedTier: "workhorse" },
  { name: "undef override GENERAL", agentType: "GENERAL",  size: 500,   override: undefined, expectedTier: "compact" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const messages = [{ role: "user", content: "x".repeat(c.size) }];
  const result = pickModel(c.agentType, messages, [], c.override);
  const ok = result.tier === c.expectedTier;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: tier=${result.tier} model=${result.model} tokens=${result.tokens ?? "n/a"}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
