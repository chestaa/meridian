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

Suggested permanent hardening: add Host entry to `C:\Users\Pradikta Andrianto\.ssh\config`:
```
Host meridian-vps
    HostName 124.156.202.109
    User root
    IdentityFile C:\Users\Pradikta Andrianto\.ssh\meridian_vps_ed25519
    IdentitiesOnly yes
```
Then `ssh meridian-vps` works from any working dir.
