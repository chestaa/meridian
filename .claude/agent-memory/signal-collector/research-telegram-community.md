---
name: research-telegram-community
description: Telegram intel deep-dive on Agent Meridian community (@agentmeridian channel + meridian-discussion group) — structure, top issues, actionable findings
metadata:
  type: project
---

Telegram intel deep-dive completed 2026-05-30 (crawl pushed to 5000/source: 4774 msgs, 2604 intel). Report at `intel/telegram/research-report.json` (gitignored). See [[intel-crawlers]] / [[intel-output-locations]].

**Two distinct sources, very different shapes:**
- `@agentmeridian` channel = only **101 msgs total** (82 intel) = the COMPLETE official changelog, Mar 18 – May 24 2026. Authoritative competitor roadmap. Builder = yunus-0x (repo github.com/yunus-0x/meridian, branches main + experimental). This is [[research-0xyunss]]'s product.
- `meridian-discussion` group = **4673 msgs but only 5 days retained (05-25..05-30)** — group is hyper-active (~420 intel msgs/day, 284 unique authors/5d). Cannot derive long-term trend from it. ~19% of intel msgs (author id `8709618103`) are the **@agentmeridian_bot helper bot** answering troubleshooting — so user questions = pain points, bot answers = canonical fixes.

**Top recurring community ISSUES (clustered):**
1. LPAgent API **401 Unauthorized** (most common single error) — LPAGENT_API_KEY invalid/expired; fires even when relay disabled if env var still set.
2. **Repeated OOR / range too narrow** — binsBelow:69 + bid_ask on volatile micro-caps = instant OOR.
3. **RPC 429** on deploy (getEstimatedComputeUnitUsageWithBuffer) — free RPC insufficient, bot recs Helius/Triton.
4. **"PnL profit tapi SOL berkurang"** — agent reports +PnL but wallet SOL drops (IL + auto-swap slippage on close not in PnL figure). Multi-user trust-eroder → #1 actionable for OUR Meridian: audit close accounting = realized SOL delta, not LP-only PnL.
5. Setup/credential confusion (which key where; 400=config typo, 401=bad creds, 429=ratelimit).

**Community health:** active+growing but mostly DRY-RUN/troubleshooting phase (dry-run mentions 31 >> live 10). Sentiment mixed: profit-tagged 293 vs loss-tagged 333. Only hard profit numbers = builder's self-reported HiveMind 7d aggregate (2026-05-12): $27K fees, +$4k PnL, 66.7% WR, top strategy bid-ask — unverified, survivorship-biased.

**Alpha = NOISE, not signal.** Token/pool names (RICH/CUM/HENRY/GACHA-SOL etc., all micro-cap memecoins) appear in OOR/loss troubleshooting context, NOT validated wins. Do NOT treat as deploy triggers (anti-pattern #8). Shared public LPAgent key circulating in group = base64 "meridian-is-the-best-agents".

**False-positive confirmation (for Lyra):** 'complaint' topic (83) inflated by "bingung" (21) firing on newbie how-to + bot guide answers — real frustration much lower. 'issue' count (618) inflated by 479 bot explanation msgs — distinct user-reported issues are fewer.

**DELTA crawl 2026-06-02 (NET-NEW since 05-30):** channel +8 changelog msgs since 05-24, discussion fresh 05-30→06-02 (1692 intel).
- **Builder threshold quotes (05-30, authoritative):** "24h fee/tvl is **king, anything below 20% won't cover your IL**" — pegs the fee/TVL floor at **0.20**, far above our default 0.05 and the 0.1 we'd considered. "spot on dump is goat"; "what you need is **12-48h token** with enough volume" (token-age sweet spot; we run min 24h/max 720h). "non-indo users LP-first-then-wrap-strategy is more profitable than blindly using meridian" → tuning > defaults.
- **#1 pain STILL unfixed & dominant:** "PnL profit tapi saldo/SOL berkurang" (IL not in PnL) recurs 06-02 (09:07, 09:42) — re-validates our realized-SOL-delta close-accounting fix; their bot still misreports.
- **GMGN structural detail (06-02):** experimental branch carries `tools/gmgn.js` + `gmgn-config.json` (GMGN token-first screening, switchable source) — net-new vs the 05-31 digest mention.
- Sentiment unchanged: active but dry-run/troubleshooting dominant; no validated win numbers, alpha still NOISE.

**DLMM wisdom worth keeping:** range width must scale to volatility; bin step affects OOR risk independent of bin count (fee-per-trade set by pool config not bin step); minFeePerTvl24h 8-12% advised over default 7%; trailing TP (3%/1.5%) preferred over fixed 5%; "gaada ceritanya orang sukses pake settingan default".
