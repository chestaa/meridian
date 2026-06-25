# TSMOM Paper-Test Harness (B1) — Lyra

Disciplined paper/backtest harness for **B1: systematic time-series momentum
(TSMOM)** on crypto majors. Validate on history + paper BEFORE any capital.

**PAPER/BACKTEST ONLY. No money path, no live execution, no real orders.**

## Why TSMOM / B1

The one candidate with *replicated academic evidence* — Moskowitz, Ooi & Pedersen
(2012, JFE): the sign of the trailing ~12-month return positively predicts the
next month across 58 instruments / 25 years. We adopt the paper's defining
mechanics faithfully:

- **Signal**: sign of trailing ~12-month (252d) return → long / flat / short.
- **Sizing**: volatility scaling — `weight = targetVol / realizedVol` (capped).
  This is the mechanic that makes TSMOM replicate; without it results don't hold.
- **Rebalance**: monthly (21d) base case. All params explicit + configurable.

## Files

| File | Role |
|------|------|
| `ohlcv-ingest.js` | Daily CLOSE history for BTC/ETH/SOL from CoinGecko free API → local JSON cache |
| `tsmom-signal.js` | Mechanical signal: lookback sign + vol-scaled weight (params configurable) |
| `tsmom-backtest.js` | Walk-forward / out-of-sample runner; Sharpe, drawdown, win-rate, expectancy |
| `tsmom-run.js` | Orchestrate: backtest → honest stats verdict → log to journal (experiment_id=TSMOM) |
| `data/` | Cached daily history (snapshot, reproducible via ingest) |
| `../scripts/test-tsmom.js` | 24 deterministic unit tests (no network) |

## Usage

```bash
node tsmom/ohlcv-ingest.js            # fetch BTC/ETH/SOL daily history
node tsmom/tsmom-run.js               # walk-forward backtest + journal log
node journal-cli.js report            # see TSMOM alongside other experiments
node scripts/test-tsmom.js            # run unit tests

# config variants (each a distinct journal config_version):
TSMOM_ALLOWSHORT=0 node tsmom/tsmom-run.js          # long/flat-only
TSMOM_LOOKBACK=180 TSMOM_REBALANCE=10 node tsmom/tsmom-run.js
TSMOM_NO_LOG=1 node tsmom/tsmom-run.js              # dry compute, no journal write
```

## HONEST DATA LIMITS (read this before trusting any number)

CoinGecko **free** tier:

1. **CLOSE only, not true OHLC.** The free `market_chart` endpoint returns
   `[ts, price]` spot points. open/high/low are stored as `null`. TSMOM is
   close-to-close so this is sufficient — but we do NOT pretend we have OHLC.
2. **~365 days of daily depth.** The free key truncates history to ~1 year.
   With a 252-day lookback this leaves only ~113 post-warmup days = **~6
   monthly rebalances per asset.** This is THIN for a 12-month strategy.
3. **Final row may be a partial (live snapshot) day** — flagged in warnings.
4. **Rate-limited** (~5-15 calls/min). We space fetches politely.

These limits are stamped into every saved data file (`warnings[]`) and surfaced
in the backtest report. A missing day is a missing day — we never fabricate.

## Anti-overfitting discipline

- Signal at time `t` uses ONLY data `≤ t` (lookback + vol both end at/≤ t).
- Outcome = realized return of the NEXT window `[t, t+rebalance]`, unknown at t
  → genuinely out-of-sample relative to the decision.
- NO parameter is tuned to maximize backtest return. Param sweeps are SEPARATE
  `config_version`s judged on their own forward periods — never cherry-picked.
- Verdict via `journal-stats.computeStats`: expectancy + t-stat + the n≥10 / |t|≥2
  noise gate. A green equity curve is NOT an edge claim.

## Honest read (v1, window 2025-06-26 → 2026-06-25)

The window is a **single monotonic bear regime** (BTC −43%, ETH −32%, SOL −52%
over the year). TSMOM correctly read negative trailing momentum and went short
every period; shorting a falling market produced positive sim returns. But:

- **n=6 periods/asset → THIN.** The journal verdict is THIN/UNPROVEN, not edge.
- **Zero regime diversity.** No uptrend, no whipsaw, no regime transition in the
  data we can get for free. The "edge" is essentially one bet (short crypto in a
  bear year) sampled a handful of overlapping-leg times; one period (May→Jun)
  drives most of the return.
- The POOLED n=18 EDGE_POSITIVE read is a **false-confidence trap** — 3 assets ×
  6 periods are highly correlated (same macro leg), NOT 18 independent samples.
  Per-asset n=3 in the journal correctly returns THIN despite t=38.

**Verdict: B1's mechanics are sound and now measurable, but it is NOT validated.**
Free-API history is too short and too regime-homogeneous to distinguish edge from
"short the 2025-26 bear." Next step to honestly test it: a longer daily history
(multi-year, multiple regimes) — which requires a paid/alternate data source.
