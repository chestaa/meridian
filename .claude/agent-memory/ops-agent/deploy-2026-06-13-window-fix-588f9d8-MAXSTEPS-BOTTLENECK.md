---
name: deploy-2026-06-13-window-fix-588f9d8-maxsteps-bottleneck
description: Deploy 588f9d8 window-fix (timeframe 1h + maxBinStep 200 + profit heuristic) — gate/judge UP but NEW downstream bottleneck SCREENER_STALL at screeningMaxSteps=8
metadata:
  type: project
---

Deploy DECISIVE window-fix 2026-06-13 (HEAD main=588f9d8, ff merge faadcec..588f9d8: Cassiopeia 7610145 timeframe 5m→1h + maxBinStep 125→200, Orion 588f9d8 profit-potential heuristic + honest realized-SOL win bar). 3 svc active NRestarts=0, 0 err 15min.

**WHAT THE FIX DID (works):** timeframe 5m→1h fixed the empty-window root cause. Client gate pass **1→4** (auto-screener AND main both 4/1030). Orion judged **3 ENTER, 0 skip** (was 1). volume_below_min reject GONE from histogram (was 59%) — confirms window fix: 5m window was too short → volume read ~0 → mass reject; 1h window gives real volume. Reject histogram now dominated by mcap(above/below 10M/150k on Discord-signal path) + organic, NOT volume.

**NEW BOTTLENECK — bottleneck moved downstream, NOT discovery anymore:** `[SCREENER_STALL] Orion ENTER but max-steps reached without deploy. enter_verdicts=3 high_conf=3`. **Why:** `config.llm.screeningMaxSteps=8` too small. Each ENTER candidate needs enrichment tools (get_token_narrative + get_token_info + get_token_holders, the latter ~12.8s) BEFORE agent reaches deploy_position. With 1 candidate 8 steps sometimes stalled too (22:15 enter=1 also stalled); with 3 candidates 8 steps ALWAYS exhausted on enrichment → ENTER but 0 deploy. So gate/judge fixed but DEPLOY still 0.

**Why:** screeningMaxSteps is LLM agent-loop tuning (Orion/Polaris call), and raising it raises cost-per-cycle (more LLM calls). Trade-off → FLAGGED to Bro/Polaris, NOT changed unilaterally by Draco (out of ops scope — money/LLM-loop tuning).
**How to apply:** if Bro wants actual daily deploys, the fix is raise screeningMaxSteps (Orion) OR cut enrichment-per-candidate. GOTCHA: user-config has stray top-level `maxSteps:20` which config.js IGNORES — config.js reads `config.llm.screeningMaxSteps` (default 8). Setting top-level maxSteps does nothing.

**Config set (user-config TOP-LEVEL keys, gitignored VPS copy, backup user-config.json.bak-window-fix-2026-06-13):** timeframe="1h", maxBinStep=200, minMeaningfulProfitSol=0.005. GOTCHA: config.js maps minMeaningfulProfitSol → `config.management.minMeaningfulProfitSol` (line 364, default ??0.005 so active even if unset), NOT config.screening. timeframe/maxBinStep → config.screening. Probing config.screening.minMeaningfulProfitSol returns undefined = wrong path, not a bug.

**Profit heuristic (Orion 588f9d8) wired:** agents/orion.js computeFeeShare → fee_share_pct ≈ our_position_sol/pool_tvl_sol×100, tier = micro(<0.05%)/thin(<0.2%)/healthy. micro-share DEMOTES a pool (factor not new gate). Passed to judge as `profit_share`. boss-report.js reads userConfig.minMeaningfulProfitSol direct (raw file) for win-bar ≥0.005 SOL.

**Cost FLAT:** today $0.0725/109 calls cap $1.10 NO explosion. Enrich not explosive (pre-rank top-4, judge 3). Encryption SURVIVED restart (enc:AES-256-GCM pubkey DgA9MZYE...1Hiu match, bal 0.836 SOL). Band intact signalMinMcap 50k/signalMaxMcap 2M. broad discovery 1000 raw (server total 1059). 0 open positions (deploy blocked by stall, not discipline this time).

See [[deploy-2026-06-13-broad-discovery-faadcec]] (prior deploy: gate was 1, strict-gate bottleneck — this deploy widened the window so gate→4).
