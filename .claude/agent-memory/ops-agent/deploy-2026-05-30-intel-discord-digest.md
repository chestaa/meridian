---
name: deploy-2026-05-30-intel-discord-digest
description: commit 3ee5694; intel #3 Discord MeteoraIDN ranked source + #5 intel-digest auto-learn pipeline (DeepSeek V4, advisory-only); timer enabled 06:00 UTC; source real but feed empty bc discord-listener dead
metadata:
  type: project
---

Deploy of intel #3 (Discord MeteoraIDN ranked source) + #5 (intel-digest auto-learn pipeline). Commit `3ee5694`, pushed main, VPS autopull synced ~80s.

**Tests on VPS (Node v22):** `test-discord-ranked-source.js` 7/7 PASS, `test-intel-digest.js` 41/41 PASS (incl. config/state/executor/user-config NOT mutated, no money-module imports, writes only intel/digests/).

**intel-digest timer:** Installed units to `/etc/systemd/system/` (autopull only syncs /opt/meridian repo, NOT systemd dir — must cp manually + daemon-reload). Enabled + started. Next fire Sun 2026-05-31 06:00 UTC (=14:00 CST, box is UTC+8). Persistent=true. ExecStart uses /usr/local/bin/node (v22).

**intel-digest live dry run:** read telegram(2604)+discord(160) crawls → 98 corpus lines, DeepSeek V4 Flash, 0 suggestions (nothing advisory-worthy today — safe), cost $0.001271 (<$0.01 cap). Wrote digest-2026-05-30.{json,md}, advisory_only:true. config/state mtimes confirm NO mutation.

**meridian:** restarted to load discord source, active, Mode LIVE, model deepseek-v4-flash.

**Discord MeteoraIDN source — REAL now, not phantom**, wired into screening cycle. BUT logs `feed file not found (/opt/meridian/discord-ranked-digest.json), skipping` — graceful channel-down behavior. Feed is empty because the **discord-listener producing it is DEAD**.

**Why:** discord-listener.service is `disabled` + last crashed 2026-05-23 with `ReferenceError: File is not defined` (undici under Node v18). ExecStart was migrated to /usr/local/bin/node v22 same day (see [[incident-2026-05-23-discord-listener-spam]]) but service left disabled, never restarted since. Ephemeral 12s boot under v22 this session: syntax OK, NO undici crash, boots clean (no ready log in 12s but no error) — **v22 fixes the crash**. DISCORD token present in .env (1 match).

**How to apply:** To make Discord MeteoraIDN source produce real data, the discord-listener needs `systemctl enable --now meridian-discord-listener` — was left out of this deploy scope (consumer wiring only). This is the ONE remaining step to light up the source end-to-end. Flag to Polaris/Bro before enabling a previously-failing background service. Snapshot triggered, ran clean (ExecMainStatus 0).
