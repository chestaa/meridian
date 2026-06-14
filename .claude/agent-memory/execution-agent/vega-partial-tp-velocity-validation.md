---
name: vega-partial-tp-velocity-validation
description: Both money VETOs (partial TP, velocity exit) cleared via real validation 2026-05-30; how each path was proven
metadata:
  type: project
---

Two money VETOs lifted on 2026-05-30 after real DRY_RUN validation (Bro pushed to enable; addressed concerns, not blind override).

**VETO LIFTED: partialTpEnabled** — `dlmm.partialClosePosition` uses `removeLiquidity({bps, shouldClaimAndClose:false})`. Proven via `scripts/validate-partial-tp.js` (15 assertions): bps:5000 → 50% removed, shouldClaimAndClose:false → account survives + remainder still queryable, idempotency via `markPartialTpDone` (state.js) blocks double-fire. Drove the REAL non-dry-run source through a faithful mock SDK pool injected via `__setForTests`.

**VETO LIFTED: velocityExitEnabled** — root cause: live `getMyPositions` position object NEVER carried `price_change_1h_pct`/`net_buyers_1h` (only paper-trades had them via token.js stats1h), so velocity exit could never fire live. FIX: added `fetchVelocityStatsForMint` in dlmm.js (hits same Jupiter `datapi.jup.ag/v1/assets/search` stats1h source paper uses, 60s TTL cache, parallel-by-mint), attaches both fields to each live position. Proven via `scripts/validate-velocity-fields.js` (11 assertions, mocked fetch): fields land on live object, drive VELOCITY_EXIT, null when stats absent → safe no-op.

**Why:** brand-new primitive + unconfirmed live field were genuine money-risk gaps. Validation closed both without touching a live wallet (DRY_RUN, mocked SDK/fetch, ephemeral throwaway burner key for wallet resolution).

**How to apply:** if either flag misbehaves live, these scripts are the regression harness. The velocity wiring depends on Jupiter stats1h availability — if Jupiter is down, fields go null and velocity exit silently disables (by design, not a bug). Builds on [[executor-test-seam-pattern]] — same `__setForTests` immutable-binding workaround, now also in dlmm.js scoped to `partialClosePosition` deps only.
