---
name: intel-crawlers
description: Sirius intel-crawling tools for X/Telegram/Discord — methods, feasibility verdicts, and what's blocked
metadata:
  type: project
---

Intel crawlers built 2026-05-30 (separate from trade-signal pipeline; READ-ONLY, qualitative intel for review, NOT deploy triggers — anti-pattern #8 respected).

**Files** (all in `scripts/`):
- `intel-extract.js` — shared topic-tagger. Topics: llm/dlmm/meridian/profit/loss/complaint/issue/technical/alpha/strategy. Bahasa+English keyword sets. Emits `topic_hits` audit trail (which kw fired) for Lyra. Also maps "spread" (mentions/t.me/urls) + surfaces mint addresses as metadata only.
- `intel-x.js` — X/Twitter via **nitter RSS** (FREE, no API key). Output `intel/x/`.
- `intel-x-network.js` — NETWORK-GRAPH extension of intel-x.js. Crawls a SEED list (yunus's network) + root, then DEPTH-1 auto-discovery (harvests @mentions from root's posts via `spread.mentions`, queues top-frequency new accounts). Hard cap `INTEL_X_MAX` (default 10), no depth-2. Throttled `INTEL_X_THROTTLE_MS` (default 2500ms) + graceful skip on fail. Aggregates cross-account themes (consensus_topics = #distinct accounts per topic, mention_graph, shared_addresses/tg). Output `intel/x/network-graph_<stamp>.json`. NO reply/thread trees (X API v2 paid, blocked by design — account-graph only).
- `intel-telegram.js` — full-history via existing live MTProto session. Output `intel/telegram/`.
- `intel-discord.js` — channel-history via selfbot. Output `intel/discord/`.
- `intel-vision.js` — OPT-IN image reader (INTEL_VISION=1), uses existing OPENROUTER_API_KEY.

**Feasibility verdicts (verified, not assumed):**
- **X @0xyunss = FREE & WORKING** via nitter RSS. KEY GOTCHA: nitter.net returns EMPTY 200 body to bare Node fetch — MUST send `Accept: application/rss+xml,...` + `Accept-Language` headers (in REQ_HEADERS) or you get 0 items. xcancel.com requires email-whitelisting (returns error page). Use nitter.net. LIMIT: RSS = ~last 20 posts only, no full history, no deep thread trees. For full history/threads → X API v2 (paid ~$100/mo) — Bro must fund.
- **Vision = FEASIBLE CHEAP, but nitter URL gotcha CONFIRMED.** OpenRouter has FREE vision (`google/gemma-4-31b-it:free`, qwen3-vl family ~$0.08/Mtok). Default model is FREE gemma. Gated behind INTEL_VISION=1. **VERIFIED 2026-05-30: INTEL_VISION=1 pass returns EMPTY image_intel (0 captions) — gemma cannot fetch nitter-proxied `/pic/media%2F...` URLs.** WORKAROUND that works: nitter `/pic/media%2F<ID>.jpg` URL-decodes to `media/<ID>.jpg` → download from `https://pbs.twimg.com/media/<ID>.jpg?name=large` (plain UA, no special headers) then read the local file directly (Read tool renders images). This is how the @0xyunss PnL screenshots were read. TODO for intel-vision.js: base64-download the image first, or rewrite /pic URLs to pbs.twimg.com before sending to model.
- **Telegram = FULLY WORKING.** Reuses live session on VPS (@dikta14). Crawled 1494 msgs, 945 intel. Run ON VPS (session lives in /opt/meridian/.env).
- **Discord = WORKING but ToS RISK.** selfbot user-token (account `kumis.kucing`, guild MeteoraIDN). History burst is more detectable than passive listen — throttled 1200ms. Use burner account. Dep lives in `discord-listener/node_modules`, so intel-discord.js anchors createRequire to discord-listener/index.js.

**Known tuning item:** "complaint" topic has false positives (kw "bingung" fires on guide posts). Refine keyword sets with Lyra before relying on complaint counts.

**Run from VPS** (sessions/tokens live there): `ssh root@124.156.202.109 "cd /opt/meridian && node scripts/intel-telegram.js"`. Discord: same cwd, dep auto-resolves.

See [[intel-output-locations]].
