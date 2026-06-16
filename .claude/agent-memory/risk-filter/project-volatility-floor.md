---
name: project-volatility-floor
description: minVolatility FLOOR (not ceiling) added — low-vol slow-bleed; floor 3.0 not 3.5 by live anti-dormancy probe
metadata:
  type: project
---

Added `minVolatility` FLOOR gate in `getRawPoolScreeningRejectReason` (screening.js),
config key (config.js, base default 0=OFF, wired into reloadScreeningThresholds).
Reject reason: `volatility N below minVolatility M`. Commit on branch
feat/broad-discovery-server-client-migration.

**Why:** Lyra finding on 39 REAL trades INVERTED the prior whipsaw hypothesis. LOW-vol
pools are the bleeders, not high-vol whipsaw. Buckets: vol[0,2.5) EV −$0.41/trade (sum
−$4.06, worst), [2.5,3.5) −$0.21 (−$2.07), [3.5,4.5) +$0.34 (+$3.09, best), [4.5+)
+$0.20 (+$1.95). Win avg vol 3.99, Loss 3.34, SL 3.01 — low-vol slow-bleeds into the
stop without ever pumping to a realized win. NO CEILING (4.5+ stays EV+, zero evidence
for upper bound).

**How to apply:** Floor set to **3.0, NOT the 3.5 Lyra proposed.** Live anti-dormancy
probe (`scripts/probe-volatility-floor.js`, 1h timeframe, 1000-pool broad page from
total ~1068): a HARD 3.5 floor cut the FULL-gate deployable set to **1 pool/page**
(near-dormancy, 0-deploy-day risk); 3.0 → 2 pools; against fee/TVL+mcap only, 31 pass,
of which vol≥3.5=5, vol≥3.0=9. Universe is BIMODAL — mass at vol~0 (whole-set median 0,
p90 1.23), thin tail above 3.5. 3.0 kills the catastrophic [0,2.5) bucket (8 of 12
current survivors) while keeping the funnel alive. Raw-gate count is a FLOOR; runtime
adds more via vol-rescue + native-detail enrich passes. VETOED a blind 3.5 hard floor
as over-tighten (same dormancy class as the blind-0.20-fee-floor I refused before —
see [[project-feetvl-age-adopt]]).

Fail-closed (anti-pattern #2, [[feedback-fail-closed-missing-data]]): null/0/non-finite
vol already rejects upstream (volatility_unknown / unusable); floor adds only the
genuine-usable-but-too-low case. Base default 0 = OFF so all existing tests + paper
unaffected; Draco sets user-config `minVolatility` (3.0) + live overlay, restart-3.

Tests: `scripts/test-volatility-floor.js` (18 assertions). Regression clean:
gate-batch 22, broad-discovery 38, feetvl-tvlmc 19, native-detail 43, quote-organic 38.
Lyra EV projection: vol≥3.5 + SL-fix → +$0.31/trade (from −$0.028); vol-floor single-fix
→ +$0.063/trade.
