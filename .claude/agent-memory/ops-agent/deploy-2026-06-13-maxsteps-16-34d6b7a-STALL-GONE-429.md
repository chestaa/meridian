---
name: deploy-2026-06-13-maxsteps-16-34d6b7a-stall-gone-429
description: Deploy 34d6b7a screeningMaxSteps 8->16 — SCREENER_STALL ELIMINATED, deploy_position path reached, but first real deploy not yet successful (transient 429 + Orion WATCH discipline)
metadata:
  type: project
---

Deploy LAST-MILE step-budget fix 2026-06-13 (HEAD main=34d6b7a, ff merge 588f9d8..34d6b7a single commit `fix(orion): raise screeningMaxSteps 8->16`). Touched config.js (+19/-4) + scripts/test-screener-cost.js. 3 svc active NRestarts=0, 0 err, disk 67%, mem 1.4Gi free.

**STALL ELIMINATED (the fix works):** `SCREENER_STALL` count = **0** across all 3 services post-restart (was the dominant blocker at maxSteps=8). With budget 16 the SCREENER ReAct loop now reaches `deploy_position` — main meridian cron got there at step 4-5 (enrichment batch get_pool_detail+smart_wallets+token_holders+token_narrative no longer exhausts the budget before deploy). Bottleneck moved PAST the loop tuning. See [[deploy-2026-06-13-window-fix-588f9d8-maxsteps-bottleneck]] (prior: stall WAS the wall).

**FIRST REAL DEPLOY — NOT yet successful this session, but NOT a failure:** two parallel deploy paths, both behaved correctly/safely:
- **Native main-meridian cron:** Orion judged 2 enter/0 skip (SPCX-SOL, trelon-SOL), agent REACHED deploy_position. Deploy refused by `[SAFETY_BLOCK] deploy_position blocked: Could not verify pool screening thresholds before deploy: Pool Discovery API error: 429 Too Many Requests` (the fresh-snapshot threshold-verify guard fail-closed). Second pool blocked as duplicate-deploy-in-session. Result `NO DEPLOY`, 0 position. 429 is a SINGLE transient burst at 14:42:20Z (restart thundering-herd: 3 svc each broad-fetch 1000 pools hammered Pool Discovery API simultaneously), self-clears. The two 429 log lines are the SAME event (second is summary echo), NOT two failures.
- **Signal-runner (Orion judge):** same SPCX/trelon judged **WATCH 55%/45%, max 0 SOL** — deliberately NOT enter. Reason: TVL tiny ($24k/$27k), 24h volume null/proxied <$200, micro fee-share. Quality discipline, correct hold. Inbox consumed→empty.

**Net:** step-budget fix unblocked the loop (stall gone, deploy path reached) but the first real on-chain deploy still didn't fire — once by a transient 429 on the safety-verify (guard worked), once by judge WATCH (discipline). Both are SAFE outcomes: NO money lost, NO wrong position, all caps intact. If Bro wants the actual first txn, watch the next clean cron cycle (screeningIntervalMin=30) where 429 has cleared AND a candidate clears Orion ENTER with non-zero size.

**Config set (user-config TOP-LEVEL flat key, gitignored VPS copy, backup user-config.json.bak-maxsteps16-2026-06-13):** added `screeningMaxSteps:16` (was ABSENT → relied on config.js default which 34d6b7a also bumped 8->16, so runtime was already 16; explicit set makes it default-proof). GOTCHA: config.js reads `u.screeningMaxSteps` flat top-level → assigns `config.llm.screeningMaxSteps` (config.js:451). Stray top-level `maxSteps:20` still present and STILL IGNORED by config.js. Verified live `config.llm.screeningMaxSteps=16`.

**Safety caps verified live:** maxDeployAmount=0.18, maxPositions=3, gasReserve=0.2, band signalMinMcap=50k/signalMaxMcap=2M intact, timeframe=1h/maxBinStep=200 intact. Deploy amount computed 0.18 SOL (wallet 0.836296 SOL). Encryption SURVIVED restart: `[INIT] Wallet source=BURNER_WALLET_KEY (enc:AES-256-GCM) pubkey=DgA9MZYE...1Hiu` MATCH; .env mtime 2026-06-11 untouched, BURNER_WALLET_KEY=enc: prefix intact. NEVER touched .env. Model deepseek-v4-flash LIVE.

**Cost FLAT:** today $0.0778/119 calls cap $1.10 (was $0.0725/109) — budget 2x did NOT explode cost (pre-rank top-3 + cost-flat limit=10 hold; SCREENER_TOOL_CHOICE_FORCED short-circuits the loop once enter-high-conf). No runaway.
