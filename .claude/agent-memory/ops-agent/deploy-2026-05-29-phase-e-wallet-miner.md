---
name: deploy-2026-05-29-phase-e-wallet-miner
description: Phase E smart wallet miner deployed live; populated smart-wallets.json with 30 real on-chain LP wallets via getProgramAccounts
metadata:
  type: project
---

Phase E: `scripts/mine-smart-wallets.js` (Sirius) committed `ba21b66`, pushed main, VPS auto-pulled. Live populate wrote 30 real LP wallets to `/opt/meridian/smart-wallets.json` (was empty `{"wallets":[]}`, 20 bytes).

**Why:** mine real verified alpha LP wallets via reverse lookup instead of fabricating — feeds smart-wallets tracker for screener `check_smart_wallets_on_pool`.

**How to apply:** getProgramAccounts(DLMM_PROGRAM, memcmp pool@offset8, dataSlice owner@offset40) IS supported on VPS RPC (Helius) — zero errors, dry run found 288 distinct wallets across 7 pools. Heavy call but no timeout. Backup at `smart-wallets.json.bak.20260529-100359`. Re-run is safe (dedupes vs existing). Records carry `_provenance` extra fields that addSmartWallet ignores.
