---
name: deploy-2026-06-11-solscan-revive-8a7371d
description: Deployed Sirius 8a7371d (solscan-trending keyless Jupiter revive) — source live 15 pools, candidate flow up, judge firing, no new deploy (discipline)
metadata:
  type: project
---

Deployed Sirius commit **8a7371d** `fix(signal-sources): solscan-trending uses keyless Jupiter primary — revive source w/o paid Birdeye key`. Lever buat trade frequency (gas-to-live).

**Why:** solscan-trending was dead-weight emitting `BIRDEYE_API_KEY not set, skipping` (paid key absent). Sirius rewrote to use keyless Jupiter as primary → revives source without paying for Birdeye. More quality INPUT to funnel = more chances good pools reach Orion judge.

**How to apply:** when verifying a "revive source" deploy, don't just confirm restart — wait 1-2 screening cycles and grep auto-screener log for the source's pool-count line. Source health = "N DLMM-backed pool(s) from M trending token(s)", NOT just service active.

### Deploy mechanics (GOTCHA — commit was NOT on main)
- Task said `git pull origin main` but 8a7371d lived on branch `fix/saveinbox-candidate-field-mapping`, exactly **1 commit ahead of main, ff-safe** (`git merge-base --is-ancestor main <branch>` exit 0). `git pull origin main` returned "Already up to date" at f4a3d3f.
- Resolved by ff-only merge into main on VPS + push (`f4a3d3f..8a7371d main -> main`), same pattern Sirius used for f4a3d3f. Diff = SINGLE file `tools/sources/solscan-trending.js` (+98/-9), no money/state/systemd touched.
- Restart 3: meridian + meridian-signal-runner + meridian-auto-screener → all active, NRestarts=0, runtime HEAD=8a7371d.

### Verified live (cycle 18:15 CST / 10:15Z, PID 2837193 post-restart)
- **solscan-trending: 15 DLMM-backed pool(s) from 20 trending tokens** — REVIVED (was 0, "skipping"). Confirmed Jupiter keyless path works on VPS.
- Source breakdown per cycle: discord-meteoraidn **42** + solscan **15** + pumpfun-graduated **3** = ~60 raw into funnel.
- Funnel → 1 candidate → inbox → Telegram → signal-runner consumed → **[ENRICH] Jotchua mcap$3.6M vol$15.9k tvl$190k → Orion JUDGE FIRED → WATCH (35%)** full reason (mcap too high for early band, prefers pullback). Judge working, verdict = discipline WATCH (mediocre pool, NOT forced deploy).
- LLM cost today: **$0.052835 / 63 calls** (cap $1.10, well under). llm-usage.json shape = {records:[{ts,cost_usd}]}, filter ts.startswith date.
- **No new deploy.** Meteora portfolio API (authoritative) = "Found 0 pool(s) with open positions". state.json `positions` is a dict of 25 HISTORICAL keyed entries (no `status` field, NOT open positions) — do NOT read state.json positions count as open count; trust portfolio API log line.

### discord-meteoraidn listener (healthy)
- `meridian-discord-listener.service` active, NRestarts=0, uptime since 2026-05-30 21:31 CST (PID 983879, cgroup-confirmed legit — see [[vps-swap-2gb-and-discord-pid-trap]]).
- `/opt/meridian/discord-ranked-digest.json` 67K, last write Jun 11 12:36 CST — NOT idle, actively mirroring #dlmm-exotic-opps + #dlmm-multiday-opps on each new post. 42 ranked-digest pools feeding screener.

### Health
- 3 services + discord-listener all active, NRestarts=0. No errors last 30min across all 4. No source fetch fail/429/401/timeout in last 20min (only expected mcap-band filters: HUNTER-SOL below minMcap, JUP-xSOL above maxMcap).

HEAD main = 8a7371d. Relates to [[deploy-2026-06-11-saveinbox-fieldmap-FUNNEL-UNBLOCKED]].
