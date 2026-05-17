---
name: telegram-reporting-inventory
description: Map of all Telegram notification paths in Meridian + boss-report systemd timer installed 2026-05-16
metadata:
  type: project
---

# Telegram Notification Inventory (VPS /opt/meridian, snapshot 2026-05-16)

## Active notification paths

| Event | Source file | Function | Trigger |
|---|---|---|---|
| Deploy success | tools/executor.js:623 | notifyDeploy (telegram.js:442) | post deploy_position |
| Close success | tools/executor.js:625 | notifyClose (telegram.js:464) | post close_position |
| Deploy failure | tools/executor.js:608,680 | notifyDeployFailure (telegram.js:506) | deploy rejected/error |
| Circuit breaker tripped | account-circuit-breaker.js:30 | notifyCircuitBreaker (telegram.js:527) | drawdown/halt |
| Swap | telegram.js | notifySwap | post token swap |
| Daily briefing | index.js:866 (cron `0 1 * * *` UTC = 08:00 WIB) | sendBriefing | internal node-cron |
| Mgmt cycle report | index.js:383 | sendMessage | every managementIntervalMin |
| Screening cycle report | index.js:830 | sendMessage | every screeningIntervalMin |
| Signal-first verdict | scripts/signal-runner.js:69 | sendMessage | per signal processed (PASS or SKIP) |
| Signal-runner idle heartbeat | scripts/signal-runner.js | sendMessage | inbox idle >6h, 12h cooldown |
| Auto-screener alerts | scripts/auto-screener.js:42 | direct fetch sendMessage | per screening hit |

## Schedules

- Internal node-cron lives inside `meridian.service` (index.js): management, screening, hourly health, daily briefing 01:00 UTC, briefing watchdog every 6h.
- **NEW 2026-05-16**: systemd timer `meridian-boss-report.timer` → runs `scripts/boss-report.js` daily at 02:00 UTC (09:00 WIB / 10:00 CST). Service unit: `meridian-boss-report.service`. Logs to `/opt/meridian/boss-report.log`.

**Why:** Bro Dikta requested daily PnL/status reports to Telegram and assurance bot is alive.

**How to apply:** When asked about reporting cadence, this is the canonical map. If new notif events get added, update this file. Do NOT add money-touching cron jobs — boss-report is read-only.

## Gaps identified (proposed to Polaris, code NOT yet written)

1. **Paper trade open notification** — DRY_RUN deploys via signal-runner skip notifyDeploy (only real executor.js path fires it). Bro can't see paper deploys in real-time.
2. **Paper trade close notification** — Same gap; paper-trades.json closures don't emit Telegram.
3. **Cost burn alert** — No daily LLM cost threshold alert. `llm-usage.json` tracked but no watcher fires at $0.50/$1.00/etc.
4. **Per-source signal quality summary** — Sirius source W/R not surfaced in any report.
5. **Service down alert** — No watchdog notifies if any of 5 systemd services flips to failed.

## Active services (2026-05-16 confirmed)

- meridian.service
- meridian-auto-screener.service
- meridian-signal-runner.service
- meridian-discord-listener.service
- meridian-telegram-userbot.service
- (+ new) meridian-boss-report.timer
