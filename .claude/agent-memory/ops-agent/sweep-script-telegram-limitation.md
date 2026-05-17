---
name: sweep-script-telegram-limitation
description: scripts/sweep-paper-trades.js now loads dotenv automatically (fixed 2026-05-17); Telegram aggregate works on manual CLI invocation
metadata:
  type: project
---

`scripts/sweep-paper-trades.js` previously did NOT load `.env`, so manual `node` invocations skipped the Telegram aggregate (telegram.js `isEnabled()` returned false without `TELEGRAM_BOT_TOKEN`).

**Fixed 2026-05-17**: prepended `import "dotenv/config";` at top of script. SCP'd to VPS `/opt/meridian/scripts/sweep-paper-trades.js`. Verified with `--dry` (clean exit, 0 matured remaining post-sweep).

**Why:** Bro on executive notification mode — aggregate Telegram on sweep is the ONLY notification he gets for batch closes. Missing it = blind spot.

**How to apply:** Any future one-shot CLI tool that uses `telegram.js` must `import "dotenv/config";` at the top. systemd services already get env via EnvironmentFile, but standalone `node scripts/X.js` does not.
