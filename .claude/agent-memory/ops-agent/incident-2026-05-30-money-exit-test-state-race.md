---
name: incident-2026-05-30-money-exit-test-state-race
description: scripts/test-money-exit-batch.js is FLAKY on VPS when meridian.service is active — both write shared ./state.json, live cron clobbers test fixtures mid-run
metadata:
  type: feedback
---

`scripts/test-money-exit-batch.js` must NOT be trusted as PASS/FAIL on the VPS while `meridian.service` is active. It writes test fixtures to `./state.json` (state.js uses CWD-relative `STATE_FILE = "./state.json"`), then reads back via `updatePnlAndCheckExits`. The live management cron rewrites `state.json` every cycle, racing the test and clobbering fixtures — the flag-ON REBALANCE_OOR assertion (line ~383) intermittently fails with `r.action === undefined` because `organic_score`/`rebalance_count` get wiped between write and read.

**Why:** Observed 2026-05-30 deploy of commit 6424f79. Test failed 2/2 on VPS (service active, state.json mtime coincided with test log timestamps to the second) but PASSED 30/30 locally where nothing competes for state.json. The deployed code (state.js REBALANCE_OOR gate) is byte-identical and correct. The backup/restore in the test (state.json.test-bak) DID protect live data — 11 real positions intact, no fixture leftovers, no orphan backup. Only the assertion was corrupted, not production state.

**How to apply:** Do NOT rollback a deploy solely on this test failing when meridian.service is live. Trust the local 30/30 + the two suites that exercise the new code in isolation (test-rebalance-oor.js, test-damm-v2.js — neither races state.json). To get a clean money-exit run on VPS, stop meridian.service first (coordinate with Vega/Andromeda — has open positions) or run in a scratch CWD. Real fix would be to isolate the test's STATE_FILE to a tmp path. See [[deploy-2026-05-30-rebalance-dammv2]].
