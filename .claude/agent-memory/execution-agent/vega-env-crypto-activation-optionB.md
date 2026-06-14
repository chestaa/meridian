---
name: vega-env-crypto-activation-optionB
description: Opt-B encrypted .env activation (master key on-VPS root-600); plus the TWO co-existing env-crypto systems conflict that gates execution
metadata:
  type: project
---

Bro APPROVED (explicit override, 2026-06-11) "Option B": activate AES-256-GCM at-rest
encryption for `BURNER_WALLET_KEY` on the VPS, with master key `ENV_ENCRYPTION_KEY`
stored in `/etc/meridian/env-key` (root-600) — NOT offline. Goal: protect against the
non-root neighbor on the shared VPS + accidental .env commit/leak. Trade-off (key on
same box) accepted by Bro. Vega VETO lifted for Option B; safety protocol stays as
execution guardrail. Builds on [[vega-env-crypto-aes-gcm]].

**Why:** burner key was plaintext in VPS `.env`, shared box w/ non-root neighbor.

**TWO env-crypto systems co-exist in the repo (CRITICAL — verify before any exec):**
- System A `envcrypt.js` (XOR, legacy): key var `ENVRYPT_KEY`/`ENVCRYPT_KEY`/file `.envrypt`;
  marker `# encrypted` line above the key; `loadEnv()` auto-runs at boot, mutates process.env
  in place. Imported by index.js, cli.js, setup.js, auto-screener.js.
- System B `lib/env-crypto.js` (AES-256-GCM, the one we use): key var `ENV_ENCRYPTION_KEY`;
  `enc:` value prefix; lazy decrypt in wallet-loader.js `getSigningWallet()`.
- They are NON-INTERCHANGEABLE. Safe to coexist ONLY if the burner line has `enc:` value
  and NO `# encrypted` marker above it. If System A is active OR a `# encrypted` marker sits
  above BURNER, the "plaintext" key may actually be XOR-encrypted → execution sequence differs.

**Service wallet-load map (who needs ENV_ENCRYPTION_KEY):**
- `index.js`/meridian.service → loads wallet (getWalletBalances/getMyPositions/deploy) → NEEDS key, drop-in required.
- `signal-runner.js` → parse/enrich/judge only, NO wallet import → does NOT need key (least-privilege, skip).
- `auto-screener.js` → imports envcrypt.js (System A) but NO wallet-loader → does NOT need ENV_ENCRYPTION_KEY,
  UNLESS it spawns index.js/executor to sign TX (Draco must confirm prod deploy-trigger path).

**How to apply:** before relaying the encrypt sequence to Draco, run Gate 0 (check `.envrypt`/
`ENVRYPT_KEY` absent + no `# encrypted` marker on BURNER). Recovery file root-600 FIRST, encrypt
via STDIN (never inline arg → shell history), verify burner pubkey `DgA9MZYE...1Hiu` matches in
init log `Wallet source=BURNER_WALLET_KEY (enc:AES-256-GCM) pubkey=...` before declaring success;
revert from `/root/.env.full-backup-*` on mismatch. Never print master key; never toggle DRY_RUN.
