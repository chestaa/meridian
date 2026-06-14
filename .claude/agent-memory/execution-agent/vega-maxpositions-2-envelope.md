---
name: vega-maxpositions-2-envelope
description: maxPositions 1->2 approved+shipped 2026-06-02; exposure envelope math, per-position cap binds, circuit independent of count
metadata:
  type: project
---

maxPositions raised 1 -> 2 in user-config.json (2026-06-02, Draco diagnostic: bot
starving from 1-slot cap + thin market, NOT gate tightness). Vega APPROVED — config
flip only, no money-code change.

**Why safe:**
- Per-position hard cap `maxDeployAmount=0.20` UNCHANGED. `computeDynamicDeployAmount`
  (config.js) HARD-CAPS at maxDeployAmount for ALL confidences incl. 1.5x tier
  (belt); executor.js L1035 `amountY > maxDeployAmount` reject is suspenders.
- Worst-case total exposure = 2 x 0.20 = 0.40 SOL. Wallet 0.856, gasReserve 0.20
  untouched: 0.40+0.20=0.60 <= 0.856. Residual after 2 deploys 0.456 >= gas 0.20.
- Count gate (executor.js L990 `total_positions >= maxPositions`) admits slots 0,1;
  rejects slot 2. Force-fresh `getMyPositions({force:true})` => no double-deploy race
  (plus index.js `_screeningBusy`/`_screeningLastTriggered` cooldown).
- Per-deploy balance gate (L1043-1052, DRY_RUN=false) checks `amountY+gasReserve`
  against LIVE balance per deploy — drains correctly across 2 deploys; thin wallet
  still refused even with a free slot.
- Circuit breaker (0.10 SOL daily cap, account-circuit-breaker.js) is INDEPENDENT of
  position count: 2 losing closes (-0.06 each = -0.12) still trip it. Cap UNCHANGED.

**How to apply:** if asked to raise further (2->3+), re-run the envelope math against
current wallet — exposure scales linearly with maxPositions x maxDeployAmount, and the
per-deploy balance check does NOT pre-reserve already-deployed SOL (each deploy checks
only its own amount+gas vs live balance), so a thin wallet self-limits but math should
be confirmed. Test: scripts/test-maxpositions-2.js (22 assertions).

**Note:** executor.js `runSafetyChecks` is PRIVATE, no test seam (crown-jewel — a config
flip must not require adding seams to it). Test mirrors the exact L990/L1043 predicates.
NOTE [[executor-test-seam-pattern]] applies to agents/vega.js executeTool, NOT executor.js.

Pre-existing unrelated: test-cassiopeia-tunes.js has 2 stale assertions (minOrganic
72-vs-75, minFeeActiveTvlRatio 0.1-vs-0.07) — Cassiopeia's, not money-side.
