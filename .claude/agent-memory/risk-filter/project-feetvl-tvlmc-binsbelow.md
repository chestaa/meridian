---
name: project-feetvl-tvlmc-binsbelow
description: Item 2 (fee/TVL 0.07→0.08 + new TVL/MC gate) + Item 4 binsBelow coupling verdict (2026-05-30)
metadata:
  type: project
---

Shipped 2026-05-30 to `tools/screening.js` + `config.js` + `user-config.json` + `CLAUDE.md`. Intel: @0xyunss + Telegram community validated yunus screen (Fees/MC ≥ 0.1, TVL/MC < 0.2), 71% win.

**Item 2 — fee/TVL + TVL/MC gate (both LIVE-overlay, paper unaffected):**
- fee/active-TVL live overlay bumped 0.07 → **0.08** (NOT 0.10). Reasoning: 0 deploys/24h already (bad market) — jumping to yunus's 0.10 risks permanent dormancy. 0.08 = tighter than 0.07, moves toward 0.10, keeps headroom. Evidence-based middle, not max-aggressive.
- NEW `tvlMcapGateEnabled` (default true) + `maxTvlMcapRatio` (default 0.2). Pure fn `tvlMcapGateRejectReason(pool, s)`. Reject reasons: `tvl_mcap_ratio_too_high`, `tvl_mcap_ratio_unknown`. FAIL-SAFE: missing/zero mcap or tvl → reject (anti-pattern #2). Fires in `getTopCandidates()` ONLY when `config.dryRun === false` AND `eff.tvlMcapGateEnabled` — double live guard. Both keys added to `user-config.json` liveOverrides for self-documentation + `reloadScreeningThresholds()`.

**Item 4 — binsBelow ↔ volatility coupling: VERDICT = SOUND, NOT TOUCHED.**
Formula `round(35 + (vol/5)*34)` clamp [35,69]: vol5→69, vol3→55, vol1→42, monotonic, vol>5 clamps at 69 ceiling. Higher vol → wider range exactly as community demands. The ONLY judgment knob is the 69 ceiling — raising it is a capital-density / money-touching change. WITHOUT OOR-frequency backtest evidence I did NOT widen it (evidence-free loosening = VETO territory, even on my own work). If OOR-on-volatile-microcaps data later proves 69 too narrow → propose ceiling raise behind flag WITH evidence.

**Tests:** `scripts/test-feetvl-tvlmc-gate.js` (19 assertions, all PASS). `test-gate-batch.js` still 22/22 (no regression).

**How to apply:** When auditing future fee/TVL or TVL/MC threshold changes, 0.08 fee floor + 0.2 TVL/MC are current LIVE baselines. binsBelow ceiling 69 is the validated current value — do not raise without OOR evidence. See [[project-gate-hardening-batch]], [[feedback-fail-closed-missing-data]].
