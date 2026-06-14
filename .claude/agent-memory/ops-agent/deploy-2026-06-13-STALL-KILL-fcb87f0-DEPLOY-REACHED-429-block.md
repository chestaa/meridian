---
name: deploy-2026-06-13-stall-kill-fcb87f0-deploy-reached-429-block
description: Deploy fcb87f0 STALL-KILL (strip enrichment tools from SCREENER) — STALL DEAD all 3 svc, deploy_position reached in 2 steps (was 16), but actual deploy SAFETY-BLOCKED by fail-closed 429 snapshot-verify (no money lost). Branch name in task was wrong.
metadata:
  type: project
---

# Deploy 2026-06-13 STALL-KILL fcb87f0 — stall dead, deploy reached, safety-blocked on 429

**HEAD main = fcb87f0** (`fix(orion): strip enrichment tools from SCREENER tool-set — kill [SCREENER_STALL]`).

## GOTCHA: branch name in task was WRONG
Task said merge `fix/saveinbox-candidate-field-mapping` — that branch was `Already up to date` (does NOT contain fcb87f0). fcb87f0 actually lived on `feat/broad-discovery-server-client-migration`. Verified `fcb87f0^ == bf87d7e == main HEAD` → clean fast-forward, 1 commit, NOT ribet. Merged `--ff-only fcb87f0` directly (not the named branch). Always `git branch -a --contains <sha>` + `git merge-base --is-ancestor` when task branch name looks stale.

## What fcb87f0 changes (code-only, 4 files +201/-3)
agent.js (+18), index.js (+2), prompt.js (+2), scripts/test-screener-strip-enrichment.js (new 182). Strips enrichment/fetch tools from the SCREENER tool-set so the model can't loop on fetches → forces commit to deploy_position/skip fast. Test 37/37 PASS on VPS (deploy_position reached ≤2 steps, no stall log).

## STALL KILLED — confirmed
`grep -c SCREENER_STALL` since restart = **0** across ALL 3 svc (was the bottleneck at maxSteps=16 prior deploy). Native meridian SCREENER loop: Step 1 → Step 2 `[SCREENER_TOOL_CHOICE_FORCED] orion_enter_high_conf=4 step=2` → deploy_position reached at step 2 (was burning all 16). Strip + tool_choice nudge WORKS.

## Funnel reached deploy_position
Client gate 5/1030 passed → pre-rank top-5 → Orion judged 4 candidates **4 ENTER 0 skip** → SCREENER forced deploy at step 2.

## DEPLOY OUTCOME: SAFETY-BLOCKED (no money lost, gate did its job)
deploy_position reached but blocked by fail-closed pre-deploy snapshot verify:
- 3x `[SNAPSHOT_FETCH_RETRY] transient 429 ... retry 1/3,2/3,3/3` (bf87d7e retry-with-backoff fired)
- all 3 retries hit 429 → `[SAFETY_BLOCK] deploy_position blocked: snapshot_verify_failed: ... Pool Discovery API error: 429 Too Many Requests`
- then `Blocked duplicate deploy_position call — already executed this session` (single-attempt confirmed, NO retry-deploy)
- **open positions = 0** (unchanged). No money moved, no wrong position.

**Root cause = thundering-herd 429**: SAME pattern as prior 06-13 deploy. Right after `systemctl restart` all 3 svc + native discovery fetches 1000 pools + 4-candidate enrichment + bin fetches all hammer Meteora Pool Discovery API simultaneously → API rate-limits → pre-deploy snapshot verify can't confirm thresholds → fail-closed block. Transient, NOT a code bug. A non-restart-boundary cycle (API not saturated) should clear. This is the LAST blocker between reached-deploy and first-real-deploy.

## Other paths (discipline, correct)
- signal-runner: Jotchua mcap$2.9M WATCH 55% max 0 SOL (above early band, vol $7.9K weak, TVL $108K thin micro-share); SPCX $285k WATCH 55% max 0 SOL (meme no catalyst). NO deploy = quality discipline.
- auto-screener: same gate 5/1030 → top-5 enrich, no stall, no deploy this cycle.

## Health
- 3 svc active NRestarts=0, 0 err.
- cost FLAT $0.1179 / 189 calls cap $1.10 (stall step-burn gone, no explosion).
- encryption SURVIVED restart: `[INIT] Wallet source=BURNER_WALLET_KEY (enc:AES-256-GCM) pubkey=DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu` MATCH. .env untouched.
- bal 0.836296 SOL, deploy amount 0.18 SOL (computeDeployAmount), Mode LIVE deepseek-v4-flash.
- config intact: signalMin/Max 50k/2M, timeframe 1h, maxBinStep 200, screeningMaxSteps 16, maxDeploy 0.18, maxPos 3, gasReserve 0.2.

## NEXT
First real deploy is one clean (non-thundering-herd) cycle away. If 429-on-restart keeps blocking, consider staggering svc restarts OR widening snapshot retry budget — but that is Cassiopeia/Vega's safety-gate call, NOT Draco's to loosen unilaterally (fail-closed is correct). See [[deploy-2026-06-13-maxsteps-16-34d6b7a-STALL-GONE-429]] for the same 429 pattern.
