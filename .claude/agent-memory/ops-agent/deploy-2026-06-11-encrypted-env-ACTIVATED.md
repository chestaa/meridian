---
name: deploy-2026-06-11-encrypted-env-activated
description: AES-256-GCM .env burner-key encryption ACTIVATED live on VPS (opsi B, Bro-approved) — master key off-disk in systemd drop-in, dual-system safe
metadata:
  type: project
---

Encrypted .env burner key ACTIVATED on VPS 2026-06-11 (Vega money-path protocol, Bro-approved opsi B). Closes the [[deploy-2026-05-31-encrypted-env]] code (commit 45978f5) that built but VETO'd activation.

**Why:** burner private key was plaintext at-rest in `/opt/meridian/.env`. Bro approved live activation. Vega owns money-path protocol (precision, revert-on-fail, master key never printed).

**How to apply:** future ops touching .env / wallet load / encryption must respect this layout.

### Final state (LIVE, verified)
- `BURNER_WALLET_KEY=enc:...` (AES-256-GCM blob) in `/opt/meridian/.env` line 36.
- Master key `ENV_ENCRYPTION_KEY` lives ONLY in `/etc/meridian/env-key` (mode 600 root:root, 64 bytes, NOT in .env, NOT in git, never printed).
- Injected via systemd drop-in `/etc/systemd/system/meridian.service.d/env-key.conf` (`EnvironmentFile=/etc/meridian/env-key`). systemd merge order: .env (line 20) THEN env-key (line 27) — correct.
- `wallet-loader.js` (imported by tools/wallet.js via `getSigningWallet`) auto-detects `enc:` prefix, decrypts with master key.
- VERIFY log: `[INIT] Wallet source=BURNER_WALLET_KEY (enc:AES-256-GCM) pubkey=DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu`. Pubkey MATCH. Balance 0.851956 SOL. DRY_RUN=false (LIVE). NRestarts=0.

### Dual-encryption-system clearance (GATE 0 — Vega's key concern)
Repo has TWO co-existing systems; confirmed they DO NOT collide:
- LEGACY XOR `envcrypt.js` — imported as side-effect by index.js:1 AND scripts/auto-screener.js:14. **INERT** because: triggers only on a `# encrypted` marker line above a key (none exist), needs `ENVRYPT_KEY`/`ENVCRYPT_KEY`/`.envrypt` (none exist). `parseEncryptedKeys` returns empty → early return, never touches BURNER.
- AES `lib/env-crypto.js` + `wallet-loader.js` — detects `enc:` VALUE prefix (different marker than XOR's `# encrypted` line). No overlap.
- GATE 0 results: Q1 clean (no ENVRYPT_KEY), Q2 clean (no `# encrypted` marker, burner was plaintext `53sk...`), Q3 NEGATIVE (auto-screener has ZERO wallet/BURNER/sign refs → no master-key drop-in needed for it; auto-screener gets the enc: blob as an unused env string, harmless).

### Gotchas
- encrypt-env.js interface: `ENV_ENCRYPTION_KEY` env + plaintext via stdin → stdout `enc:` blob. Never prints plaintext. Stdin mode keeps secret out of shell history.
- Round-trip verify BEFORE mutating .env: read orig burner from .env INSIDE node (not via shell inline env var — base58 chars mangle/empty through `node -e VAR=$x`; first attempt showed false `orig length:0` which was a harness bug, re-run reading from .env gave ROUNDTRIP MATCH:true, 88 chars).
- Recovery: `/root/.env.full-backup-2026-06-11` (mode 600) + `/opt/meridian/.env.bak-pre-encrypt-2026-06-11`. Revert = `cp` backup over .env + restart meridian.
- DO NOT set `ENV_ENCRYPTION_KEY` in .env or as a manual shell export for the service — it comes from the drop-in only.
