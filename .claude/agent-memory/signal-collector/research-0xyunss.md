---
name: research-0xyunss
description: Deep-dive intel on @0xyunss (builder of competitor @meridian_agent DLMM agent) — profit/strategy/tech findings + report location
metadata:
  type: project
---

Deep-dive research on **@0xyunss** done 2026-05-30. He is the **builder of @meridian_agent** — an open-source autonomous DLMM LP agent on Meteora/Solana. This is the competitor/sibling product to OUR Meridian. Indonesian web3+AI builder, building ~3mo since Feb 2026.

**Where the output lives:** `intel/x/research-0xyunss.json` (structured intel — profit_evidence, strategy, tech_stack, complaints, spread_map, actionable). Key PnL screenshots read+saved in `intel/images/` (gitignored). See [[intel-output-locations]].

**Hard numbers (image-extracted, self-reported NOT on-chain verified):**
- Personal (bengbeng.fun, 2 wallets, May): **+$1.49K**, **71.4% win / 121 closes**; PNL Calendar 25 win days / 0 red days.
- His "$3k/mo, $130 cost" tweet = DLMM + trench combined; LP portion ~$1.49K. Cost breakdown: VPS $30 / RPC $50 / AI sub $40 / LLM $10.
- @meridian_agent network 7D: PnL **+$6.8k**, fees **+$49.7k**, adj win **62.1%**, **729 active / 1537 registered agents**, 29444 closes. Dominant strategy = **spot**. Top pools Ball/TOLYBOT/DEGEN-SOL.

**Actionable for us (top 3):** (1) steal his Claude Code dev loop = anti-pattern list in claude.md + PostToolUse/Stop hooks + 3x auto-retry. (2) MeteoraIDN 4-signal screening (Fees/MC>=0.1, narrative, TVL/MC<0.1-0.2, LP bin distribution) — consider tightening our minFeeActiveTvlRatio toward 0.1 + add TVL/MC gate. (3) Their loudest pain = "ribet banget" setup + admitted bugs → smoother deploy = our edge; spot strategy dominance validates simple spot-range LP.

**DELTA crawl 2026-06-02 (NET-NEW since 05-31):**
- **Second bot revealed:** "hermius printing $4k-5k per bulan, meridian $1.5k per bulan" (05-31). So his headline $3k/mo is hermius+meridian combined; the DLMM-LP (meridian) portion is only ~$1.5k/mo. Also "saving pension fund with 11% apy" — modest, honest framing.
- **13,000-wallet dataset (06-01):** built web/infra tracking **13k DLMM-active wallets** as training data for @meridian_agent. Implies a data-moat/smart-wallet-scoring direction — relevant to our smart-wallets.js (we track a handful; he industrializes it).
- **MiniMax M3 (06-01):** 1M context, multimodal, native coding app, claims opus-4.7-tier; he subbed yearly $240. Plus Xiaomi MiMo v2.5 ≈ deepseek-v4 price, 100T-token program limit reset (06-02 token-cost-of-Indonesian-vs-English post). LLM-cost optimization is his constant theme.
- **Colosseum hackathon (06-01):** @meridian_agent now competing in the largest Solana hackathon; scam-impersonator (@meridiancustomercare) appeared = product gaining visibility.

**Method note:** nitter RSS = last ~20 posts only. Vision auto-pass FAILED (empty), images read via twimg workaround — see [[intel-crawlers]] gotcha. Spread cluster is TECH/STRATEGY intel, NOT a trade-signal source (anti-pattern #8 respected, none whitelisted).
