---
name: deploy-2026-06-03-bossreport-usd-fix
description: boss-report.js USD price 3-source fallback + real-money wording deploy; commit 408ee7e landed VPS via autopull; SSH meridian-vps alias was missing and got restored
metadata:
  type: project
---

Deploy 2026-06-03: boss-report.js fix (Lyra's work) — live SOL USD 3-source fallback
(Jupiter v2 404 → v3 + coingecko) + wording "uang sungguhan" → "real money".

- Commit `408ee7e` ("fix(boss-report): live SOL USD 3-source fallback (jup v2 404->v3+coingecko) + real money wording"), single file `scripts/boss-report.js` (+47/-14).
- Tests: `scripts/test-boss-report-sections.js` 26/26 PASS (NOT test-boss-report.js — that name doesn't exist; the two boss-report tests are `test-boss-report-sections.js` and `test-boss-report-cost.js`).
- Landed VPS via */2 autopull cron (~2 polls). VPS HEAD confirmed `408ee7e`, tracked tree clean (no conflict/classifier block). NO meridian.service restart — boss-report runs on cron 09:00 WIB standalone.
- NO money path, NO config flag touched.

**Why:** Issue 3 diagnosis — boss-report showed stale/wrong USD; Lyra fixed price fetch + executive wording.
**How to apply:** future boss-report deploys are code-only, no restart needed; cron picks it up next 09:00 WIB run.

SSH ops note: `~/.ssh/config` was EMPTY at session start — `meridian-vps` alias did not resolve.
Restored alias: HostName 124.156.202.109, User root, IdentityFile ~/.ssh/meridian_vps_ed25519,
IdentitiesOnly yes. (VPS IP recovered from `~/.ssh/known_hosts`.) See [[reference-vps-ssh-canonical-path]].
If a future deploy hits "Could not resolve hostname meridian-vps", re-write that 4-line config block.
