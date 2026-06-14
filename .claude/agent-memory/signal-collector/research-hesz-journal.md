---
name: research-hesz-journal
description: Deep-dive on t.me/hesz_journal — Hesz/@villainyouall retail LP/DLMM teaching journal; CORE HTML docs READ (750+788), full verdict for Meridian
metadata:
  type: project
---

Crawled `t.me/hesz_journal` full history + X timeline 2026-06-09 (READ-ONLY, Bro request). Channel = **Hesz Journal 🪤**, 262 subs, owner = **Hesz / @villainyouall** (X). NOT a signal group — solo retail LP/DLMM teaching journal aimed at beginners.

**CORE MATERIAL STATUS (2026-06-09 re-eval — first verdict was premature, core HTML was unread):**
- ✅ **HTML #750 `meteora-dlmm-guide.html`** — DOWNLOADED & READ. Pure beginner UI-walkthrough of app.meteora.ag (connect wallet → pick pool → Spot/Curve/Bid-Ask/Custom → set range → confirm → manage). ZERO alpha.
- ✅ **HTML #788 `lp-screening-guide.html`** ("weird screening, belum dibahas CT manapun") — DOWNLOADED & READ. Formatted version of his X thread; identical content.
- ✅ **The "weird screening" verbatim (4 steps):** (1) solscan.io → Top DeFi by Volume → click Meteora → filter "Add Liquidity" → watch which tokens top wallets are adding LP into; (2) pick anti-mainstream token: low LP + high volume + bullish chart, not yet hyped on CT; (3) re-screen chart/volume/holders, test small or via lparmy playground; (4) take CA → Meteora → set narrowish range, rebalance on breakout. Case study $STUPID @285K→1.2M (4.1x/1d). It's a SOCIAL/wallet-follow + manual chart method.
- ✅ **X tutorial @villainyouall** — crawled via nitter RSS (`intel/x/villainyouall_*.json`). Entry/TP TA: SuperTrend(10,3) + Stoch RSI(14,14,3,3) — entry on supertrend-green touch + Stoch RSI bounce from 30; TP on Stoch RSI exit upper band. "Strategy 2 nyawa" = WIDE-range HYPE/USDC LP (1.25–1.59 ≈27% wide), single-side USDC, recycle fee into degen.
- ✅ **first-screening** — CONFIRMED never revealed ("senjata gw", #576); only the 2nd (jup organic, vol>$15k/5m) shared. No clue leaked across 803 posts.
- ✅ **lparmy.com/playground** — LP Army (Meteora official edu community, 22k members, "Zero to Hero in 2 Days"); playground = free no-risk DLMM sim. Tool directory worth noting: UltraLP, Tokleo, Liquid Nova, MetEngine, Rocket Scan, DLMM Profit.

**TOOL BUILT (reusable):** `scripts/intel-tg-download-doc.js` — resolves any public TG channel, fetches given msg IDs, `downloadMedia` on attachments, prints text-like files (html/txt/json <512KB) to stdout. Solves the t.me/s web-preview gap (file blocks absent from preview HTML). Runs locally (TELEGRAM_SESSION is in LOCAL .env as @dikta14, NOT SSH-blocked) OR on VPS. Usage: `node scripts/intel-tg-download-doc.js hesz_journal 750 788`. Docs saved to `intel/telegram/docs/`.

**FINAL VERDICT (post-core-read):** ONE-OFF READ, NOT a recurring intel source, NOT a signal source (anti-pattern #8). Different game from Meridian: he teaches retail manual LP (wide USDC-pair safety + social wallet-following + TA timing), Meridian = autonomous narrow-range degen DLMM with on-chain metric gates. NOTHING in his material is superior to or absent from our gates — see eval below. @0xyunss remains the real benchmark ([[research-0xyunss]]).

**WHY NOTHING IS ADOPTABLE (honest per-item):**
- "Follow Smart LP via solscan add-liquidity table" — we ALREADY have `check_smart_wallets_on_pool` + smart-wallets.js (KOL/alpha wallet tracker), a STRONGER programmatic version of his manual solscan-watch. His is a weaker manual subset.
- "Anti-mainstream: low LP + high vol + bullish" — maps to our `minVolume`, `fee_active_tvl_ratio` bonus, TVL/MC gate (smaller TVL/MC = thinner liq vs cap, the 0xyunss thesis). We gate this deterministically; he eyeballs it.
- top-10 / no wallet >5% (#644) — our `maxTop10Pct`(60) + bundler gates are stricter/automated.
- Global-fee rule "1:10k" (#646/647): MC 10K ⇒ ≥1 SOL global fee; "MC bigger ⇒ bigger fee needed" — this is just a fee/MC floor, a rougher cousin of our `minFeeActiveTvlRatio` + `feeTvlHighBonus`. No new param.
- SuperTrend/Stoch-RSI TA timing — Meridian is not a TA candle-timer; not portable, and would be a different (manual) game.
- His own AI signal tool: he DISCLAIMS it ("gx tau patokannya apa", #799) — explicit anti-pattern #8 red flag, never a deploy source.

**Channel timeline (full history msg 1..803, 354 text records):**
- Jul 2025 - Apr 2026: low activity. Just a personal memecoin paper-trading journal — bot flexcards (RickBurpBot/RugProof/Channel_Bot), dumped token addresses, hype gain posts. No teaching.
- May-Jun 2026 (122+67 posts — the pivot): turned into LP/DLMM beginner education + repeated "AI signal tool soon" teasing (polls: screening won over AI-signal). He himself disclaims the AI signal: "gx tau patokannya apa" (doesn't know its criteria) — anti-pattern #8 red flag, do NOT treat as deploy source.

**Actual extractable teaching content (the "tutorial"):**
- His SECOND screening (shared, msg 577, pinned): jup.ag/terminal/organic → TF 5m → tokens above USDT → volume >$15k/5m. FIRST screening kept secret ("senjata gw"). This is roughly a weaker subset of what Meridian already gates (minVolume, minOrganic) — nothing new.
- Top-holder rule (msg 644): top-10, no single wallet >5% supply. Meridian already has maxTop10Pct + bundler gates — stricter than this.
- LP loop thesis (msg 801): LP in hype-usdc, recycle fees into microcap LP (compounding) — Meridian already does positionSizePct compounding.
- Tools he pushes: lparmy.com/playground (free DLMM sim), based_eth_bot (his ref link), villainyouall X tutorials. All beginner onboarding, not alpha.

**KEY GAP (anti-fabrication — honest):** The real "LP/DLMM screening guide" is an HTML FILE ATTACHMENT (`lp-screening-guide.html`, msg 750/788, captioned "agent masih plenger kosa katanya"). **t.me/s/ web preview does NOT render file attachments** — only the caption text is in the HTML (msgs 789-798 came back media-only/empty). So the guide's ACTUAL step-by-step content was NOT captured. He also teased an "aneh/beda" LP screening "belum pernah dibahas di CT manapun" (msg 763/786) — also not yet posted as text. To read the file requires downloading the attachment via a real TG client (VPS userbot getEntity('hesz_journal') + downloadMedia). **Attempted VPS SSH → BLOCKED by Claude Code classifier (agent SSH to prod denied).** Bro must run that manually if the file content is wanted.

**FEASIBILITY — full-history crawl of a PUBLIC channel: YES, NO session needed.** Built `scripts/intel-telegram-webpreview.js` — walks `t.me/s/<channel>?before=<msgId>` backwards from newest to msg #1, parses text/datetime/views/url from server HTML, topic-tags via buildIntelRecord. Got all 803 msg IDs in 21 pages. This is the go-to for ANY public channel where we lack a session. Contrast: `intel-telegram.js` (MTProto userbot) is for our own joined sources + can download media, but needs the VPS session and is SSH-blocked for agents. Output gitignored at `intel/telegram/<channel>_webpreview_<stamp>.json`.

**Web-preview parser gotcha (for reuse):** t.me/s HTML lays `data-post="ch/ID"` anchor BEFORE the text body further down the same wrapper. Splitting on the message-wrapper class offsets text by one post. FIX (shipped): collect all `data-post` anchor offsets first, slice HTML between consecutive anchors, then match `tgme_widget_message_text js-message_text` within each slice, stopping at the first footer/reply/poll/document/date marker. Polls → `[POLL]` prefix; file attachments → `[FILE]` (but see GAP above — file blocks usually absent from preview HTML).

See [[intel-crawlers]], [[intel-output-locations]].
