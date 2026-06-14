---
name: deploy-2026-05-30-discord-listener-enabled
description: meridian-discord-listener re-enabled 2026-05-30 (closes Fix #3 end-to-end); v22 ExecStart confirmed, connected as kumis.kucing watching MeteoraIDN, feed event-driven so empty until first live post
metadata:
  type: project
---

`meridian-discord-listener.service` enabled + started 2026-05-30 21:31 CST, completing Fix #3 (Discord MeteoraIDN source) end-to-end. Listener had been disabled since 2026-05-23 crash (see [[incident-2026-05-23-discord-listener-spam]]).

**Verified on VPS (root@124.156.202.109):**
- ExecStart already `/usr/local/bin/node` (v22) — no fix needed (the v18 ExecStart bug from [[incident-2026-05-23-discord-listener-spam]] was already corrected).
- Active, NRestarts=0, single stable PID, ~41M mem. NO crash-loop.
- Connected as Discord user `kumis.kucing`, watching guild MeteoraIDN, 4 channels: `#dlmm-multiday-opps`, `#dlmm-exotic-opps`, `#metlex-dlmm-bot`, `#metlex-dammv2-bot`.
- Zero watchdog alerts (rate-limit hardening from [[incident-2026-05-23-discord-listener-spam]] holding).

**Feed path match (no mismatch):** listener writes `RANKED_DIGEST_FILE = DISCORD_RANKED_FEED || /opt/meridian/discord-ranked-digest.json`; meridian parser `tools/sources/discord-meteoraidn.js` reads `DIGEST_FEED_FILE` with identical resolution. Also mirrors inbox signals to `/opt/meridian/signals/inbox/` (consumed by meridian-signal-runner, active).

**Meridian side LIVE:** user-config.json has `useDiscordSignals: true`, `discordSignalMode: "merge"`. screening.js line ~509 defaults `discordSource` to `meteoraidn_ranked` → calls `fetchDiscordMeteoraIdnRanked()`.

**Why feed files absent at deploy time:** writes are EVENT-DRIVEN — listener only writes `discord-ranked-digest.json` / `discord-signals.json` / inbox files when a NEW message lands in a watched channel. No history backfill. Files + meridian merge log lines will appear on first live MeteoraIDN ranked post. Graceful skip logged when feed file absent (expected current state).

**How to apply:** Fix #3 is plumbing-complete and armed-inert. Do NOT treat empty feed file as failure — it means no MeteoraIDN post arrived yet. To verify live data flow later, re-check `/opt/meridian/discord-ranked-digest.json` existence and `journalctl -u meridian | grep meteoraidn` after a channel posts.
