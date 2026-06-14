---
name: vega-volume-regime-strategy
description: Item (b) volume-regime strategy spread; pickRegimeStrategy in dlmm.js; flag default OFF; volatility guard; deterministic path wired
metadata:
  type: project
---

Item (b) — volume-regime LP strategy spread (Andromeda plan). Built LOCAL 2026-06-01.

**What:** `pickRegimeStrategy(volume_window, volatility, cfg)` PURE helper exported from `tools/dlmm.js`.
- HIGH volume (>= volumeRegimeHighThreshold, default 50000) → `spot` (tight fee capture)
- LOW volume → `bid_ask` (catch volatility)
- CRITICAL volatility guard (Andromeda risk): volatility > volumeRegimeMaxVolForSpot (default 3, strict `>`) → force `bid_ask` regardless of volume. Spot on volatile pool = instant OOR+IL.
- FAIL-SAFE: volume null/0/non-finite → return cfg.strategy (no silent flip; honors non-default too)
- High volume + UNKNOWN volatility → spot (vol-feed gating already enforced upstream in deployPosition throw)

**Injected:** deployPosition strategy resolution (dlmm.js ~528): `if (strategy) override-wins; else if (config.strategy.volumeRegimeEnabled) pickRegimeStrategy; else config.strategy.strategy`. Added `volume_window` param to deployPosition + deploy_position tool def (definitions.js).

**Deterministic path:** agents/vega.js wired — when volumeRegimeEnabled, leaves `strategy` undefined + passes `volume_window` so picker runs (deterministic path = no-explicit-strategy caller). When OFF keeps legacy constant.

**Config (config.js strategy section):** volumeRegimeEnabled (default FALSE), volumeRegimeHighThreshold (50000), volumeRegimeMaxVolForSpot (3).

**Money safety:** deploy shape only changes when flag ON. maxDeployAmount/maxPositions/DRY_RUN untouched. Override-wins preserved.

**Tests:** scripts/test-volume-regime.js (31 assertions PASS). test-money-exit-batch.js (30 PASS, no regression).

**VETO status:** safe to ship flag-OFF. LIVE activation VETO'd pending paper-soak (see report). Related: [[vega-pr3-deterministic-deploy]].
