---
name: deploy-2026-06-02-adopt-feetvl-age-fastba
description: Deploy 2026-06-02 adoption batch — fee/TVL high-bonus + token-age sweet-spot bonus (Cassiopeia) + fast-bid-ask timing (Vega), all flag-OFF; live overlay fee/TVL bumped to 0.10
metadata:
  type: project
---

Deploy 2026-06-02: adoption batch commit `6845be3` (8 files, 591 ins).

**Code (all flag-OFF, opt-in):**
- Cassiopeia: `feeTvlHighBonus` (fee/TVL ramp 0.10→0.20, weight 250) + `tokenAgeSweetSpot` bonus ([12,48]h, weight 200), both score-bonus NOT gates (dormancy-safe — mature/low-feeTVL pools still PASS hard screen, just rank lower). Flags: `feeTvlHighBonusEnabled`, `tokenAgeSweetSpotBonusEnabled` default false.
- Vega: `fastBidAskBonusEnabled` (timing override in tools/dlmm.js, config.strategy) default false.

**Live overlay change (the ONLY active behavior change):** Cassiopeia bumped VPS user-config `liveOverrides.minFeeActiveTvlRatio` 0.08→**0.10** (hard floor, live-only). Top-level `minFeeActiveTvlRatio` stays 0.06 (code default). Backup `.bak-adopt-2026-06-02.json`.

**Why:** intel adoption from @0xyunss benchmark — high fee/TVL pools rank up, 12-48h token age is the sweet spot. Done as score-bonus not hard floor to avoid funnel dormancy.
**How to apply:** when touching screening scoring, these three flags exist and default OFF; do NOT flip without Cassiopeia/Vega sign-off. Live fee/TVL floor is 0.10 in overlay only.

**Verify results:** all 3 flags resolve false on VPS (config loaded). Tests: feetvl-age 25, fast-bidask 34, gate-batch 22, volume-regime 31 PASS. money-exit FLAKY again (27 PASS/0 FAIL, no final summary line, exit 1) — the known shared `./state.json` race vs live cron ([[incident-2026-05-30-money-exit-test-state-race]]), NOT a regression, no rollback. meridian restarted active Mode LIVE model deepseek-v4-flash, 0 errors, screening cron started. Snapshot pushed to status branch (success).
