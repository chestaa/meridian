---
name: project-feetvl-il-coverage-floor
description: fee/TVL floor raised to IL-coverage (base 0.05→0.13, live 0.10→0.15) + feeTvlHighBonus ON; bimodal universe = ~no dormancy cost
metadata:
  type: project
---

Raised fee/TVL bar to the IL-coverage line 2026-06-14 (commit b036b8c). Reverses the
"too-low floor" half of [[project-feetvl-age-adopt]] — now I HAVE universe data, the
2026-06-02 dormancy fear was overcautious at the deployable-set level.

**Why:** Bro observed deploy asymmetry (loss -$1 / win +$0.01). Root cause = yunus thesis,
verified: fee/TVL < ~0.20 does NOT cover IL → LP loses by math. Our floor was 0.05 base /
0.10 live — below IL-coverage → structurally unprofitable deploys. Also found: DRY_RUN=true
runs on BASE config (0.05), liveOverrides only apply when DRY_RUN=false — so the paper run
that produced the asymmetry was on the WORST floor (0.05).

**Calibration (live pool-discovery, 1h timeframe, 1000 dlmm pools, queried directly):**
mcap/organic/holders live INSIDE token_x (NOT top-level — server filter_by on mcap/organic
returns 0; must filter client-side). Native deployable band (mcap 150k-10M, tvl 10-150k,
organic>=72, holders>=500) = 18 pools. fee/TVL is BIMODAL not floor-hugging:
- >=0.10: 11 pools  >=0.15: 9 (82% of 0.10 throughput)  >=0.20: 8 (73%)
- marginal 0.10-0.20 sub-IL zone: only ~3 pools
So raising floor toward IL-coverage costs ~no throughput while killing the structural loss.
Anti-dormancy confirmed by DATA, not assumption.

**Option C applied (RAISES bar — not a loosening):**
- base `minFeeActiveTvlRatio` 0.05→0.13; live overlay 0.10→0.15
- enabled `feeTvlHighBonus` (was dormant flag-off): weight 250→400, floor 0.13, target 0.20
  → the >=0.20 king tier is favored by the judge; sub-0.20 still deploys but ranks far lower
- config.js base DEFAULT left at 0.06 (safety fallback); real floor = user-config overlay

**How to apply:** if dormancy reappears (0-deploy days), re-query the universe before
lowering — the bimodal shape means the bottleneck is usually mcap-band/organic/timeframe
(see [[project-timeframe-empty-window-bottleneck]]), NOT the fee floor. Don't drop below 0.13
without re-confirming throughput on live data. Flagged to Andromeda (exit may also fire early
on tiny wins) + Orion (profit weight) — those are out of my seleksi domain.

Tests: test-feetvl-age-adopt (25) + test-gate-batch (22) green. Touched user-config.json +
config.js only. See [[feedback-fail-closed-missing-data]].
