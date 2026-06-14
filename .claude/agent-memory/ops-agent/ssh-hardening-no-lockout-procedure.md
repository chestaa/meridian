---
name: ssh-hardening-no-lockout-procedure
description: No-lockout SSH hardening procedure for the SHARED Meridian VPS — fail2ban first (zero risk), then key-only with reload+verify-before-close protocol
metadata:
  type: project
---

SSH hardening procedure prepared 2026-06-10 (brute-force flagged: 8007 failed logins since last successful root login; absolute counter 702k+ at audit). Bot is LIVE money on `root@124.156.202.109` (OpenCloudOS 9.4, RHEL-family). **VPS is SHARED with a neighbor project** — sshd changes affect them too.

**Order by safety (additive first):**
1. **STEP 0 re-confirm (read-only, always safe):** `cat ~/.ssh/authorized_keys`, `sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin|pubkeyauthentication'`, check fail2ban, enumerate `/etc/passwd` users + which ones have `authorized_keys`. Audit data decays — never act on stale audit numbers without re-confirm.
2. **STEP 1 fail2ban (ZERO lock-out — gas anytime):** `dnf install epel-release` then `fail2ban fail2ban-systemd`; jail in `/etc/fail2ban/jail.d/sshd-local.conf` (backend=systemd, maxretry 5, findtime 10m, bantime 1h, ignoreip loopback + Bro ISP 182.10.x). Rate-limits attacker IPs only, never touches legit access. THIS IS THE QUICK WIN.
3. **STEP 2 key-only (gas ONLY after STEP 0 confirms key auth works AND all neighbor users use keys):** drop-in `/etc/ssh/sshd_config.d/99-draco-hardening.conf` with `PasswordAuthentication no` + `PermitRootLogin prohibit-password`. Backup sshd_config first. **NO-LOCKOUT PROTOCOL:** `sshd -t` (syntax) → `systemctl reload sshd` (reload NOT restart — keeps session alive) → open NEW terminal, verify `ssh ... "echo LOGIN_OK"` → ONLY THEN close old session. Revert = `rm` the drop-in + reload.
4. **STEP 3 port move (FLAG — do NOT push):** affects neighbor + all tooling (autopull cron, status snapshot SSH). Marginal gain over fail2ban+key-only. Skip unless log noise is an operational problem.

**Why:** one weak root password = wallet drain (`.env` is 600 but readable by root). fail2ban + key-only kills the brute-force vector. Reason it's not done yet: touches live auth on a shared box — needs Bro at the VPS terminal + neighbor coordination.
**How to apply:** STEP 1 is always-safe, recommend immediately. STEP 2 is BLOCKED on shared-user check — if any neighbor user lacks `authorized_keys`, STOP and flag to them before disabling password auth (they'd lock out). See [[audit-2026-05-29-vps-security]] and [[reference-vps-ssh-canonical-path]] (SSH from dev env recurringly absent → cannot live-verify, do NOT fabricate state).
