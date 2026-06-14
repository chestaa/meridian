---
name: deploy-2026-05-29-activate-sources
description: Activated Solscan+Pumpfun source flags on VPS 2026-05-29; Solscan now LIVE after Birdeye key provisioned (commit 163f734), Pumpfun merge live
metadata:
  type: project
---

Activated new source flags in `/opt/meridian/user-config.json` (flat schema, gitignored) via node read-modify-write. All 5 confirmed by grep:
`useSolscanTrending=true`, `solscanTrendingMode="merge"`, `usePumpfunGraduated=true`, `pumpfunGraduatedMode="merge"`, `requireMultiSourceConfirm=false` (soft, bonus-only — no hard gate).

Backup: `/opt/meridian/.bak-activate-sources-2026-05-29.json`.

meridian.service restarted → active, Mode: LIVE, burner wallet `DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu`, screening model `deepseek/deepseek-v4-flash`, screening every 30m.

Cycle result:
- **Pumpfun-graduated MERGE LIVE**: 4 DLMM-backed pools from 50 fresh / 50 graduated coins (≤48h).
- **Solscan-trending BLOCKED (initial)**: `Birdeye HTTP 401 Unauthorized` — source internally calls Birdeye API, key was missing on VPS. Graceful degrade, no flood.

**UPDATE 2026-05-29 (Phase D follow-up, commit 163f734 "Birdeye X-API-KEY header + graceful no-key guard"):** Provisioned `BIRDEYE_API_KEY` in `/opt/meridian/.env` (gitignored, direct VPS edit, backup `.env.bak-birdeye-2026-05-29`). Restarted meridian → **Solscan-trending now LIVE**: `solscan-trending: 13 DLMM-backed pool(s) from 20 trending token(s)`, no more 401. Pumpfun still healthy (4 pools). 4th source fully active.

**Why:** Bro Dikta provided Birdeye key. **How to apply:** Solscan source needs `BIRDEYE_API_KEY` in VPS `.env` to function. If 401 returns, key may be invalid/expired — check `.env` presence with `grep -c '^BIRDEYE_API_KEY='` (never echo value). Birdeye key is the dependency, not config flags.

Rollback flags: `cp .bak-activate-sources-2026-05-29.json user-config.json && systemctl restart meridian`. Rollback env: `cp .env.bak-birdeye-2026-05-29 .env`.

Related: [[deploy-2026-05-29-phase-dgb]] (where Solscan+Pumpfun sources first shipped, flags OFF).
