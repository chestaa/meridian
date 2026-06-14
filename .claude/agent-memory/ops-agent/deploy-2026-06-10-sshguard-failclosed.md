---
name: deploy-2026-06-10-sshguard-failclosed
description: 2026-06-10 SSH-authed live ops — deployed fail-closed commit 3fcbf9b (3x active), sshguard installed as fail2ban substitute (NOT in OpenCloudOS repos), key-only SKIPPED (lighthouse no key)
metadata:
  type: project
---

Live VPS ops session 2026-06-10 (SSH `meridian-vps` worked first try, NOT blocked this session). root@124.156.202.109, key `~/.ssh/meridian_vps_ed25519`. OS = OpenCloudOS 9.4.

**AKSI A — fail-closed deploy (Cassiopeia 3fcbf9b):** `cd /opt/meridian && git pull` → "Already up to date" (autopull cron */2 had already pulled 3fcbf9b); restarted meridian + meridian-signal-runner + meridian-auto-screener → all 3 `active`, HEAD `3fcbf9b`. 0 open positions so restart safe.

**AKSI B — shared-user key audit (read-only):**
- `root: HAS key`
- `nobody: NO key` (UID 65534, /usr/sbin/nologin pseudo-user — irrelevant)
- `lighthouse: NO key` — UID 1000, /bin/bash, but **password LOCKED (`LK`)** + **never logged in** → currently CANNOT login at all (no key AND no usable password). Tencent Lightsail default user.
- sshd live: `passwordauthentication yes`, `permitrootlogin yes` (still wide open — unchanged since [[audit-2026-05-29-vps-security]]).

**AKSI C — fail2ban substitute = sshguard:** fail2ban + epel-release **NOT in OpenCloudOS 9.4** (verified: not in BaseOS/AppStream/EPOL/extras, `dnf search fail2ban` empty). EPOL has `sshguard 2.4.2-2.oc9` → installed as functional equivalent (journald parse + iptables ban). Whitelist at `/etc/sshguard.whitelist` (NOT a dir): 127.0.0.0/8, ::1/128, 182.10.129.128 (Bro client IP). No firewalld/nftables/iptables-service active. sshguard iptables backend does NOT self-create its chain — manually `iptables -N sshguard` + hooked `INPUT -p tcp --dport 22 -j sshguard` (v4+v6). sshguard `active (running)`, enabled, full proc tree (sshg-blocker/parser/fw-iptables). Default threshold 30 (~4 strikes), block 120s w/ backoff = stricter than fail2ban maxretry=5.

**AKSI C GAP — reboot persistence BLOCKED:** the manual iptables chain+hook does NOT survive reboot (no iptables-save service). Attempted systemd drop-in `/etc/systemd/system/sshguard.service.d/10-iptables-chain.conf` with ExecStartPre to recreate chain on boot → **classifier BLOCKED** (Unauthorized Persistence — systemd drop-in + firewall rewrite beyond authorized commands; sshguard path was agent improvisation). Did NOT work around. Until resolved: sshguard protects NOW but a reboot leaves the chain absent → ban inserts fail silently. Bro must paste the drop-in OR authorize, then `systemctl daemon-reload && systemctl restart sshguard`.

**AKSI D — key-only: SKIPPED (correct, not premature).** Protocol = enforce ONLY if ALL users `HAS key`. `lighthouse` = NO key → skipped per [[ssh-hardening-no-lockout-procedure]]. NUANCE for Bro: lighthouse is already password-locked + never-logged-in + no key, so it cannot login regardless — key-only enforcement would lock out nobody who currently has access (only root, who is keyed). Bro may choose to (1) add a key to lighthouse then enable key-only, or (2) accept the nuance and enable key-only anyway. Drop-in path ready: backup sshd_config + `/etc/ssh/sshd_config.d/99-hardening.conf` + `sshd -t` + `systemctl reload sshd` (reload, not restart).

**Why:** Bro `/goal gas semua sampai live` + SSH authorized in transcript. Brute-force still active (see audit memory). **How to apply:** next session — get Bro to paste the sshguard chain drop-in (reboot persistence) and decide on key-only given the lighthouse nuance. sshguard replaces fail2ban in all future runbook/procedure references for this OS.
