---
name: holder-enrich-before-gate
description: Holder floor choke point fix — enrich count for signal pools before gating, floor stays 500, fail-closed preserved
metadata:
  type: project
---

Holder floor was the DOMINANT deploy choke point (Draco data 2026-06-11): 69
reject `holders 0 below minHolders 500` / 4 dry deploy days. Root cause was
DATA-MISSING, not a tight floor — signal pools (discord/solscan/pumpfun) arrive
without `base_token_holders` because the upstream cross-ref didn't carry it, and
died at the holder gate before any other gate or the LLM judge ran. The filters
we'd loosened (fee/organic/maxPos) were 0-binding.

Fix = enrich-before-gate, NOT a floor drop (commit 0b7332f, 2026-06-11):
- `getTokenHolderCount({mint})` in token.js — one cheap `assets/search`
  `holderCount` fetch. **Why not getTokenHolders:** getTokenHolders fetches the
  top-100 *distribution* (capped at 100 rows) → cannot prove a >=500 population
  count. Wrong tool for a count floor. The real total count lives in
  `assets/search.holderCount` (same field getTokenInfo already reads).
- `enrichHolderCountsBeforeGate()` in screening.js `discoverPools` (before the
  `getRawPoolScreeningRejectReason` filter): for pools with holders null/0 that
  clear every OTHER (no-API) gate, fetch real count (cached per mint, 30-min
  TTL), then let the floor judge the REAL number.
- Lyra cost-aware: probe each candidate against all gates with a passing-sentinel
  holder value first; a pool that dies on mcap/volume/tvl/age gets NO fetch.

**Why:** save the funnel without weakening the floor — give pools a CHANCE to be
judged on a real number instead of dying on missing data.

**How to apply:** the holder gate now returns `holders_unknown` for null/0
(data-missing, fail-closed) vs `holders N below minHolders 500` for a genuine
sub-floor count. Enrich is NEVER a bypass — failed/null fetch leaves holders null
→ `holders_unknown` reject. minHolders floor UNCHANGED (500). Config flag
`enrichHolderCountBeforeGate` (default true, reloadable) restores legacy
hard-reject when false. Test: `scripts/test-holder-enrich-before-gate.js`
(19 assertions). See [[feedback-fail-closed-missing-data]].
