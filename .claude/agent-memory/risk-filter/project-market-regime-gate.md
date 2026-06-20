---
name: market-regime-gate
description: STOP BLEED T3 — market-regime gate pauses memecoin deploys on SOL downtrend; bluechip-exempt-ready, fail-safe NEUTRAL
metadata:
  type: project
---

Roadmap step-1 STOP BLEED T3 (-$4.67 memecoin-narrow-in-downtrend bleed). Cassiopeia
built a market-regime detector + gate in `tools/screening.js` (commit see git log,
branch feat/broad-discovery-server-client-migration). Bro-approved.

**What it does:** PAUSE memecoin/narrow deploys when SOL 24h % change ≤ downtrend
threshold (default -5%). ADDS a pause (stricter) — does NOT loosen any other gate.

**Detector:** `detectMarketRegime()` (exported) reuses boss-report price chain —
CoinGecko `simple/price?include_24hr_change=true` (no history store) + Jupiter v3
`priceChange24h` fallback. `classifyRegime(pct, s)` (pure): ≤-5 DOWNTREND, ≥+5
UPTREND, else NEUTRAL. Cached 10 min — one fetch per cycle, NEVER per-pool.

**Gate:** `marketRegimeGateRejectReason(pool, regimeResult, s)` fires in
`getTopCandidates()` BEFORE enrichment+judge (paused = zero cost). Pauses only when
regime===DOWNTREND AND `isMemecoinNarrowProfile(pool)`. Reject reason:
`market_regime_downtrend_memecoin_paused`.

**Bluechip-exempt-ready:** `BLUECHIP_BASE_MINTS` (wSOL/USDC/USDT) exempt — symmetric
payoff is fine in a downtrend. Phase 1 bluechip mode = one-line allow-list add. For
now funnel is all memecoins so it applies to every deploy.

Why: see [[fail-closed-missing-data]] — `classifyRegime` uses strictNumeric NOT
numeric, because Number(null)===0 would fabricate a flat 0% reading (anti-pattern
#2 — same null→0 coercion bug class as the enrich-probe catch-22). Missing/failed
price fetch → NEUTRAL (deploy as legacy), NEVER false DOWNTREND, NEVER blind freeze.
So a price-source outage can NEVER pause deploys; gate only pauses on a positively
measured downtrend.

How to apply: anti-dormancy is intentional-and-bounded — pause only on confirmed
downtrend, releases when SOL recovers above threshold next cycle (10-min cache). If
a future bluechip mode is added, wire its mints into BLUECHIP_BASE_MINTS so they
deploy through downtrends. Config (reloadable): `marketRegimeGateEnabled` (true),
`regimeDowntrendThresholdPct` (-5), `regimeUptrendThresholdPct` (+5). Tests:
`scripts/test-market-regime-gate.js` (35 assertions). Draco: add the 3 keys to
user-config + restart-3.
