---
name: pr4-deterministic-manager
description: PR 4 shipped — agents/manager.js replaces MANAGER LLM agentLoop with deterministic close/claim dispatch. Flag managerDeterministic default OFF.
metadata:
  type: project
---

PR 4 (Andromeda extraction) shipped 2026-05-19.

**Why:** MANAGER LLM was a pass-through. The decision logic already lives in `state.js#updatePnlAndCheckExits` + `paper-trades.js#evaluatePaperExit` + `index.js#getDeterministicCloseRule`. The LLM only translated "rule fired → call close_position" — pure cost/latency/hallucination overhead on the money path.

**How to apply:**
- New file `agents/manager.js` exports `runDeterministicManagement(context)` + `managerDeterministicEnabled(config)` + `buildActionMap` + `getDeterministicCloseRule` (replica of the one in index.js — duplicated intentionally to keep manager.js decoupled from index.js entrypoint).
- Wired into `runManagementCycle` in `index.js` via early return when flag ON.
- Feature flag `config.internalAgents.managerDeterministic` (default `false`). Lives in `config.js` next to `vegaDeterministicDeploy`.
- INSTRUCTION-bearing positions are DEFERRED (logged, not auto-closed) under the deterministic path — operator must intervene or toggle flag OFF. This is intentional: instructions are semantic, only LLM can evaluate "hold until +20%" reliably.
- TRAILING_TP confirmation path (queuePeakConfirmation/queueTrailingDropConfirmation 15s recheck) is preserved — caller still runs updatePnlAndCheckExits before dispatch, only confirmed exits enter exitMap.
- Composition with Vega [[vega-pr3-deterministic-deploy]]: independent flags, independent cycles (SCREENER vs MANAGER), disjoint tools. Both can be enabled together.
- Tests: `scripts/test-manager-deterministic.js` (57 assertions, all pure unit, no LLM/RPC).
- Full regression: 26/26 suites pass.

Related: [[goal-meridian-internal-agents]] (parent roadmap).
