---
name: research-bengbeng-lpagent
description: Tool-ecosystem crawl of @Gardvori's referenced sources — bengbeng.fun (Meteora PnL viewer + "For AI Agent" JSON export), LPAgent (smart-LP copy platform), @bengsharksol, @satyaXBT. Feasibility verdicts for smart-wallet data sourcing.
metadata:
  type: project
---

Crawled 2026-06-02 via WebFetch (nitter RSS for X, direct fetch for sites). Maps the tool ecosystem @Gardvori tutorialized (see [[research-gardvori]]).

**@bengsharksol (X)** — Indonesian Meteora LP trader, creator of bengbeng.fun. Timeline = LP-strategy + journal content: "LP Challenge Journal" 2 SOL→2.5 SOL day 1, "Fast Bid-Ask Bonus Stage" pattern claimed 83% WR (12 entries/2 losses), monthly profit ~$400 (Rp6.55M). ENDORSES feeding wallet data to AI agents to learn patterns; praises @0xyunss bot results. Strategy: 1 SOL avg entry, compounding, avoid high-fee positions.

**@lpagent_io (X)** — LPAgent, Solana LP automation/copy platform. Products: **Smart-LP** (wallet leaderboard at app.lpagent.io/smart-lp), **Copy-LP** (one-click strategy replication), bot **API** for devs, revenue-share payouts. Crawl shows it actively tracks/promotes Meridian Agent (@0xyunss) PPL performance + hackathon. Documented user results: 6→41.70 SOL (+595%), 30 SOL/mo. Notable retweet: "hardcode bot strategy over LLM prompts" (echoes our cost-cut/determinism direction).

**@satyaXBT (X)** — ID Web3/AI content creator/builder. NO DLMM/LP/Meteora/smart-wallet intel — general AI/Web3/jobs/content-strategy. Only crypto-tooling tie: mentions "Hermes Agent" (Discord vs TG deploy) = same @0xyunss-bot persona Gardvori uses. NOISE for our purposes; not a data source.

**bengbeng.fun** — self-described "Meteora DLMM PnL viewer (read-only)". Features: wallet insight lookup, Smart-LP, PnL cards, "Get Insight" → **"For AI Agent" JSON export** (machine-readable wallet-pattern data for feeding to an agent). The .json shape is NOT exposed by unauthenticated fetch — site is a JS app; only the landing string is fetchable. Exact schema unverified.

**FEASIBILITY VERDICTS (verified, not assumed):**
- **app.lpagent.io/smart-lp, app.lpagent.io/api/*, api.lpagent.io, lpagent.io = ALL HTTP 403** to WebFetch (Cloudflare/WAF or auth wall, consistent across every path). NOT scrapeable via WebFetch. Would need a real browser session / authed account / their official bot API. Wallet list + WR + fees are visible IN-APP only (Gardvori's screenshots: WR 80–88%, fee-earned 24–172, avg invested 1.2–13 SOL) — not via open endpoint.
- **bengbeng.fun "For AI Agent" export** — feature is REAL (confirmed by @bengsharksol + Gardvori tutorial) but the JSON is generated client-side after entering a wallet; not a public bulk API. Consuming it = manual per-wallet copy-paste, not an automatable feed. Schema not captured.

**ACTIONABLE for Meridian:**
- BEST new smart-wallet source: still our OWN on-chain mining (smart-wallets.js) + LPAgent study tool. bengbeng/lpagent are GATED (403/client-side) — no clean programmatic feed. bengbeng export is a manual qualitative input at best (Bro pastes a wallet, exports .json, hand-feeds). NOT worth a pipeline integration.
- LPAgent smart-LP wallet list could seed our smart-wallets.js watchlist IF Bro manually harvests addresses from the UI — but no API to automate. On-chain mining stays primary.
- Strategy intel worth noting: "Fast Bid-Ask Bonus Stage" pattern + "hardcode over LLM prompts" consensus = reinforces determinism/cost-cut thesis.
- NO trade signals taken (anti-pattern #8). Qualitative tooling/competitor intel only.

**LIMITS:** lpagent fully WAF-walled to automated fetch — could not verify smart-LP table data or any API schema directly (relying on Gardvori's screenshots). bengbeng JSON schema uncaptured (client-side gen). To get either: authed browser session or fund their API. @satyaXBT yielded no LP intel.

See [[research-gardvori]], [[research-0xyunss]], [[intel-crawlers]].
