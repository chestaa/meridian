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
| `ohlcv-ingest.js` | Daily history for BTC/ETH/SOL. **Default source = Yahoo Finance deep daily (multi-year, true OHLC)**; `TSMOM_SOURCE=coingecko` falls back to the 1yr close-only source |
| `tsmom-signal.js` | Mechanical signal: lookback sign + vol-scaled weight (params configurable) |
| `tsmom-backtest.js` | Walk-forward / out-of-sample runner; Sharpe, drawdown, win-rate, expectancy + **ex-ante regime split** (UPTREND/DOWNTREND/CHOP) |
| `tsmom-run.js` | Orchestrate: backtest → honest stats verdict (overall + per-regime) → log to journal (experiment_id=TSMOM) |
| `data/` | Cached daily history (snapshot, reproducible via ingest) |
| `../scripts/test-tsmom.js` | 38 deterministic unit tests (no network) |

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

## DATA SOURCES (read this before trusting any number)

### v2 default: Yahoo Finance deep daily (multi-year, true OHLC)

Pulled via `period1`/`period2` Unix-second windows (`range=max` silently
downsamples to weekly — only period bounds give true 1-day bars). Verified
depth (2026-06-25 ingest):

| Asset | Rows | Span | Years |
| --- | --- | --- | --- |
| BTC | 4300 | 2014-09-17 → 2026-06-25 | 11.8 |
| ETH | 3151 | 2017-11-09 → 2026-06-25 | 8.6 |
| SOL | 2268 | 2020-04-10 → 2026-06-25 | 6.2 |

Zero null closes. Covers 2017 bull, 2018 bear, 2019 chop, 2020 COVID crash,
2021 bull, 2022 bear, 2023-25 cycle — **multi-regime**, which is the whole point.

**Why Yahoo and not an exchange klines API:** every centralized-exchange klines
endpoint (Binance, Binance.US, Coinbase, Kraken, Bybit, OKX) is **cert-injection
blocked** from this environment — `ERR_TLS_CERT_ALTNAME_INVALID`, a TLS-MITM on
exchange domains (the geo/ISP block a teammate hit). CoinGecko `days=max` now
needs a paid key (error 10012); CryptoCompare needs a key; Coinpaprika free caps
at 1yr. Yahoo is the one free deep source reachable + uncensored here. If Yahoo
is ever blocked too, the ingester reports the gap — it never fabricates prices.

### v1 fallback: CoinGecko free (`TSMOM_SOURCE=coingecko`)

CLOSE-only, ~365d depth cap → ~6 monthly rebalances/asset (THIN). Kept as a
reachable fallback; not the validation source. A missing day is a missing day.

## Regime split (the B1 question)

Each held-out period is tagged with an **ex-ante** regime — the sign+magnitude of
the trailing **90-day** return *at entry* (UPTREND ≥ +10%, DOWNTREND ≤ −10%, else
CHOP). This is trailing-only (proven by a no-peek test: the label is invariant to
future closes) and deliberately SHORTER than the 252d signal lookback, so it labels
the macro context the signal trades *inside*. The per-regime verdict uses the same
`computeStats` n≥10 / |t|≥2 gate. This is how we tell a real cross-regime edge from
a one-off "short the bear" artifact.

## Anti-overfitting discipline

- Signal at time `t` uses ONLY data `≤ t` (lookback + vol both end at/≤ t).
- Outcome = realized return of the NEXT window `[t, t+rebalance]`, unknown at t
  → genuinely out-of-sample relative to the decision.
- NO parameter is tuned to maximize backtest return. Param sweeps are SEPARATE
  `config_version`s judged on their own forward periods — never cherry-picked.
- Verdict via `journal-stats.computeStats`: expectancy + t-stat + the n≥10 / |t|≥2
  noise gate. A green equity curve is NOT an edge claim.

## Honest read — v2-deephistory (multi-year, multi-regime)

Re-run over the full Yahoo daily history (per-asset n now 96–193 held-out,
non-overlapping monthly periods spanning ~6–12 yr). The v1 single-bear-leg
artifact is gone; the picture is now mixed and honest:

| Asset | n | overall verdict | t | UPTREND | DOWNTREND | CHOP |
| --- | --- | --- | --- | --- | --- | --- |
| BTC | 193 | **EDGE_POSITIVE** | 4.14 | EDGE+ (t 3.36) | NOISE (t 1.17) | EDGE+ (t 2.17) |
| ETH | 138 | NOISE | 0.14 | NOISE | NOISE | NOISE (neg) |
| SOL | 96 | NOISE | 1.40 | NOISE (t 1.88) | NOISE | NOISE |

Pooled by regime (all assets — correlated, indicative only): UPTREND n=197 t=4.11
EDGE_POSITIVE; DOWNTREND n=146 t=0.31 NOISE; CHOP n=84 t=1.22 NOISE.

**Key inversions vs the v1 hypothesis:**

1. The edge is **NOT a bear-short artifact.** DOWNTREND is the *weakest* regime
   (NOISE everywhere). The signal that carries BTC is the LONG side in UPTREND +
   CHOP. With real regime diversity, "short the bear" does not survive.
2. **Edge is asset-specific, not universal.** Only BTC clears the bar. ETH is flat
   over 8.6yr (and negative in chop — slow whipsaw bleed). SOL leans positive but
   stays NOISE at n=96.
3. The pooled EDGE_POSITIVE (t=3.58) is still flagged as a correlation caveat —
   BTC dominates it. Per-asset is primary.

**Verdict: B1 is PARTIALLY VALIDATED — BTC only, and contingent on uptrend/chop,
not the bear short.** Mechanics are sound and now tested against real regimes.
This is NOT a green light to deploy a 3-asset TSMOM book: 2 of 3 majors show no
edge. A BTC-only, long-biased variant is the honest hypothesis to carry forward —
logged as its own `config_version`, paper-soaked before any capital. Still proxy /
`is_realized=false`; nothing here is realized money.
