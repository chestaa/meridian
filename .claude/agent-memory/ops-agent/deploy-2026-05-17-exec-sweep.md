---
name: deploy-2026-05-17-exec-sweep
description: Combined Sirius executive-mode + Andromeda legacy-sweep deploy outcome
metadata:
  type: project
---

10 files deployed to VPS (root@124.156.202.109:/opt/meridian/). All 12 regression suites green (204+ assertions). 3 services (meridian, meridian-signal-runner, meridian-auto-screener) restarted clean, no errors. Dry-run sweep showed 33 matured trades, avg -11.97% PnL. Actual sweep committed all 33. paper-trades.json now: total 33, open 0, closed 33, swept 33. telegramExecutiveMode=true, threshold=15%.

**Why:** Sirius needed exec-mode notif gating to reduce Telegram noise; Andromeda needed legacy sweep to retire pre-andromeda paper trades.

**How to apply:** Future paper-trade rollouts can assume zero legacy open trades. Executive mode applies to all 3 services. If notif noise reappears, check telegramExecutiveMode flag in user-config.json.
