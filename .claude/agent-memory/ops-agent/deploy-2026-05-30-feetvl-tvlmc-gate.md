---
name: deploy-2026-05-30-feetvl-tvlmc-gate
description: Cassiopeia item 2 deploy — fee/TVL 0.08 live overlay + new TVL/MC<0.2 LIVE-only gate; commit c8947de, tests 19+22 PASS, meridian LIVE, gate armed-inert (no false rejects)
metadata:
  type: project
---

Deployed Cassiopeia intel item 2 (fee/TVL tighten + TVL/MC gate) to VPS on 2026-05-30.

**Commit:** c8947de "intel item 2: fee/TVL 0.07->0.08 + TVL/MC<0.2 gate (yunus screen validated)" — pushed origin/main, VPS auto-pulled within ~150s.

**What changed:**
- `config.js` defaults: `tvlMcapGateEnabled ?? true`, `maxTvlMcapRatio ?? 0.2`. Note `minFeeActiveTvlRatio` config DEFAULT stays 0.05 — the 0.08 floor is applied via user-config.json `liveOverrides.minFeeActiveTvlRatio`, NOT the code default.
- `tools/screening.js`: `tvlMcapGateRejectReason(pool, s)` exported. Gate fires ONLY when `config.dryRun === false && eff.tvlMcapGateEnabled === true`. Fail-safe: missing/zero mcap or tvl → `tvl_mcap_ratio_unknown` reject. Reasons: `tvl_mcap_ratio_too_high`, `tvl_mcap_ratio_unknown`.
- VPS `user-config.json` (gitignored, node read-modify-write, backup `.bak-feetvl-2026-05-30.json`): set top-level minFeeActiveTvlRatio=0.08, tvlMcapGateEnabled=true, maxTvlMcapRatio=0.2, AND liveOverrides.minFeeActiveTvlRatio=0.08 (two 0.08 entries in grep = correct).

**Tests:** scripts/test-feetvl-tvlmc-gate.js (19/19) + scripts/test-gate-batch.js (22/22) PASS local AND VPS.

**Post-restart smoke:** Mode LIVE, model deepseek/deepseek-v4-flash, 30m screening cron. NOT dormant — every cycle pulls 13 solscan-trending + 5-8 pumpfun-graduated DLMM pools. Other gates fire selectively (risk filter top10/bot_holders, rug gate mint_authority). TVL/MC gate is armed but fires only at deploy-detail enrichment stage when a survivor breaches ratio — no false rejects observed, candidate flow healthy.

**Why:** validated against "yunus screen". TVL/MC gate is LIVE-only so paper/backtest unaffected.

**How to apply:** if screening goes fully dormant (every cycle rejects ALL candidates), suspect fee/TVL floor too tight — revert liveOverrides back to 0.07. Backup at /opt/meridian/.bak-feetvl-2026-05-30.json for rollback. Related: [[deploy-2026-05-29-activate-sources]].
