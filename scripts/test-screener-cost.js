// Orion cost fix (2026-06-01) — guards the SCREENER cost-center fix.
// Run: node scripts/test-screener-cost.js
// Asserts (config-driven, reversible):
//   - screening routing tier never escalates to a v4-pro / premium model
//   - screening is bounded to a lower ReAct step cap than the global maxSteps
//   - the prompt candidate cap is set (bounds prompt-token bloat)
//   - pickModel for SCREENER returns a flash-tier model even for a large prompt
//     (the >8000-token case that previously selected v4-pro)

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";
process.env.DRY_RUN = "true";

const { config } = await import("../config.js");
const { pickModel } = await import("../agent.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
}

console.log("SCREENER cost-center guards:");

// 1. Routing must be flash-only — no v4-pro / "pro" / premium escalation.
const screeningTiers = config.llm.routing?.screening || [];
check("screening routing is configured", screeningTiers.length > 0);
for (const tier of screeningTiers) {
  check(
    `screening tier "${tier.name}" model is not a premium/pro model (${tier.model})`,
    !/(-pro\b|premium)/i.test(tier.model),
  );
  check(
    `screening tier "${tier.name}" uses a flash-class model (${tier.model})`,
    /flash/i.test(tier.model),
  );
}

// 2. Step cap — screening must stay bounded below the global default (cost guard),
//    but ALSO be large enough to actually complete an enrichment + deploy sequence.
//    Orion 2026-06-13: raised 8 → 16. At 8 the SCREENER loop exhausted in the
//    enrichment batch BEFORE reaching deploy_position → [SCREENER_STALL] despite
//    an Orion ENTER. A full top-1 deploy needs ~7 steps worst-case (enrichment
//    batch + deploy reasoning + deploy_position + ACK), so the cap must clear that
//    with buffer. Cost stays flat: deploy_position is NO_RETRY and the loop exits
//    on ACK, so the extra budget is consumed only on cycles that actually deploy.
check("screeningMaxSteps is defined", typeof config.llm.screeningMaxSteps === "number");
check(
  `screeningMaxSteps (${config.llm.screeningMaxSteps}) < global maxSteps (${config.llm.maxSteps})`,
  config.llm.screeningMaxSteps < config.llm.maxSteps,
);
check(
  `screeningMaxSteps (${config.llm.screeningMaxSteps}) >= 12 (room for enrichment batch + deploy + ACK)`,
  config.llm.screeningMaxSteps >= 12,
);
check(
  `screeningMaxSteps (${config.llm.screeningMaxSteps}) <= 18 (still bounded — no runaway loop)`,
  config.llm.screeningMaxSteps <= 18,
);

// 3. Prompt candidate cap — bounds the prompt-token bloat driver.
check("screeningPromptCandidateCap is defined", typeof config.llm.screeningPromptCandidateCap === "number");
check(
  `screeningPromptCandidateCap (${config.llm.screeningPromptCandidateCap}) is a small N (<=10)`,
  config.llm.screeningPromptCandidateCap > 0 && config.llm.screeningPromptCandidateCap <= 10,
);

// 4. pickModel for SCREENER must stay flash even on a huge prompt (the case that
//    previously matched the v4-pro premium tier at >8000 tokens).
const bigMessages = [{ role: "user", content: "x".repeat(60000) }]; // ~17k est tokens
const pickedBig = pickModel("SCREENER", bigMessages, [], null);
check(
  `pickModel(SCREENER, large prompt) → flash, not pro (got ${pickedBig.model})`,
  /flash/i.test(pickedBig.model) && !/(-pro\b|premium)/i.test(pickedBig.model),
);

const smallMessages = [{ role: "user", content: "x".repeat(1000) }];
const pickedSmall = pickModel("SCREENER", smallMessages, [], null);
check(
  `pickModel(SCREENER, small prompt) → flash (got ${pickedSmall.model})`,
  /flash/i.test(pickedSmall.model),
);

console.log(`\nPASS ${passed} assertions`);
