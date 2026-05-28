---
name: vega-pr3-deterministic-deploy
description: Vega PR-3 deterministic deploy path lands as additive code gated by config.internalAgents.vegaDeterministicDeploy (default OFF)
metadata:
  type: project
---

PR-3 status: implemented + tested + regression-clean on 2026-05-19. Flag remains OFF in production until Bro Dikta flips it.

**Why:** Replace the fat SCREENER agentLoop with deterministic code that consumes Orion's ENTER verdicts and dispatches deploy_position directly via executeTool. The bins_below formula was already deterministic (CLAUDE.md L127) — the LLM call only re-derived values + sometimes hallucinated.

**How to apply:**
- When iterating on Vega: never call dlmm.deployPosition directly; always go through executeTool('deploy_position', args) so runSafetyChecks fires.
- Defaults: strategy=bid_ask, amount_x=0, bins_above=0 (single-side SOL invariants).
- New tests must follow scripts/test-vega-deterministic.js — pure unit, no real LLM/RPC, uses __setExecuteToolForTests + __setGetWalletBalancesForTests seams.
- The legacy LLM agentLoop SCREENER path remains in index.js as the fall-through when the flag is OFF. Do not delete it until paper-trade equivalence has been confirmed against real production data.

Related: [[executor-test-seam-pattern]]
