---
name: deploy-2026-05-31-encrypted-env
description: commit 45978f5; encrypted .env support (AES-256-GCM, enc: prefix auto-detect) additive non-breaking; Vega VETO live activation; tests 12/12; plaintext wallet still loads, Mode LIVE
metadata:
  type: project
---

intel #3 encrypted .env support deployed code-only (flag-inert), commit 45978f5, pushed main, VPS auto-pulled (try 6, ~60s).

Files: lib/env-crypto.js, wallet-loader.js (modified), scripts/encrypt-env.js, scripts/test-env-crypto.js. 275 insertions.

Mechanism: AES-256-GCM, `enc:` prefix auto-detect. resolveValue() passes plaintext through unchanged → fully non-breaking. Decryption needs ENV_ENCRYPTION_KEY passphrase.

**Why:** add at-rest encryption option for BURNER_WALLET_KEY without forcing migration.

**How to apply:** Activation is DEFERRED — Vega VETO on encrypting the live wallet key (lose master key = lose wallet). To activate someday: encrypt key with scripts/encrypt-env.js, set ENV_ENCRYPTION_KEY on VPS out-of-band. DO NOT set ENV_ENCRYPTION_KEY on VPS now. Plaintext BURNER_WALLET_KEY remains the live path.

Verify results 2026-05-31:
- Test 12/12 PASS on VPS (roundtrip, auth-tag tamper, no-key-leak, plaintext passthrough)
- /opt/meridian/.env: 0 lines `^BURNER_WALLET_KEY=enc:` → plaintext, correct (not encrypted)
- Post-restart: Wallet source=BURNER_WALLET_KEY pubkey=DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu, Mode LIVE, no decrypt error, cron computed deploy 0.2 SOL (wallet 0.884 SOL)
- meridian active, snapshot pushed to status branch

See [[deploy-2026-05-30-rebalance-dammv2]] for the prior flag-OFF Vega-gated pattern.
