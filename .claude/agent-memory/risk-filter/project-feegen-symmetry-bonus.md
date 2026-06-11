---
name: project-feegen-symmetry-bonus
description: Item (a) Fee-Gen-Token — balanced two-sided flow SCORE BONUS (proxy, never a gate); no native per-side fee field in Pool Discovery API
metadata:
  type: project
---

Item (a) Fee-Gen-Token signal shipped 2026-06-01 as a `scoreCandidate` SCORE BONUS, never a gate.

**Data verdict (the gate of my own plan):** Pool Discovery API (`pool-discovery-api.datapi.meteora.ag/pools`) has **NO per-side fee field**. Verified by live raw fetch — top-level keys are aggregate only: `fee`, `avg_fee`, `fee_pct`, `dynamic_fee_pct`, `fee_active_tvl_ratio`, `fee_tvl_ratio`. No `fee_token_x`/`fee_token_y`. So used a **PROXY**: buy/sell volume symmetry.

**Proxy source:** `pool.buy_vol`/`pool.sell_vol` aggregated from OKX cluster flow (`buy_vol_usd`/`sell_vol_usd` per cluster, already fetched in `getClusterList` during `getTopCandidates` OKX enrichment) — no extra fetch. NOTE: Jupiter token.js `stats_1h.buy_vol/sell_vol` was the other candidate but isn't fetched in getTopCandidates; OKX clusters were already in-hand.

**Logic:** `feeGenSymmetryBonus(pool, cfg)` (exported, pure). buyShare = buy/(buy+sell). Band [0.4,0.6]; triangular falloff — full weight at 0.5, 0 at edges, 0 outside band.

**Config:** `feeGenSymmetryBonusEnabled` (default FALSE, opt-in), `feeGenSymmetryWeight` (300). Wired into config.js defaults + runtime-update merge block.

**Why never a gate:** one-sided pump can still be a fine LP → gating on symmetry risks dormancy (rejecting deployable pools). Honest caveat: this is a WEAKER proxy than a native per-side fee split would be — cluster-aggregated USD flow approximates direction but isn't the actual fee-generating swap split.

Fail-safe neutral confirmed: missing/zero/non-finite/negative side → 0 bonus. Tests: `scripts/test-feegen-symmetry.js` (17 assertions). Touched ONLY screening.js + config.js + CLAUDE.md (no executor/dlmm/wallet/state). See [[feedback-fail-closed-missing-data]].
