---
name: deploy-2026-05-29-phase-aj
description: Phase A (Discord merge flag) + Phase J (token age 24h/720h + Jupiter created_at fallback) live deploy 2026-05-29
metadata:
  type: project
---

Phase A + J deployed live 2026-05-29 to VPS root@124.156.202.109 (/opt/meridian). Commit `bfc72b7` "Phase J: token age tune".

**Why:** Bro Dikta wanted everything done same day; Phase J tunes token-age screening (min 24h/max 720h code defaults) + back-fills token_age_hours from Jupiter created_at when Meteora returns null; Phase A flips `useDiscordSignals` true (merge mode) to start consuming Discord signals.

**How to apply:**
- Phase J shipped via git (VPS auto-pull ~45-60s). Phase A flipped via `sed` direct on gitignored user-config.json (backup at `/opt/meridian/.bak-phaseAJ-2026-05-29/user-config.json.bak`).
- meridian.service restarted clean: active, NRestarts=0, Mode LIVE, model deepseek/deepseek-v4-flash. Test `scripts/test-token-age-filter.js` 6/6 PASS on VPS.
- DISCREPANCY surfaced to Bro: VPS user-config.json had live `minTokenAgeHours: 8` / `maxTokenAgeHours: null` (NOT the new 24/720 code defaults). Since user-config.json overrides config.js defaults, live age gate stays 8h/no-max until Bro decides to update the runtime values. Phase A spec only authorized the Discord flag flip, so age values left untouched.
- GAP surfaced: `useDiscordSignals: true` is set but NO active Discord source — `discord-listener` unit does not exist, `signals/inbox/` empty. Merge has nothing to merge yet. Sirius owns Discord collector path. See [[incident-2026-05-23-discord-listener-spam]].
- Rollback: `cp .bak-phaseAJ-2026-05-29/user-config.json.bak user-config.json && systemctl restart meridian`; code revert via `git revert bfc72b7` + push.
