---
name: deploy-2026-05-23-pillar-ab-live
description: Phase 1 LIVE go-live restart of meridian.service with Pillar A+B patches (commit e576ad6) — restart clean, 0 open positions
metadata:
  type: project
---

2026-05-23: Bro Dikta authorized "croscheck lg yg udh di implement, pastikan tidak ada bug, dan go live skrg jg". Executed full Phase 1 LIVE go-live via meridian.service restart.

Pre-restart state (verified):
- All 8 patched files SHA256 match between local commit `e576ad6` and `/opt/meridian/*.js` (modulo CRLF/LF normalization for state.js — content identical)
- Money-path files (tools/executor.js, tools/dlmm.js, tools/wallet.js, state.js) match local — no Vega VETO surface modified
- DRY_RUN=false (LIVE confirmed via boolean awk check)
- state.json: 8 total entries, 0 OPEN positions (all `closed`/`closedAt` set) — clean restart window
- Bug sweep all pass: agent.js xiaomi/mimo-v2-pro at line 193, index.js BALANCE_DRAIN_THRESHOLD_PCT=20 + _lastBalanceSample, telegram.js notifyBalanceDrain at line 696, user-config.json useDiscordSignals=true at line 35

Restart at 2026-05-23T07:02:46Z (VPS clock):
- `systemctl is-active meridian.service` → active
- Wallet loaded: `DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu`
- Model loaded: `deepseek/deepseek-v4-flash`
- Cron started: management 10m, screening 30m
- Telegram bot polling started
- First screening cycle fired immediately post-startup
- Discord signal flow visible (useDiscordSignals=true working — many filtered by TVL/volume/mcap thresholds, normal Phase 1 strict gating)
- Risk filter operating (RETARDATIDE-SOL dropped bot_holders 23%, RICH-SOL dropped bot_holders 28%)
- No 400 ladder spam, no SAFETY_BLOCK loop, no error stack traces
- Computed deploy amount: 0.1 SOL (wallet: 0.384334 SOL)

VPS git HEAD diverges from local: VPS at `a0bf6f4` (Meteora screening fixes), local at `e576ad6` (Pillar A+B). Deployed via direct file copy, NOT git pull on VPS. File contents at /opt/meridian/*.js match local e576ad6, verified by SHA256.

Why: Bro's explicit "go live skrg jg" authorization combined with verified zero open position risk and confirmed Pillar A+B patches present made restart the safe choice.

How to apply: future crosscheck restarts use this same gate sequence — (1) hash diff patched files, (2) confirm money-path intact, (3) DRY_RUN=false boolean check, (4) OPEN position count (not total entry count), (5) bug sweep code locators, (6) restart only if OPEN ≤ 2, (7) post-restart journal scan within 2 minutes for startup banner + cron + no errors.

Git push origin main: `ok main` — commit e576ad6 pushed to remote.

Related: [[reference-vps-ssh-canonical-path]] [[deploy-2026-05-17-exec-sweep]]
