---
name: deploy-2026-06-11-native-enrich-quoteorganic-wall
description: Deployed Cassiopeia e91bfd7 native-detail enrich; verify found NEW wall minQuoteOrganic 60 (predates e91bfd7) blocks SOL/USDC-quoted signal pools AND poisons enrich cost-probe → 0 native fetch, 0 judge, $0
metadata:
  type: project
---

Deployed Cassiopeia e91bfd7 "enrich vol+organic for cross-ref pools before gate
(last funnel wall)" on 2026-06-11. 3x services active (NRestarts=0, 0 errors,
0 open positions). HEAD=e91bfd7 (autopull had already pulled — "Already up to
date"; restart was still fresh). Commit touches tools/screening.js (+236),
config.js (+12, flag `enrichNativeDetailBeforeGate` default true, runtime ON),
test (258 lines).

**Funnel verdict: still 0→judge. NOT because of e91bfd7's gap — a NEW wall
surfaced underneath it: `minQuoteOrganic 60`.**

**Why:** Gate order in `getRawPoolScreeningRejectReason` (tools/screening.js
~412) runs `quote organic < minQuoteOrganic 60` IMMEDIATELY after base organic.
This bot deploys single-side SOL → quote is wSOL/USDC, which carries NO organic
score → `quoteOrganic == null` → reject `quote organic unknown below
minQuoteOrganic 60`. Verified live via node probe: quote-organic NULL→reject,
0→reject, only ≥60 passes. `minQuoteOrganic:60` PREDATES e91bfd7 (set at
3427771 / 1a63b29), so it is NOT a regression from Cassiopeia's commit.

**The cruel interaction (why 0 native fetches fired despite 5 pools reaching
base-organic):** `enrichNativeDetailBeforeGate`'s Lyra cost-aware probe builds a
sentinel pool (vol=1, organic=minOrganic) and only fetches if
`getRawPoolScreeningRejectReason(probe) === null`. But the sentinel still fails
quote-organic → probe rejects → pool dropped from `needsEnrich` → NO native
fetch → no `Native-detail enrich:` log, no `failed` log. So e91bfd7's enrich is
correct but inert: the quote-organic wall sits BEHIND base-organic and starves
the probe. Confirmed empirically: synthetic clean cross-ref pool → fetchCalled=0.

**How to apply:** This is a Cassiopeia risk-gate decision (Draco does NOT tune
screening thresholds). The fix is Cassiopeia's: either set `minQuoteOrganic 0`
(SOL/USDC quote has no meaningful organic score — gating on it is a disguised
near-total reject), OR exempt wSOL/USDC quote mints from the quote-organic gate
(same pattern as `quoteOrganic` already using lenient numeric()). Until then the
funnel cannot reach Orion. Cross-ref shape: signal pools DO carry cheap-gate
fields (mcap/volume/tvl/holders/binstep/fee) but structurally lack
volatility+organic AND quote-organic. See [[deploy-2026-06-11-crossref-fieldmap-empiris]].

Histogram cycle 09:19:34 CST (42 filtered, scan #1279): mcap 17, volume 11,
TVL 6, organic_unknown 5, fee/active-TVL 2, bot_holders 1. organic_unknown DOWN
from prior dominant-wall status but still present — those 5 reached base-organic
(passed all cheaper gates) then died there; enrich couldn't rescue due to the
quote-organic probe poisoning above.

Cost: $0.00 today (llm-usage.json 0 records for 2026-06-11, last call
2026-06-10T16:14Z deepseek-v4-flash). Judge NOT called = expected when 0
candidates pass. Under cap $1.10. No deploy, no open position change.
Note runtime base minFeeActiveTvlRatio reads 0.06 in plain config (live overlay
0.10 applies only under DRY_RUN=false path).
