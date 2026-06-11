---
name: crossref-endpoint-shape-mismatch
description: Two Meteora datapi endpoints return DIFFERENT field shapes — cross-ref gives volume/fees/fee_tvl_ratio as window-OBJECTS, bin_step in pool_config, holders on token, NO volatility/organic. Fixed via crossrefPoolFields()
metadata:
  type: project
---

Meridian uses TWO distinct Meteora datapi hosts that return DIFFERENT field shapes.
Confused them = silent data loss in every cross-ref signal source.

- **Native screening** (`screening.js`, `POOL_DISCOVERY_BASE = pool-discovery-api.datapi.meteora.ag`):
  `volume` is a **SCALAR** for the requested timeframe; `fee_active_tvl_ratio` present.
- **Cross-ref index** (`meteora-crossref.js`, `METEORA_DLMM_BASE = dlmm.datapi.meteora.ag`,
  used by discord-meteoraidn + solscan-trending + pumpfun-graduated):
  `volume` is a per-window **OBJECT** `{30m,1h,2h,4h,12h,24h}`; `fees` + `fee_tvl_ratio`
  are ALSO window-objects; there is **NO `fee_active_tvl_ratio`** (only `fee_tvl_ratio` +
  `dynamic_fee_pct`). Top-level keys: address, name, token_x/y, reserve_x/y, tvl,
  current_price, apr/apy, volume(obj), fees(obj), fee_tvl_ratio(obj), dynamic_fee_pct,
  is_blacklisted, launchpad, tags.

**EXHAUSTIVE field audit (2026-06-11, live SOL/JUP/BONK/WIF — authoritative).** Every gate
field in `getRawPoolScreeningRejectReason` cross-checked vs cross-ref shape:
- **Window-OBJECTS** `{30m,1h,2h,4h,12h,24h}`: `volume`, `fees`, `protocol_fees`,
  `fee_tvl_ratio`. (Only `volume` + `fee_tvl_ratio` are gate-read.)
- **Wrong field LOCATION (plain mismatch, same bug class):** `bin_step` lives at
  `pool_config.bin_step` (native: `dlmm_params.bin_step`) → bin_step gate rejected EVERY
  cross-ref pool. `holders` lives at `token.holders` (sources read `holder_count`) → relied on
  enrich-before-gate to rescue a count the pool already had.
- **NO `fee_active_tvl_ratio` key** — only `fee_tvl_ratio` (window-obj). Both are ratios 0-1;
  native `fee_active_tvl_ratio`≈`fee_tvl_ratio` (active_tvl≈tvl), and total-tvl ratio is the more
  conservative (lower) number for a floor gate → map `fee_tvl_ratio[30m]` into the gate's
  `fee_active_tvl_ratio` slot. Unit-safe.
- **STRUCTURAL GAPS (endpoint does NOT expose — flag, never fabricate):** `volatility` absent;
  `organic_score` absent on token; token `created_at` absent (top-level `created_at` is POOL
  creation, wrong semantic for token-age gate). These stay null → gate fail-closed rejects. A
  cross-ref pool CANNOT clear the volatility/organic gates without a separate native detail fetch.
- `tvl` is a plain scalar ✅; no `active_tvl` field; `market_cap` on token is a scalar ✅.

**FIX (commits b233425 then this pass):** `volumeScalar`→generalized to `windowScalar(field,
preferWindow)` (shortest finite window, fail-closed). ALL gate fields routed through ONE mapper
`crossrefPoolFields(meteoraPool, base)` in `meteora-crossref.js` — single place that knows the
cross-ref shape, so no source can drift / re-introduce a "layer 7". All 3 sources call it. Window
choice = **30m** (anti-hype #8): for ratios, 30m vs 24h is ~80× (0.0048 vs 0.386) — long window
would falsely clear the 0.06 floor. Test: `test-signal-volume-mapping.js` (19 assertions, per-field
object→scalar + missing→null→reject). When mocking cross-ref pools, use OBJECT shape +
`pool_config.bin_step` + `token.holders`.

**Cassiopeia coordination (field+unit confirmed):** gate unit = ratio 0-1 for fee/TVL, USD for
volume/tvl/mcap, raw count for holders. Mapping verified unit-safe. The volatility/organic
structural gaps are Cassiopeia's call — cross-ref signal pools will keep failing those two gates
until a native-detail volatility/organic enrichment runs for cross-ref-sourced pools.

**How to apply:** any new source that cross-refs via `dlmm.datapi.meteora.ag` MUST route raw pools
through `crossrefPoolFields()` — never read `pool.volume`/`pool.bin_step`/`pool.holders`/
`pool.fee_active_tvl_ratio` directly. Never assume the two endpoints share a shape.
enrich-before-gate (holder) lives in screening.js line ~669. See [[research-discord-community]].
