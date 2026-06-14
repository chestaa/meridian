---
name: audit-2026-05-29-vps-security
description: VPS security audit findings 2026-05-29 — wallet keys CLEAN, SSH brute-force surface is the open risk (password auth + root login on, no fail2ban)
metadata:
  type: project
---

VPS security audit (root@124.156.202.109) run 2026-05-29 after community DLMM drain report. Verdict 🟡 RISK, no confirmed breach.

**Wallet/secret side = CLEAN:**
- `/opt/meridian/.env` perms `600 root:root`, gitignored, not in journalctl (0 PRIVATE_KEY literals; 24 long-string hits were 88-char tx signatures = public, false positive)
- RPC = Helius private (mainnet.helius-rpc.com) — fast, good vs drainer race
- Drain alert ACTIVE: `notifyBalanceDrain` telegram.js, trigger index.js, 20% / 1h window, 1h cooldown
- No foreign successful root login (only Bro ISP 182.10.x + loopback)

**SSH = the open risk (fix needed before Phase 1):**
- `PasswordAuthentication yes` (should be no)
- `PermitRootLogin yes` (should be prohibit-password)
- fail2ban NOT installed, firewalld inactive
- 702,904 failed login attempts (active brute-force); STILL ACTIVE 2026-06-10 (8007 failed since last successful login — counter resets per login). Hardening procedure prepared → see [[ssh-hardening-no-lockout-procedure]]

**Why:** One weak password = root = read `.env` = wallet drain. Keys are safe but the door is open.
**How to apply:** SSH hardening (disable PasswordAuth, PermitRootLogin prohibit-password, install fail2ban) is the priority infra fix. Touches live auth — requires Bro approval and a non-locking-out test plan (keep current session open while reloading sshd). See [[reference-vps-ssh-canonical-path]].
