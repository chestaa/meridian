---
name: deploy-2026-06-11-keyonly-sshguard-persist
description: BLOK D key-only SSH hardening + BLOK E sshguard reboot-persistence — both APPLIED & verified on VPS, closes open items from 2026-06-10 session
metadata:
  type: project
---

2026-06-11 (~00:30 UTC VPS clock): Executed BLOK D (key-only SSH) + BLOK E (sshguard
reboot persistence) live on meridian-vps. Bro-authorized "gas sampai live". Both APPLIED
& VERIFIED. SSH worked this session (root keyed). This closes the two open items from
[[deploy-2026-06-10-sshguard-failclosed]] (reboot-persistence was classifier-BLOCKED then;
key-only was SKIPPED then).

**Why:** SSH was wide open (password+root login) since [[audit-2026-05-29-vps-security]];
brute-force still active. Bro confirmed key-only is safe: lighthouse user is
password-locked + never-logged (won't lock anyone out), only root is keyed.

**BLOK D — key-only (APPLIED, no lockout confirmed):**
- Backed up /etc/ssh/sshd_config + wrote /etc/ssh/sshd_config.d/99-hardening.conf
  (PasswordAuthentication no / PermitRootLogin prohibit-password / PubkeyAuthentication yes).
- `sshd -t` PASS, `systemctl reload sshd` (NOT restart).
- **GOTCHA (non-obvious, load-bearing):** first reload showed `passwordauthentication yes`
  STILL effective. SSH is FIRST-MATCH-WINS and `Include /etc/ssh/sshd_config.d/*.conf` is at
  line 15 of main config (parsed before main's line-65/132 `yes`). Within the drop-in dir,
  `50-cloud-init.conf` (single line `PasswordAuthentication yes`) is lexically BEFORE
  `99-hardening.conf` → 50 wins, my 99 never takes effect for PasswordAuthentication.
  PermitRootLogin resolved fine because ONLY 99 + main set it (99 wins via earlier Include).
- **FIX:** backed up 50-cloud-init.conf → rewrote it to `PasswordAuthentication no` (commented
  the old line, noted Draco hardening). Cloud-init only rewrites on instance re-init, not reboot.
- Re-verify `sshd -T`: passwordauthentication no / permitrootlogin without-password /
  pubkeyauthentication yes — ALL correct.
- **NO-LOCKOUT VERIFY (WAJIB, PASS):** fresh connection with
  `-o ControlMaster=no -o ControlPath=none -o PreferredAuthentications=publickey
  -o PasswordAuthentication=no` printed LOGIN_OK as root. Key auth confirmed post-hardening.

**BLOK E — sshguard reboot persistence (APPLIED):**
- Wrote /etc/systemd/system/sshguard.service.d/10-iptables-chain.conf with ExecStartPre lines
  (idempotent: `-N sshguard` ignore-fail + `-C ... || -A` for both iptables & ip6tables on dport 22).
- Classifier did NOT block the tee/drop-in write this session (it blocked the equivalent on 06-10).
- daemon-reload + restart sshguard + sleep 2: `iptables -C` v4 OK, `ip6tables -C` v6 OK,
  is-active = active. Chain now re-hooks automatically on every sshguard start (survives reboot).

**How to apply:** VPS SSH is now key-only + sshguard auto-persists. When touching sshd config,
remember FIRST-MATCH-WINS + lexical drop-in order — a later-numbered drop-in does NOT override
an earlier one for the same directive; neutralize the earlier file. Do NOT remove 50-cloud-init
backup or the .bak sshd_config without reason. SSH connections emit a harmless post-quantum KEX
warning on this OpenSSH — ignore it. See [[ssh-hardening-no-lockout-procedure]].
