---
name: native-detail-enrich-before-gate
description: Last funnel wall fix — cross-ref pools missing volatility+organic enriched via native pool-discovery detail before gate; reject-reason split null vs genuine-low
metadata:
  type: project
---

THE LAST FUNNEL WALL (Draco empirical 2026-06-11): cross-ref signal pools (discord/
solscan/pumpfun via `dlmm.datapi.meteora.ag`) died at `base organic 0 < minOrganic`.
Root cause was STRUCTURAL: `organic_score` and `volatility` do NOT EXIST on the
cross-ref endpoint (Sirius's exhaustive shape audit — see meteora-crossref.js header).
A 0 read there = DATA-MISSING, not a real low score. Sirius's field-map fix (commit
2b4be22) resolved volume/fee_tvl/bin_step/holders, but these two are an irreducible gap.

**Fix = enrich-by-native-detail, NOT a minOrganic drop** (extends
[[holder-enrich-before-gate]], commit 0b7332f):
- The NATIVE Pool-Discovery detail endpoint (`pool-discovery-api.datapi.meteora.ag`,
  queried by `pool_address`) carries volatility + organic_score (+ fee_active_tvl_ratio,
  created_at, market_cap, tvl, volume, bin_step, holders) as proper SCALARS. **Verified
  live** (probe pool unc-SOL: vol=5.97, organic=83.2, all present). So NO separate
  organic source (Jupiter) is needed — one native detail fetch fills every gap at once.
- `enrichNativeDetailBeforeGate(rawPools, s, fetchDetail=fetchPoolDiscoveryDetail)` in
  screening.js `discoverPools`, runs AFTER `enrichHolderCountsBeforeGate` (so the cheap-
  gate probe sees real holders). For pools missing volatility OR base organic that clear
  every OTHER (no-API) gate, fetch native detail once (cached per pool_address, 5-min TTL
  — shorter than holder's 30min because volatility is time-sensitive), back-fill the gaps.
- Lyra cost-aware: probe with passing sentinels for ONLY the missing gap fields; a pool
  that dies on mcap/volume/tvl/holders/bin_step/age gets NO native fetch (don't fetch
  detail for 41 discord pools if most die on mcap). Reuses the holder-enrich probe pattern.

**CRITICAL secondary bug fixed:** `numeric(null) === 0` (`Number(null)===0`) meant the
gate ALWAYS coerced missing organic/volatility to 0 → fell into the genuine-low branch,
making `organic_unknown` dead code. Added `strictNumeric()` (mirrors windowScalar's
strictNum) — null/undefined/empty/object → null, only real numbers/numeric-strings pass.
Gate now reads volatility + BASE organic via strictNumeric. CORRECTION (2026-06-11,
[[quote-organic-bluechip-exempt]]): this memory ORIGINALLY claimed "minQuoteOrganic=0 →
coerce-to-0 is intended lenient behavior." That was WRONG — live minQuoteOrganic was 60
(the 7th funnel wall). The quote-organic check has since been REPLACED by
`quoteOrganicGateRejectReason()` which EXEMPTS blue-chip quote mints (wSOL/USDC); the
old `numeric(quote.organic_score)` line + locals were removed.

**Why:** save the funnel without weakening the floor — give cross-ref pools a CHANCE to
be judged on real volatility+organic instead of dying on a structural data gap.

**How to apply:** reject reasons now SPLIT — `volatility_unknown`/`organic_unknown`
(data-missing, fail-closed) vs `volatility N is unusable`/`base organic N below
minOrganic` (genuine). minOrganic UNCHANGED (live overlay 72-75). Enrich is NEVER a
bypass — failed fetch / still-null field → `*_unknown` reject. A genuine detail vol 0 is
written HONESTLY (→ "unusable" reject), never rescued to a fake >0. Config flag
`enrichNativeDetailBeforeGate` (default true, reloadable) restores legacy hard-reject when
false. Test: `scripts/test-native-detail-enrich-before-gate.js` (33 assertions, incl.
reject-reason split regression). See [[feedback-fail-closed-missing-data]].
