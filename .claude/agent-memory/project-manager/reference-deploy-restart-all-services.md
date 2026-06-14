---
name: reference-deploy-restart-all-services
description: Code deploys must restart ALL meridian services (meridian + signal-runner + auto-screener), not just meridian.service — long-running processes hold stale in-memory code even after autopull updates files.
metadata:
  type: reference
---

After a code deploy (git push → VPS autopull), restarting ONLY `meridian.service` is INSUFFICIENT. There are three long-running services and all run code loaded at their start:

- `meridian.service` — main bot (REPL/cron/management)
- `meridian-signal-runner.service` — signal ingest loop
- `meridian-auto-screener.service` — screening loop (emits deploy candidates + reject reasons)

**Why this matters:** 2026-06-10 discovery — `meridian-signal-runner` + `meridian-auto-screener` had `ExecMainStartTimestamp = 2026-05-23`, never restarted for 18 days. Autopull kept the FILES current (HEAD f019ae1) but those two processes ran in-memory screening code from 2026-05-23 — predating the 2026-05-30 rug-gate / TVL-MC-gate / removed-organic-coupling batch (commit 255ec69). Result: the live screener feeding 15 real-money deploys was running pre-safety-gate code. The tell was reject-string `no_smart_money_low_organic_in_live` appearing in 2026-06-10 logs while the on-disk code (string removed 255ec69) physically couldn't emit it. Also caused: today's `maxPositions=3` config edit didn't take effect because meridian.service (start 06-07) hadn't reloaded.

**How to apply:**
- Any CODE deploy → restart all three: `systemctl restart meridian meridian-signal-runner meridian-auto-screener`
- Any user-config.json change → at minimum restart whichever service reads it (screening config → screener + signal-runner; risk/management → meridian). Safest: restart all three when in doubt.
- VERIFY after restart: `systemctl show <svc> -p ExecMainStartTimestamp` for ALL three = current time. Don't trust "git HEAD matches" alone — file-current ≠ process-current.
- Diagnostic for stale-process suspicion: grep a string that was REMOVED in a known commit against TODAY's log. If it appears but on-disk code has 0 matches → a process is running pre-removal code.
- Restart is safe when 0 open positions (check slots first); state.json persists across restart.
- Relates to [[reference-deploy-pipeline]] (autopull updates files, NOT running processes).
