---
name: three-dead-sources-diagnosis
description: Final verdict on 3 dead signal sources — solscan (FIXED keyless), discord (not a bug, listener-dependent), native (thin by design)
metadata:
  type: project
---

Diagnosis 2026-06-11 of three signal sources reported as dead/thin.

**a. solscan-trending — `BIRDEYE_API_KEY not set` → FIXED (commit 8a7371d).**
Birdeye needs PAID key; swapped to keyless Jupiter primary. Live NOW, no Bro key
needed. See [[solscan-trending-keyless-jupiter]].

**b. discord-meteoraidn — `feed file not found` → NOT A CODE BUG.**
No path mismatch. Listener (`discord-listener/index.js`, `mirrorRankedDigest`) writes
`RANKED_DIGEST_FILE = DISCORD_RANKED_FEED || <ROOT>/discord-ranked-digest.json`;
parser (`tools/sources/discord-meteoraidn.js`) reads `DIGEST_FEED_FILE` with IDENTICAL
resolution. Same file. The "feed file not found" is the EXPECTED graceful skip:
writes are EVENT-DRIVEN — listener only writes when a NEW msg lands in a watched
MeteoraIDN ranked channel (#dlmm-multiday-opps / #dlmm-exotic-opps). No history
backfill. File appears on first live post. Real dependency = is the selfbot listener
RUNNING (`meridian-discord-listener.service`)? That's a Draco/VPS question, not code.
selfbot = discord.js-selfbot-v13, USER token, violates Discord ToS → BURNER only.

**c. native discovery thin → BY DESIGN, not misconfig.**
`discoverPools()` AND-joins all screening floors server-side on Meteora Pool Discovery
API (`&&`). Current floors: minMcap 150k / maxMcap 10M, minHolders 500, minVolume 500,
minTvl 10k / maxTvl 150k, minFeeActiveTvlRatio 0.05, minOrganic 60, minTokenAgeHours 8,
binStep 80-125, category=trending, timeframe=5m. minHolders 500 + minMcap 150k on a
5m-trending list of mostly-fresh micro-caps is structurally narrow. That narrowness is
WHY the parallel cross-ref sources exist (solscan/Jupiter, discord, pumpfun) — breadth
comes from them, not from loosening native floors (loosening = quality drop, refused).

**How to apply:** Only (a) was a code fix. (b) needs Draco to confirm listener up on
VPS. (c) is working as intended — recommend NO floor changes; instead lean on the
now-revived solscan source for breadth.
