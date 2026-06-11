---
name: quote-organic-bluechip-exempt
description: 7th funnel wall — minQuoteOrganic 60 rejected all SOL-quote pools; fixed by exempting blue-chip quote mints (wSOL+USDC); my prior memory falsely claimed live=0
metadata:
  type: project
---

THE 7TH FUNNEL WALL (Draco empirical 2026-06-11): `minQuoteOrganic 60` rejected
nearly every pool. This bot deploys single-side SOL → the quote token is ALWAYS
wSOL (or USDC pre-SOL-quote-filter) — inherently-liquid blue-chips with NO
meaningful organic score (`organic_score` measures BASE-token holder authenticity;
nonsensical for a stablecoin / wrapped SOL). `quote_token_organic_score` is null on
these → reject 100% of valid pools. It also POISONED `enrichNativeDetailBeforeGate`:
the cost-probe sentinel never cleared the quote-organic gate → no native fetch → the
volatility/organic structural gap never filled → 0 judge calls, $0 spent.

**MY PRIOR ASSUMPTION WAS WRONG.** [[native-detail-enrich-before-gate]] memory (and
the screening.js comment I wrote at e91bfd7) claimed "minQuoteOrganic is 0 → coerce
missing→0 is intended lenient pre-existing behavior." FALSE. Live = 60 (config.js
default `?? 60`, user-config.json:28, user-config.example.json:28; NOT in liveOverrides
so 60 in BOTH paper and live). The `numeric(null)===0` coercion did NOT make it lenient
— `0 < 60` still rejected. **Lesson: a memory naming a config VALUE is a claim about a
point in time — verify against the live config file before building on it.**

**Fix = EXEMPT blue-chip quote mints, NOT lower the base floor:**
- `quoteOrganicGateRejectReason(pool, s)` (exported, pure, unit-tested): if quote mint
  ∈ {wSOL `So111…112`, USDC `EPjFW…Dt1v`} (`QUOTE_ORGANIC_EXEMPT_MINTS`) → null (pass).
  A non-blue-chip quote is STILL gated fail-closed (null/below floor → reject) — defense
  in depth for exotic quotes. Reads `pool.token_y.address` + `token_y.organic_score`.
- Wired into `getRawPoolScreeningRejectReason` (replaced the old nonsense
  `quoteOrganic < s.minQuoteOrganic` line + removed the dead `quoteOrganic`/`quote` locals).
- Config default `minQuoteOrganic` 60→**0** (config.js + both user-configs) — root
  misconfig removed. Exemption is the structural fix; 0 is belt-and-suspenders. Note:
  `solQuoteRejectReason` already restricts the DEPLOYABLE set to wSOL-only, so USDC pools
  never deploy anyway — but USDC stays in the exempt set so the gate is correct even if
  that pre-filter is disabled.

**BASE organic gate UNTOUCHED** — `baseOrganic < minOrganic` (live overlay 72) still
fail-closed (`organic_unknown`). Only the QUOTE side was fixed. This OPENS valid
SOL-quote pools, it is NOT base-protection loosening.

**Full gate-sequence trace (TUGAS 2 — verified NO 8th wall):** a clean SOL-quote pool
(mcap in-band, vol/tvl/holders OK, base organic strong, volatility usable) clears EVERY
deterministic gate → reaches Orion judge. Order: getRawPoolScreeningRejectReason
[supply-conc/warnings/single-ownership/pool_type → mcap → holders → volume → tvl →
binStep → fee/TVL → volatility → BASE organic → QUOTE organic(EXEMPT) → launchpad → age]
then getTopCandidates late gates [SOL-quote pre-filter → age-8h live floor → TVL/fee/vol
re-check → PVP → Jupiter-audit bot/top10 → OKX wash/bundle/sniper → ATH → rug(mint/freeze/
rugpull) → dev_sold_all compound → TVL/MC(live) → multi-source(off) → indicators(off)].
Every reject path verified to fire ONLY on genuinely-bad input. No wall left.

**Why:** unblock the funnel without weakening any base-token floor.
**How to apply:** quote-organic is now blue-chip-exempt; treat it as effectively off for
SOL/USDC-quoted pools. If a future change re-introduces a quote-side floor, EXEMPT
blue-chips. Test: `scripts/test-quote-organic-gate.js` (38 assertions: 9 unit +
full-trace gate gauntlet + clean-pool-reaches-judge). See [[feedback-fail-closed-missing-data]].
