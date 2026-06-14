---
name: research-discord-community
description: MeteoraIDN Discord deep-dive — bot-feed structure, dead consumption path, selfbot rate-limit reality
metadata:
  type: project
---

Discord intel deep-dive 2026-05-30 (guild MeteoraIDN, 6790 members, id 1431687513734643904). Report: `intel/discord/research-report.json` + bot-feed crawl `intel/discord/meridian_2026-05-30T11-37-51-808Z.json` (160 msgs / 4 bot channels).

**The 4 whitelisted channels are ALL bot feeds, two distinct bots:**
- MeteoraIDN bot → `dlmm-multiday-opps` + `dlmm-exotic-opps`: "Top 10" RANKED digests (~91min cadence) carrying Lincoln Score / FDV / TVL / bin step / base fees / Trench God Count. CURATED, quality-bearing. 27 distinct tokens over 5d.
- Metlex DLMM / Metlex DAMM V2 bots → `metlex-dlmm-bot` (~13min) + `metlex-dammv2-bot` (~1.8min): "New Pool Found" FIREHOSE, links only (APP/EDGE/AXI/DEX/DEXT), NO quality metrics. Low signal-per-post. 198 unique addresses, ZERO overlap between the two bot types (no built-in crossval).

**FIX #3 (2026-05-30) — phantom RESOLVED in code (flags OFF default, not yet pushed).** New `tools/sources/discord-meteoraidn.js` parses MeteoraIDN ranked digests (multiday/exotic) from a feed file (`discord-ranked-digest.json`, env `DISCORD_RANKED_FEED`) the selfbot listener now mirrors; extracts pool_address (from app.meteora.ag/dlmm URL) + Lincoln Score/FDV/TVL/bin step/base fee, cross-refs Meteora to enrich → raw pool shape tagged `signal_source:discord_meteoraidn`. Wired into `getRawPoolCandidates()` Discord block via config `discordSource` ("meteoraidn_ranked" default | "hivemind" legacy). Metlex firehose excluded by channel regex. Test `scripts/test-discord-ranked-source.js` = 7/7 PASS local+VPS. Real-crawl validation: 117 ranked entries extracted, 0 from firehose. Original phantom intel below kept for context.

**ORIGINAL phantom finding (pre-fix):** `useDiscordSignals:true` + `discordSignalMode:merge` in user-config, BUT:
- HiveMind endpoint `https://api.agentmeridian.xyz/signals/discord/candidates` returns **404** (whole base 404s incl /health). `fetchDiscordSignalCandidates()` (tools/screening.js) catches it → returns [] → screening silently runs Meteora-only. The flag does NOTHING.
- Local `meridian-discord-listener` systemd service is **inactive**. (That listener, discord-listener/index.js, only parses author "Metlex Pool Bot" → signals/inbox/.)
- So zero Discord signals flow from ANY path right now. Fix path before trusting the flag. By design, merge-mode would only use Discord as a crossval booster on pools ALSO in Meteora discovery (tags discord_signal:true), never standalone — anti-pattern #8 safe.

**Bot-feed topic tags are STRUCTURAL false positives (Lyra):** loss←"red"(emoji)/"rug"(field)/"liq"; issue←"hang"; meridian←"metlex"(brand); technical←"solana"; alpha←"gem"(emoji). Exclude bot-author msgs from sentiment counts; keep only address+metric extraction. (Refines the keyword-noise item in [[intel-crawlers]].)

**Selfbot history-crawl ToS reality (UPDATE [[intel-crawlers]]):** 400-deep across 17 busy channels hit compounding rate-limit backoff, ran 28min, never finished; a follow-up lean 60-deep/10-channel pass was ALSO throttled. Script writes only on clean completion → no human-channel data captured. Burner left heavily throttled. LESSON: history bursts are far more detectable than passive listen; cap depth low (≤60) and channel count low, prefer the passive real-time listener for ongoing Discord intel. Human channels (degen-calls, success, pnl-bot, token-check, dlmm-guides) remain uncharacterized.
