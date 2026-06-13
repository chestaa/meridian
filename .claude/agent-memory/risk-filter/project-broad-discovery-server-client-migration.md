---
name: broad-discovery-server-client-migration
description: CROWN JEWEL fix — breadth 3→200+ via server→client gate migration; broad fetch page_size 1000, gate IDENTICAL client-side, cost flat
metadata:
  type: project
---

CROWN JEWEL (2026-06-13, Bro's #1 complaint "cuma main 5 pool dari jutaan"): fixed the
breadth choke without loosening any gate.

**Root cause (Sirius, verified live):** `discoverPools()` pushed EVERY strict gate
(organic≥60, fee/TVL, binStep, mcap band, holders, age) to the Pool-Discovery server as
`filter_by` params → server cut the 114,516-pool universe to ~3 BEFORE we saw a candidate.
`page_size=50` (API ceiling 1000; pagination broken so page_size is the only breadth lever).

**Fix (NOT a loosening — gate IDENTICAL, only LOCATION moved server→client):**
- `buildDiscoveryFilters(s)` (pure, exported) — broad mode (default `broadDiscoveryEnabled`)
  sends ONLY a WIDE pre-filter: `pool_type=dlmm` + critical-warning/single-ownership sanity
  flags + WIDE mcap band (`broadMcapFloor` 10k…`broadMcapCeil` 50M) + low tvl floor
  (`broadMinTvl` 1k) + free server pre-sort `broadSortBy=fee_active_tvl_ratio:desc` at
  `page_size=broadDiscoveryPageSize` (1000).
- IDENTICAL strict gate runs CLIENT-side via `getRawPoolScreeningRejectReason` (already
  existed at the filter step). **INVARIANT:** every broad bound ≥ wider than the matching
  strict threshold (floor≤minMcap, ceil≥maxMcap, broadMinTvl≤minTvl) → server can NEVER drop
  a pool the strict gate would pass → broad result is a strict SUPERSET of deployable set.

**Cost-control (anti-pattern #8 + Lyra-aware) — judge + enrichment cost FLAT:**
- enrich-before-gate passes (holder + native-detail) are probe-gated against STRICT
  thresholds — a pool failing strict mcap/organic/fee-TVL is dropped from `needsEnrich` for
  free (no API). Native discovery pools already carry holders/vol/organic so `needsEnrich` is
  mostly empty regardless — broadening does NOT explode enrich.
- `getTopCandidates()` deterministically pre-ranks by `scoreCandidate` then HARD-slices to
  `limit` BEFORE any per-pool enrichment (PVP/Jupiter audit/OKX) and before the judge. Judge
  cap stays `screeningPromptCandidateCap=5`. So `limit` pools enter enrichment regardless of
  fetch breadth — now the cream of the whole gate-passed universe instead of the cream of 50.
- `discoverPools({ returnLimit })` caps the RETURNED set for the direct `discover_pools` LLM
  tool (token-bloat guard, default=page_size); `getTopCandidates` passes `returnLimit:null`
  (uncapped) so its pre-rank sees the full gate-passed universe.

**Reversible:** `broadDiscoveryEnabled=false` → legacy full-server-filter (16 strict clauses).

Files: `tools/screening.js` (`buildDiscoveryFilters`, `discoverPools`, `getTopCandidates`,
`fetchPoolDiscoveryPage` sort_by), `config.js` (broad* keys + reload). Tests:
`scripts/test-broad-discovery.js` (38 assertions: breadth>50, broad filter superset, client
gate fires identical, fail-closed missing-data, pre-rank top-N, clean pool passes, legacy
reversibility). Regression green: gate-batch 22, holder-enrich 19, native-detail 43,
quote-organic 38, feetvl-tvlmc 19, screener-cost 12.

Related: [[fail-closed-missing-data]], [[native-detail-enrich-before-gate]],
[[holder-enrich-before-gate]], [[quote-organic-bluechip-exempt]].
