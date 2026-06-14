---
name: deploy-2026-06-11-quote-organic-0db9228
description: deployed Cassiopeia 0db9228 (quote-organic fix) + set minQuoteOrganic=0; quote-organic reject ELIMINATED from funnel, histogram now genuine-quality; judge-reach pending clean cycle
metadata:
  type: project
---

Deployed Cassiopeia commit **0db9228** + set `minQuoteOrganic=0` in VPS user-config.json — the
FINAL fix in the gas-to-live funnel-unblock chain (follows [[deploy-2026-06-11-native-enrich-quoteorganic-wall]]
which traced minQuoteOrganic as the poisoning wall, and [[deploy-2026-06-11-crossref-fieldmap-empiris]]).

**Why:** the `minQuoteOrganic 60` (later 72) wall rejected SOL/USDC-quoted signal pools (quote
organic null → reject) AND poisoned the native-detail enrich cost-probe (sentinel failed
quote-organic gate → 0 native fetch ever fired despite pools reaching base-organic). Cassiopeia
0db9228 + setting the floor to 0 removes the wall so clean pools reach Orion judge with full data.

**How to apply:** this should be the last structural wall in the signal→judge funnel. After this,
remaining rejects should be GENUINE quality (real mcap/volume/holders/TVL), not structural `_unknown`.
If a pool reaches Orion and gets NO-DEPLOY, that is correct QUALITY discipline — funnel is unblocked,
we just don't force a bad deploy.

## Deploy facts (2026-06-11, ~09:32 CST / 01:32 UTC)
- `git pull` = "Already up to date" (autopull cron had pulled 0db9228 already). HEAD=**0db9228**.
- user-config set: `minQuoteOrganic=0` (was 72). Confirmed read-back. minOrganic stays 72,
  minFeeActiveTvlRatio 0.06 (live overlay 0.10), maxPositions envelope 0.18.
- Restarted **3 services**: meridian, meridian-signal-runner, meridian-auto-screener — all `active`,
  NRestarts=0 each, ActiveEnterTimestamp 09:32:45 CST.
- Health: 0 errors / 0 crashes in journal post-restart.
- Wallet: 0.851956 SOL, 0 open positions.

## VERIFIED results (post-restart window, 10-min histogram)
- **`quote organic` reject = HILANG (0 occurrences)** — was poisoning funnel + enrich probe. FIXED.
- **`volatility_unknown` = 0.** 
- New reject histogram is GENUINE quality: minVolume 35, minMcap 33, maxMcap 21, maxTvl 15,
  organic_unknown 11 (down hard from baseline), minFeeActiveTvlRatio 10, minTvl 1.
- No `non_sol_quote_undeployable` / `tvl_mcap_ratio` noise.

## VERIFIED over 2 clean config-loaded cycles (09:32:47 + 10:00:01 CST)
Both ran with minQuoteOrganic=0 fully active (config object confirms 0). Identical pattern:
- **quote-organic reject = 0 in BOTH cycles** (was the funnel-poisoning 7th wall). ELIMINATED, stable.
- **volatility_unknown = 0** in both.
- Histogram = genuine quality (mcap/volume/TVL/fee-TVL real) + a few organic_unknown.
- **Native-detail enrich = 0 fire** in both cycles. **Pool reached judge = NO.** Cost today = $0.

## WHY 0 enrich / 0 judge — NOT a Draco bug, hand-off to Cassiopeia
The enrich probe (enrichNativeDetailBeforeGate, screening.js:874-895) only fetches a native detail
for a pool that clears `getRawPoolScreeningRejectReason(probe, s) === null` AFTER filling vol+organic
with sentinels (Lyra cost-guard: don't spend a fetch on a pool that dies elsewhere anyway).
- The 5 organic_unknown pools (清正/CHANCE/1-SOL/Bountywork/PARQ) clear EVERY gate up to organic
  (mcap/holders/volume/TVL/bin_step/fee-TVL/volatility all pass) — they ONLY lack organic.
- BUT the probe also runs the **token-age gate** (screening.js:548-555, minTokenAgeHours=24,
  maxTokenAgeHours=720). Cross-ref/discord signal pools structurally lack `created_at`
  (see [[deploy-2026-06-11-crossref-fieldmap-empiris]]) → `created_at == null` → age gate rejects
  → probe never clears → enrich SKIPPED. Real-eval logs `organic_unknown` because organic (line 524)
  is checked BEFORE age (line 548); the probe fails at age because organic is sentinel-filled there.
- **CATCH-22:** enrich CAN back-fill created_at (screening.js:952-957), but the cost-guard probe
  rejects the pool on missing created_at BEFORE the fetch that would supply it. So no signal pool
  missing created_at can ever reach enrich → can never reach judge. This is a probe-design gap,
  Cassiopeia's domain (NOT an ops/config fix). Options for Cassiopeia: also sentinel created_at in
  the probe, OR exempt age from the probe gate, OR enrich unconditionally for organic_unknown pools.

## FUNNEL STATUS (honest)
quote-organic wall = GONE. But pool-reach-judge still NO because the enrich probe's age gate
blocks signal pools that lack created_at. Goal "gas-to-live" is one step closer (7th wall cleared)
but NOT yet reached — judge still not invoked. Next wall is the probe age-gate, owned by Cassiopeia.

## Gotchas
- Schedule config is `{}` → DEFAULT cron: management 10m, screening 30m (log "Cycles started" confirms).
  Management ticks log "No open positions — screening already running or cooling down" and do NOT
  re-trigger screening. Screening tick at restart + every 30m. wallet 0.851956 SOL, 0 open positions.
- llm-usage.json shape is `{totals, records}` (NOT array) — parse `records[].cost_usd` filtered by
  `ts` date prefix. Lifetime $2.6773 / 1850 req. boss-report.js has no stdout (Telegram only).
- node -e with nested single quotes over SSH breaks (`unexpected EOF`); write a /tmp/*.mjs heredoc.
  config.js is ESM → use `await import()`, not require().
