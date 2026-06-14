---
name: vega-maxpositions-3-envelope
description: maxPositions 2->3 @ 0.18/pos APPROVED+shipped 2026-06-07; 3x0.18+0.20=0.74 fits 0.90*0.851753 wallet; 76-assertion test
metadata:
  type: project
---

maxPositions 2→3, per-position cap 0.20→0.18 (gas-buffer hardening), deploy floor
0.20→0.18. Bro-approved 2026-06-07, Vega led the change. Commit f019ae1 on main.

**Why:** Wallet LIVE 0.851753 SOL. Bro wanted a 3rd concurrent slot but trimmed
per-pos to 0.18 so the gas buffer stays comfortable. gasReserve TETAP 0.20,
positionSizePct TETAP 0.1 (compound-by-size held until wallet >=2 SOL per prior VETO).

**Envelope math (verified):** committed = 3*0.18 + 0.20 gas = 0.74 SOL.
Guard = wallet*0.90 = 0.766577. 0.74 <= 0.766577 PASS. Absolute free buffer 0.116 SOL.
A 4th slot (4*0.18+0.20=0.92) would breach the 90% guard — headroom is for exactly 3.
Gas-survival: residual 0.311753 after 3 deploys covers emergency close-ALL-3
(9*0.005=0.045); gasReserve alone also covers it.

**How to apply:** Test `scripts/test-maxpositions-3.js` (76 assertions, committed,
NOT gitignored) asserts against REAL exported fns — `config.computeDynamicDeployAmount`
(cfg-seam injected proposed values), `executor.solCoverageRejectReason`, and the live
circuit breaker. Pattern: config-value change uses the cfg seam, NOT a private-predicate
mirror like [[vega-maxpositions-2-envelope]] had to. If wallet shrinks below ~0.82 SOL
the 90% envelope guard would fail for 3 slots — re-verify before any further raise.

The live values live in GITIGNORED user-config.json on the VPS; Draco sed's them
(maxPositions=3, maxDeployAmount=0.18, deployAmountSol=0.18). Vega does NOT sed it.
Circuit breaker (0.10 SOL / 30% caps), gasReserve, duplicate guards untouched.
DRY_RUN untouched — bot stays LIVE.
