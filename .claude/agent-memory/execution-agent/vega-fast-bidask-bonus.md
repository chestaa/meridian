---
name: vega-fast-bidask-bonus
description: Item 1 fast bid-ask bonus-stage override; isFastBidAskBonus in dlmm.js; flag default OFF; timing override not new SDK shape; 34 tests green
metadata:
  type: project
---

Item 1 — "Fast bid-ask bonus stage" (intel @bengsharksol, 83% WR claim). Built LOCAL 2026-06-02.

**Honest verdict — NOT a new distribution shape:** the Meteora DLMM SDK
(`initializePositionAndAddLiquidityByStrategy` / `addLiquidityByStrategyChunkable`)
accepts only `{ minBinId, maxBinId, strategyType }` where strategyType ∈ Spot|Curve|BidAsk.
There is NO per-bin custom weight param — `StrategyType.BidAsk` *already is* the
edge-weighted U-shape. So "fast bid-ask" can only be a TIMING/STRATEGY override, not
a new shape. The only materially-different effect: when the volume-regime picker would
otherwise return `spot` for a high-volume FRESH pool, fast-BA flips it to `bid_ask`
(spot on a fresh volatile pool gets shredded by a bonus-stage pump). Marginal/no-op
when regime already picks bid_ask or regime is OFF (legacy default is bid_ask).

**What:** `isFastBidAskBonus(token_age_hours, volatility, cfg)` PURE helper exported from
`tools/dlmm.js`. Returns true ONLY when: flag on AND age finite >0 AND age <= maxAge AND
vol finite >0 AND vol >= minVol. Layered AFTER pickRegimeStrategy in deployPosition strategy
resolution, ONLY in the no-explicit-strategy branch (override-wins preserved for LLM/manual).

**Config (config.js strategy section):** fastBidAskBonusEnabled (default FALSE),
fastBidAskMaxAgeHours (24), fastBidAskMinVolatility (3).

**Wiring:** added `token_age_hours` param to deployPosition + deploy_position tool def
(definitions.js); agents/vega.js deterministic path passes `token_age_hours` from
pool.token_age_hours ?? pool.age_hours.

**FAIL-SAFE (anti-pattern #2):** missing/zero/non-finite age OR volatility → false → defer
to regime pick, never silent flip. NEVER a gate, NEVER touches amount/bins/caps — shape only.

**Money safety:** deploy shape only changes when flag ON. maxDeployAmount/maxPositions/DRY_RUN
untouched. Override-wins preserved.

**Tests:** scripts/test-fast-bidask.js (34 assertions PASS). test-volume-regime.js (31 PASS)
+ test-money-exit-batch.js (30 PASS) no regression. Related: [[vega-volume-regime-strategy]].

**VETO status:** safe to ship flag-OFF. LIVE activation VETO'd pending paper-soak (marginal
upside; @bengsharksol 83% WR claim unverified).
