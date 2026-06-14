---
name: vega-env-crypto-aes-gcm
description: AES-256-GCM at-rest env encryption (lib/env-crypto.js) + wallet-loader enc: prefix decrypt; non-breaking plaintext passthrough; master-key tradeoff
metadata:
  type: project
---

Built 2026-05-31 (intel BUILD #3, post pk-leak). New `lib/env-crypto.js`: AES-256-GCM, scrypt KDF, per-value random salt+iv, `enc:` prefix. `wallet-loader.js` auto-detects `enc:` on BURNER_WALLET_KEY/WALLET_PRIVATE_KEY and decrypts with ENV_ENCRYPTION_KEY before bs58. `scripts/encrypt-env.js` = CLI to produce enc: blobs. Test `scripts/test-env-crypto.js` = 12 assertions green.

**Why:** community wallet drained via leaked plaintext pk. Our .env is 600 root-only but plaintext at rest. Encryption = defense-in-depth.

**How to apply:**
- Plaintext keys STILL WORK (no enc: prefix = passthrough, no ENV_ENCRYPTION_KEY needed). Opt-in, non-breaking.
- decrypt fail (wrong key/tamper) → HARD throw, never proceed with corrupt key. GCM auth tag enforced.
- NEVER log decrypted key (test 11/12 guard this).
- Pre-existing `envcrypt.js` (XOR cipher, `# encrypted` line-marker) is SEPARATE and left untouched — weaker, used for non-wallet env loading via loadEnv(). Do not confuse the two. New AES path is wallet-key-specific.

**Master-key tradeoff (honest):** ENV_ENCRYPTION_KEY is the master. If it lives in same .env on same VPS → marginal gain (attacker with disk access gets both). Real gain needs out-of-band key: systemd LoadCredentialEncrypted / passphrase prompt / external secret store. Documented; activation is Bro's call.

**VEGA VETO on live activation:** do NOT set BURNER_WALLET_KEY=enc: on the live VPS (DRY_RUN=false, /opt/meridian) until: (1) ENV_ENCRYPTION_KEY stored OUT of the same .env, (2) encrypt→decrypt validated against the REAL burner key in a dry-run boot, (3) Bro confirms recovery path (lose master key = lose access). Plaintext path stays default. See [[vega-realized-sol-accounting]] for the additive-change pattern.

VPS state at build: /opt/meridian, HEAD 6424f79, .env 600, BURNER plaintext, no ENV_ENCRYPTION_KEY, DRY_RUN=false. New files not yet deployed (git push later via Draco).

**PREP-READY validation 2026-06-11 (Vega):** mechanism confirmed 100% ready, NO code change (no commit). 12/12 unit (scripts/test-env-crypto.js) + 9/9 end-to-end loader proof. E2E used an EPHEMERAL Keypair.generate() dummy (never on-chain): encrypt→getSigningWallet() decrypt→bs58→pubkey MATCH; wrong master→fail-closed throw (no secret leak); missing master+enc:→fail-closed throw; plaintext burner→passthrough match. Init log emits pubkey + "enc:AES-256-GCM" source tag only, NEVER the secret. Recommended master-key inject mechanism for VPS: systemd drop-in EnvironmentFile=/etc/meridian/env-key (chmod 600 root:root, OUTSIDE repo, survives restart, not git-tracked). Activation = Bro's hands (generate+store master out-of-band, encrypt real burner, paste enc: blob, restart, confirm log). VEGA STILL VETOES live encrypt of real burner until Bro provides master out-of-band + offline plaintext recovery copy exists.
