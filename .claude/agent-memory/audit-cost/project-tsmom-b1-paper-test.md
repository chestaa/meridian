---
name: project-tsmom-b1-paper-test
description: B1 (TSMOM crypto majors) paper-test harness built + honest verdict — sound mechanics, NOT validated on free-API data
metadata:
  type: project
---

B1 = systematic time-series momentum (TSMOM) on crypto majors — Bro's primary
post-DLMM direction (the one candidate with replicated academic evidence:
Moskowitz/Ooi/Pedersen 2012, 12-month-return sign signal). Paper-test harness
built on branch `feat/tsmom-paper-test-v1` (pushed to origin, NOT merged).

**Why:** validate on history + paper BEFORE any capital. Measurable + evidence-
backed from day one — the bar Bro set. Wired into the [[measurement-journal-system]]
(experiment_id=TSMOM, unit=proxy, is_realized=false — simulated, never money).

**Files:** `tsmom/ohlcv-ingest.js` (CoinGecko free), `tsmom/tsmom-signal.js`
(lookback sign + vol-scaled sizing), `tsmom/tsmom-backtest.js` (walk-forward,
no peeking), `tsmom/tsmom-run.js` (orchestrate + journal log), `tsmom/README.md`,
`scripts/test-tsmom.js` (24 tests pass).

**HONEST VERDICT (v1, NOT validated):**
- CoinGecko free = CLOSE-only (no true OHLC) + ~365d depth cap. With 252d
  lookback → only ~6 monthly rebalances/asset. THIN.
- Window 2025-06-26→2026-06-25 is a SINGLE monotonic bear (BTC −43%, ETH −32%,
  SOL −52%). TSMOM correctly went short every period; "edge" is just shorting a
  falling market once, sampled ~6x. Zero regime diversity (no uptrend/whipsaw).
- Per-asset journal verdict = THIN (n=3 entries, t=38 but n<10 gate fires).
  POOLED n=18 EDGE_POSITIVE is a FALSE-CONFIDENCE TRAP — 3 assets × 6 periods
  are correlated (same macro leg), not 18 independent samples. Do NOT cite it.
- B1 mechanics sound + now measurable, but to honestly test edge needs multi-year
  multi-regime daily history = paid/alternate data source.

**How to apply:** if Bro wants to advance B1, the blocker is DATA (longer history),
not the harness. Never report the pooled t=2.15 as validation. Re-run after any
new data lands; each param variant = a new config_version, judged on its own
forward periods (no cherry-picking the best curve).
