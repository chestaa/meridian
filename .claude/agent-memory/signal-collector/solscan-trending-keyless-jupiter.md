---
name: solscan-trending-keyless-jupiter
description: solscan-trending source revived w/ keyless Jupiter toptraded primary (Birdeye paid-key optional); call-site-wiring trap
metadata:
  type: project
---

`tools/sources/solscan-trending.js` was DEAD on the VPS: Birdeye trending endpoint
requires a PAID `X-API-KEY` (keyless → HTTP 401), so `fetchSolscanTrending` logged
`BIRDEYE_API_KEY not set, skipping` and always returned `[]`.

**Fix (commit 8a7371d, 2026-06-11):** keyless Jupiter is now PRIMARY.
- `fetchJupiterTrending()` hits `https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=30`
  (KEYLESS, verified live HTTP 200). Returns bare array of `{id(=mint), symbol, mcap,
  fdv, liquidity, holderCount, stats24h.{buy,sell}Volume}`. Mapped to the
  source-agnostic flat shape `normalizePool` reads (`address/marketcap/fdv/liquidity/
  volume24hUSD/holder`). Override via env `JUPITER_TRENDING_URL`.
- `fetchTrendingTokens()` resolver: Birdeye ONLY if `BIRDEYE_API_KEY` set (optional
  override, falls back to Jupiter if Birdeye empty/failed), else Jupiter keyless.
- Jupiter is metadata-only — every gate-read field resolved from the Meteora
  cross-ref, never from the trending list. anti-pattern #8 safe.

**Why:** no paid-key budget ask needed; Jupiter is already the sanctioned token-data
vendor in this repo (token.js uses datapi.jup.ag). No quality reduction.

**How to apply:** Birdeye is purely optional now — if Bro ever buys a key, set
`BIRDEYE_API_KEY` and it becomes the primary with Jupiter fallback. No key = fine.

**TRAP (the unfinished piece of the prior run):** the resolver `fetchTrendingTokens()`
was added but `fetchSolscanTrending()` still called `fetchBirdeyeTrending()` directly
at the call site → resolver was DEAD CODE, source stayed dark. Always check the CALL
SITE consumes the new resolver, not just that the resolver exists. Same lesson as
[[crossref-endpoint-shape-mismatch]] — a fix added in one function but not wired in
is no fix.

Source flag: `useSolscanTrending` (config.screening); `solscanTrendingMode:"only"`
for testing. Wired in `getTopCandidates` (screening.js ~line 1203).
Tests: `scripts/test-solscan-source.js` (6 assertion groups, all pass — incl. the
keyless path: BIRDEYE absent → reaches Jupiter → graceful [] on Jupiter failure).
