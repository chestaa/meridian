---
name: deploy-2026-06-04-drain-falsealarm-fix
description: 2026-06-04 pull+restart for Vega's BURNER BALANCE DRAIN false-alarm fix (sentinel-0 read); commit 78e179a, no config change
metadata:
  type: project
---

Deploy 2026-06-04: Vega's phantom "BURNER BALANCE DRAIN" false-alarm fix — pull + restart only, NO config/flag change.

- **Commit:** `78e179a` fix(money-path): kill phantom BURNER BALANCE DRAIN false-alarm (sentinel-0 read). Files: index.js (+173), tools/wallet.js, tools/executor.js, scripts/test-drain-monitor.js (new, 247 lines).
- **Autopull:** cron */2 had ALREADY pulled — VPS HEAD `78e179a` on first check, no manual pull needed. Branch main up-to-date with origin (only untracked .bak files).
- **Restart:** `sudo systemctl restart meridian` only. meridian-signal-runner left untouched (stayed active throughout). Pre-restart meridian had been running since 2026-06-02 22:34 (stale code) → restart loaded fix. Post: active, MainPID 549395, fresh start 2026-06-04 14:36:08 CST, NRestarts=0.
- **Verification:** journal 0 ERROR since restart. Mode: LIVE, model deepseek-v4-flash. Wallet load OK source=BURNER_WALLET_KEY pubkey Dg...1Hiu. First balance read = **0.856167 SOL** (correct, NOT 0/null — sentinel-0 fix works). No DRAIN/ALERT/HALT line in journal (false alarm gone). test-drain-monitor.js 34/34 PASS on VPS prod env.

**Why:** drain monitor was firing false "BURNER BALANCE DRAIN" alerts on a sentinel/error read (sol:0 with error:true was being treated as genuine drain instead of read-failure). Fix: coverage gate now REFUSES on read-failure (e4/e7 test cases) vs treating as insufficient.
**How to apply:** drain monitor logic lives in index.js + tools/wallet.js + tools/executor.js. The semantic distinction is sol:0+error:true → read-failure (refuse, not alert), vs genuinely-insufficient → refuse with insufficient reason. See [[audit-2026-05-29-vps-security]] (drain alert was noted active there).
