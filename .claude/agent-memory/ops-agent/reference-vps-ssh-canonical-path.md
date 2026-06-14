---
name: reference-vps-ssh-canonical-path
description: Canonical SSH key path for Meridian VPS root@124.156.202.109 after 2026-05-14 relocation
metadata:
  type: reference
---

VPS SSH access for `root@124.156.202.109` (OpenCloudOS, VM-1-176-opencloudos):

- **Private key:** `C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519`
- **Public key:**  `C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519.pub`
- **Key type:** ed25519 (399 bytes)

Canonical command:
```
ssh -i "C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519" -o StrictHostKeyChecking=no -o BatchMode=yes root@124.156.202.109
```

**DO NOT** reference `./vps-key` in project working dir — that file was deleted 2026-05-14 (see `docs/ops/2026-05-14-vps-key-relocation.md`). Any script/agent still using the old path will fail with `Permission denied (publickey,gssapi,password)` because SSH cannot find the key and falls back to auth methods that aren't configured.

Transient failure mode: first connection may return `Connection reset by peer` (server-side rate limit / brief blip). Retry once before declaring broken.

**RECURRING DISAPPEARANCE (escalating):** the SSH material vanishes from this dev env intermittently. 2026-06-03: `~/.ssh/config` found EMPTY but key present (restored alias). 2026-06-04: ENTIRE `~/.ssh` directory ABSENT — no key, no config, no dir. When this happens an agent CANNOT reach the VPS at all; steps requiring SSH (HEAD confirm, manual run) must be reported as blocked, NOT fabricated. Always probe `Test-Path $env:USERPROFILE\.ssh` and `Test-Path ...\meridian_vps_ed25519` FIRST before any `ssh`. Bro must re-provision the key (from secure backup) into `~/.ssh/meridian_vps_ed25519` for SSH-dependent ops to resume.

Suggested permanent hardening: add Host entry to `C:\Users\Pradikta Andrianto\.ssh\config`:
```
Host meridian-vps
    HostName 124.156.202.109
    User root
    IdentityFile C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519
    IdentitiesOnly yes
```
Then `ssh meridian-vps` works from any working dir.
