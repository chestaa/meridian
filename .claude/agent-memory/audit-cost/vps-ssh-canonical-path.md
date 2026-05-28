---
name: vps-ssh-canonical-path
description: Canonical SSH key path + target for Meridian VPS — use this exact path, never relative ./vps-key
metadata:
  type: reference
---

**Canonical VPS SSH access** (confirmed by Draco 2026-05-20):

- **Key path**: `C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519`
- **Target**: `root@124.156.202.109`
- **Full command pattern**: `ssh -i "C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519" root@124.156.202.109 "<remote command>"`

**Why:** Earlier midday delta check failed because spawn used `./vps-key` relative to working dir, which doesn't exist. Draco confirmed canonical path above.

**How to apply:** Any VPS ops/audit task that needs SSH (journalctl, state.json, paper-trades.json, llm-usage.json, RPC checks) MUST use the absolute key path. Never `./vps-key`, never `~/.ssh/...` shortcuts. Quote the path because of the space in "Pradikta Andrianto".

**Canonical remote paths** (NOT /root/meridian):
- WorkingDirectory (systemd): `/opt/meridian`
- Audit files: `/opt/meridian/paper-trades.json`, `/opt/meridian/state.json`, `/opt/meridian/llm-usage.json`
- Service: `meridian.service` (running PID 2586915 since 2026-05-19 11:14 CST)
- Node binary: `/usr/local/bin/node`

Related: [[telegram-reporting-inventory]]
