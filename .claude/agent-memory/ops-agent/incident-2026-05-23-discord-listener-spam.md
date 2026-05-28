---
name: incident-2026-05-23-discord-listener-spam
description: Discord-listener crash-loop spam incident on 2026-05-23 — Node 18 vs Node 22 ExecStart bug, watchdog hardening applied
metadata:
  type: project
---

Incident 2026-05-23 07:00-07:08 UTC: `meridian-discord-listener.service` crash-looped at 5-6s interval, watchdog fired Telegram alert per crash (~166 alerts before halt).

**Root cause (single biggest takeaway):** ExecStart used `/usr/bin/node` (v18.20.8 — system default) but the listener's `undici@7.24.5` dep requires Node 20+ (`File` global). VPS has `/usr/local/bin/node` = v22.11.0 but units never pointed to it.

**Why:** Listener was dormant during the entire `useDiscordSignals=false` period since 2026-05-14. Flag flip to `true` on 2026-05-23 was the first time the listener actually loaded its deps in production. Node 18 path bug was latent.

**How to apply:**
- Any new Meridian systemd unit MUST use `/usr/local/bin/node` (Node 22), never `/usr/bin/node`. Grep before adding new units.
- For each `OnFailure=meridian-notify@%n.service` line, also add `StartLimitIntervalSec=300` + `StartLimitBurst=3` in the same [Unit] block. Without this, a fast crash-loop bypasses Restart= throttling and spams alerts.
- Notify template `/etc/systemd/system/meridian-notify@.service` now has a 5-min cooldown lock at `/run/meridian-notify-<unit>.lock` as defense-in-depth (works even if StartLimit fails).
- Before flipping any *Signals=true flag in user-config.json, restart the corresponding listener service ONCE manually in a controlled window to surface dep/env bugs before they crash-loop.
- Backup of pre-incident units lives at `root@VPS:/root/incident-2026-05-23-watchdog-spam/`.

**Open follow-up:** `state.json` shows 8 stale positions while bot reports 0 from Meteora portfolio API. Not part of this incident; route to Andromeda for reconcile.
