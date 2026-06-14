---
name: reference-screening-step-budget
description: SCREENER ReAct loop step budget — where config.js reads it, the flat-key gotcha, why 16, and that raising it bypasses no safety
metadata:
  type: reference
---

SCREENER ReAct loop step cap = `config.llm.screeningMaxSteps` (read at index.js
SCREENER agentLoop call). Global cap for MANAGER/GENERAL = `config.llm.maxSteps`.

**Read path (the gotcha):** config.js loads user-config.json into a FLAT object
`u` and reads `u.screeningMaxSteps` and `u.maxSteps` from TOP-LEVEL keys — there
is NO `llm:{}` nesting in user-config.json. So a flat top-level `screeningMaxSteps`
IS what runtime uses (user-config overrides the config.js default). A prior
ops-agent note claimed top-level `maxSteps:20` is "ignored" — that is WRONG; it is
read. The real confusion is the absence of an `llm` section, which makes people
look for `u.llm.screeningMaxSteps` (undefined) and assume the flat key is dead.
Confirm runtime with: `node -e "import('./config.js').then(({config})=>console.log(config.llm.screeningMaxSteps))"`.

**Value: 16** (raised from 8 on 2026-06-13, commit 34d6b7a). Why 8 broke: a single
Orion-ENTER candidate needs ~7 steps worst-case to deploy — enrichment batch
(get_pool_detail + check_smart_wallets_on_pool + get_token_holders +
get_token_narrative, up to 4 steps if the model doesn't parallelize the
PARALLEL FETCH RULE in prompt.js) + deploy reasoning (1) + deploy_position (1) +
one-line ACK after tool result (1). At 8 the loop exhausted in enrichment BEFORE
deploy_position → `[SCREENER_STALL] Orion ENTER but max-steps reached without
deploy`. 16 ≈ 2.3x worst-case, still < global maxSteps (20).

**Cost stays flat (Lyra):** deploy_position is in NO_RETRY_TOOLS (locks after first
attempt) and the loop exits on the ACK text, so the extra budget is consumed ONLY
on cycles that actually deploy. No-ENTER cycles still exit in 1-2 steps. Average
LLM cost/cycle unchanged.

**Safety (Vega coord):** raising the step budget bypasses NO guard — it only gives
an already-approved deploy enough steps to finish. Deploy still passes judge ENTER
+ Cassiopeia gates + executor.js hardcoded caps (maxDeployAmount, gasReserve,
maxPositions, circuit breaker, fresh-snapshot). test-screener-stall proves the
`[SAFETY_BLOCK]` circuit-breaker reject fires regardless of step count.

**Follow-up flagged (not built):** enrichment is already pre-loaded into the prompt
(candidateBlocks in index.js), yet the loop can STILL re-call enrichment tools
in-flight because they remain in SCREENER_TOOLS + prompt.js PARALLEL FETCH RULE
tells it to. A cleaner fix than raising steps would be a Charon-style prefetch that
strips enrichment tools from the SCREENER tool set for pre-loaded candidates so the
loop spends steps only on the deploy decision. Bigger refactor — deferred; the
step bump is the quick-win unblock.

Tests: scripts/test-screener-cost.js (cap asserted >=12 && <=18, still < global),
scripts/test-screener-stall.js.
