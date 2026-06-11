---
name: project-gate-hardening-batch
description: Gate hardening batch (2026-05-30) — rug gates added, vol=0 rescue, dev_sold_all demoted, smart-money coupling removed
metadata:
  type: project
---

Gate hardening batch shipped 2026-05-30 to `tools/screening.js` + `config.js` + `user-config.json`.

**What changed:**
- **Item 1 (rug gates, BASE/always-on, fail-closed):** `requireMintRenounced`, `requireFreezeRenounced`, `rejectRugpullFlag` (all default true). Reject reasons: `mint_authority_not_renounced`, `freeze_authority_not_renounced`, `liquidity_removal_rugpull`. Pure fn `rugGateRejectReason(pool, s)`. Reads `p.audit.mint_disabled`/`freeze_disabled` (Jupiter) + `p.is_rugpull` (OKX `isLiquidityRemoval`). Missing data = reject (anti-pattern #2).
- **Item 3 (vol=0 rescue):** `refetchVolatilityForUnusable()` re-fetches vol≤0 pools at 30m before the volatility gate rejects them; only reject if 30m ALSO ≤0. Reason: stale 5m feed, not dead pool (cost the RICH-SOL win per Lyra).
- **Item 4 (dev_sold_all demoted):** `devSoldAllRequiresHighConcentration` (default true) → compound: reject only if `dev_sold_all && top10 > maxTop10Pct`. Pure fn `devSoldAllShouldReject(pool, s)`. Reason: hard-reject false-positive blocked SQUIRE +8%.
- **Item 5 (smart-money coupling REMOVED):** the `requireSmartWalletOrHighOrganic` live gate was a disguised organic floor (30-wallet smart list rarely overlaps trending pools). Dropped from `user-config.json` liveOverrides; `minOrganic` set to 72 (between base 60 and old disguised 80). Smart-money stays a `scoreCandidate` bonus only.

**Why:** Rug protection is universal → made base gates, not live-only overlay. Loosen-with-evidence on dev_sold_all/smart-money (named false-positives). Tighten on mint/freeze/rugpull (universal catastrophe protection).

**How to apply:** When auditing future threshold changes, these gates are the current baseline. `requireDevNotSoldAll` and `requireSmartWalletOrHighOrganic` overlay keys are SUPERSEDED — do not re-add them; dev_sold_all is now the Item 4 compound base gate. Tests: `scripts/test-gate-batch.js` (22 assertions). See [[feedback-fail-closed-missing-data]].
