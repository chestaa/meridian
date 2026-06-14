---
name: deploy-2026-05-30-rebalance-dammv2
description: Commit 6424f79 rebalance-on-OOR + DAMM v2 scaffold (both flag-OFF, additive); rebalance 24/24 + DAMM v2 26/26 PASS; money-exit test FLAKY on live VPS due to state.json race
metadata:
  type: project
---

Deployed 2026-05-30 (last planned deploy): rebalance-on-OOR + DAMM v2 fee-compound scaffold, commit `6424f79`, pushed main, VPS auto-pulled clean (HEAD matches, no tracked-file diffs). meridian.service restarted, Mode LIVE, deepseek/deepseek-v4-flash, no errors. Snapshot triggered.

Both feature flags confirmed FALSE on VPS after restart (Vega VETO):
- `config.management.rebalanceOnOorEnabled = false`
- `config.damm.enabled = false` + `config.damm.poolAddress = null` (double fail-safe)

**Why:** Vega VETO'd live activation pending validation. DAMM v2 also inert because cp-amm-sdk NOT installed (do not npm install it — Vega controlled-deploy only).

**How to apply:** These flags MUST stay false until Vega clears. DAMM v2 flag path is `config.damm.enabled`, NOT `config.damm.dammV2Enabled` — the user-config key is `dammV2Enabled` but it maps to `damm.enabled` in config.js (line 242). Verify scripts probing `config.damm.dammV2Enabled` will wrongly return undefined; use `config.damm.enabled`.

Test results: rebalance-oor 24/24 PASS, damm-v2 26/26 PASS. money-exit-batch FAILED at assertion line 383 (flag-ON REBALANCE_OOR path) — see [[incident-2026-05-30-money-exit-test-state-race]]. NOT a code regression: same commit passes 30/30 locally; failure is a test/live race on shared ./state.json while meridian.service is active.
