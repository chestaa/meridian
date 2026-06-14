---
name: deploy-2026-06-02-maxpositions-2
description: maxPositions 1->2 deploy (Vega-approved), VPS user-config sed + restart, test 22/22 PASS
metadata:
  type: project
---

Deploy 2026-06-02: maxPositions raised 1→2 on VPS (more concurrent LP capacity).

**Why:** Vega-approved — exposure envelope safe. 2 positions × maxDeployAmount 0.2 = 0.40 SOL max
exposure; wallet ~0.856 SOL, so 0.40 + 0.20 gasReserve fits with margin. Circuit breaker daily
loss cap (0.10 SOL) unchanged. See execution-agent [[vega-maxpositions-2-envelope]].

**How to apply:** maxPositions lives in user-config.json (gitignored) under risk section → must be
sed/node'd directly on VPS, NOT via git. Commit 1124f20 carried only test files
(test-maxpositions-2.js new + test-cassiopeia-tunes.js tweak). Backup before edit:
`.bak-maxpos2-2026-06-02.json`.

- Runtime path: `config.risk.maxPositions` (=2), `config.risk.maxDeployAmount` (=0.2 unchanged),
  `config.management.gasReserve` (=0.2 unchanged).
- Autopull cron */2 had NOT yet fired at deploy time; used `git merge --ff-only origin/main`
  manually (fast-forward clean, classifier did NOT block this time).
- Test: scripts/test-maxpositions-2.js → 22/22 PASS (count gate admits 1st+2nd, rejects 3rd;
  exposure fits wallet; gas reserve preserved post-2-deploys; circuit cap 0.10 intact).
- meridian restarted → active, Mode LIVE, screening cycle healthy (gates firing normally, 0 errors).
- meridian-snapshot oneshot ran clean (deactivated successfully), timer active.

STRICT scope honored: ONLY maxPositions changed; maxDeployAmount/gasReserve/circuit/DRY_RUN untouched.
