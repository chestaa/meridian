// tsmom/tsmom-backtest.js — WALK-FORWARD out-of-sample TSMOM backtest (v1).
//
// ANTI-OVERFITTING DISCIPLINE (the named failure mode):
//   TSMOM has NO parameters fit to the data in-sample — the spec is mechanical
//   (sign of trailing 12m return, vol-scaled). But "no fitting" is NOT the same
//   as "out-of-sample". The real overfitting risk for momentum is PEEKING: using
//   information from time > t to decide the trade at t. We forbid it structurally:
//
//     * At each rebalance index t, the signal is computed ONLY from closes[..t]
//       (lookback return + realized vol BOTH end at/<=t). See tsmom-signal.js.
//     * The OUTCOME of that trade is the realized return of the asset over the
//       NEXT rebalance window [t, t+rebalanceDays], which was UNKNOWN at t.
//       That forward return is genuinely out-of-sample relative to the decision.
//     * No parameter is re-tuned to maximize backtest return. The params are the
//       paper's fixed spec, declared up front (DEFAULT_PARAMS). If we sweep
//       params it is via SEPARATE config_versions logged to the journal, each
//       judged on its OWN forward periods — never cherry-picking the best curve.
//
//   This makes every logged period a true held-out observation. We then judge the
//   SET of period returns with journal-stats (expectancy + t-stat + noise flag).
//
// Per-period metric = the strategy's return over the holding window:
//     period_return = weight_at_t * asset_return_over_window
//   (weight already carries signal sign + vol scaling; a flat signal => 0.)
//
// Pure arithmetic. No money path. No LLM.

import { buildSignalSchedule, DEFAULT_PARAMS, lookbackReturn } from "./tsmom-signal.js";

// Forward simple return of the asset from close index a to close index b.
function forwardReturn(closes, a, b) {
  const pa = closes[a];
  const pb = closes[b];
  if (!(pa > 0) || !Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return pb / pa - 1;
}

// Regime classification window (trading days) and band, exported for reuse/tests.
export const REGIME_WINDOW_DAYS = 90; // ~3 months trailing trend
export const REGIME_BAND = 0.10; // +/-10% over 90d => trending; inside => chop/whipsaw

// Ex-ante regime label for a rebalance at index `idx`, using ONLY a trailing
// window ending at idx (close[idx-W..idx]). NEVER peeks at the forward window —
// this is a legitimate "what kind of market were we in WHEN we placed the trade"
// tag, the question Bro asked. We deliberately do NOT use the TSMOM signal's own
// lookback as the regime label (that would just re-encode the signal); a SHORTER
// 90d trend is the macro context the 252d signal is being judged inside.
//   UPTREND  : trailing 90d return >= +BAND
//   DOWNTREND: trailing 90d return <= -BAND
//   CHOP     : within +/-BAND (whipsaw / range — momentum's classic weak spot)
//   UNKNOWN  : insufficient trailing data (skip in regime split, never fabricate)
export function regimeAt(closes, idx, windowDays = REGIME_WINDOW_DAYS, band = REGIME_BAND) {
  const trail = lookbackReturn(closes, idx, windowDays);
  if (trail === null) return { regime: "UNKNOWN", trail: null };
  let regime;
  if (trail >= band) regime = "UPTREND";
  else if (trail <= -band) regime = "DOWNTREND";
  else regime = "CHOP";
  return { regime, trail: +trail.toFixed(6) };
}

// Run the walk-forward backtest for one asset.
// Returns { asset, params, periods:[...], equityCurve:[...], metrics:{...} }
export function backtestAsset(history, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const rows = history.rows || [];
  const closes = rows.map((r) => r.close);
  const dates = rows.map((r) => r.date);

  const schedule = buildSignalSchedule(closes, dates, p);
  const periods = [];

  for (const s of schedule) {
    const endIdx = Math.min(s.idx + p.rebalanceDays, closes.length - 1);
    if (endIdx <= s.idx) continue; // no forward window (end of data)
    const assetRet = forwardReturn(closes, s.idx, endIdx);
    if (assetRet === null) continue; // honest gap — skip, don't fabricate

    // Strategy return over the window = position weight * asset move.
    const stratRet = s.weight * assetRet;

    // Ex-ante regime tag (trailing-only, no peek at the forward window).
    const reg = regimeAt(closes, s.idx);

    periods.push({
      entry_date: s.date,
      exit_date: dates[endIdx],
      signal: s.signal, // -1/0/+1 — the DECISION
      lookbackRet: s.lookbackRet, // why we took it (was UNKNOWN-free: data<=t)
      weight: s.weight, // vol-scaled position
      asset_return: +assetRet.toFixed(6), // forward move (out-of-sample)
      period_return: +stratRet.toFixed(6), // what the strategy earned
      hold_days: endIdx - s.idx,
      regime: reg.regime, // UPTREND | DOWNTREND | CHOP | UNKNOWN (ex-ante)
      regime_trail_ret: reg.trail,
    });
  }

  const metrics = computeBacktestMetrics(periods, p);
  const equityCurve = buildEquityCurve(periods);
  const regimeSplit = computeRegimeSplit(periods);

  return {
    asset: history.asset,
    data_source: history.source,
    data_first: history.first_date,
    data_last: history.last_date,
    data_rows: history.row_count,
    data_warnings: history.warnings || [],
    params: p,
    periods,
    equityCurve,
    metrics,
    regimeSplit,
  };
}

// Split per-period returns by ex-ante regime and summarize each bucket.
// Pure arithmetic — verdict-grade stats are applied downstream by journal-stats
// so the n>=10 + |t|>=2 gate is identical to everything else.
export function computeRegimeSplit(periods) {
  const buckets = { UPTREND: [], DOWNTREND: [], CHOP: [], UNKNOWN: [] };
  for (const x of periods) (buckets[x.regime] || buckets.UNKNOWN).push(x);
  const out = {};
  for (const [regime, ps] of Object.entries(buckets)) {
    const rets = ps.map((x) => x.period_return).filter((x) => Number.isFinite(x));
    const n = rets.length;
    if (!n) {
      out[regime] = { n: 0 };
      continue;
    }
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const wins = rets.filter((x) => x > 0).length;
    out[regime] = {
      n,
      mean_period_return: +mean.toFixed(6),
      sd_period_return: +sd.toFixed(6),
      win_rate_pct: +((wins / n) * 100).toFixed(2),
      long: ps.filter((x) => x.signal > 0).length,
      short: ps.filter((x) => x.signal < 0).length,
      flat: ps.filter((x) => x.signal === 0).length,
    };
  }
  return out;
}

// Per-period return based metrics. Sharpe + maxDD honest.
export function computeBacktestMetrics(periods, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const rets = periods.map((x) => x.period_return).filter((x) => Number.isFinite(x));
  const n = rets.length;
  if (!n) {
    return {
      n_periods: 0,
      note: "no measurable periods — data too short for this lookback/rebalance",
    };
  }

  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd =
    n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;

  // Annualization factor: periods per year = tradingDays / rebalanceDays.
  const periodsPerYear = p.tradingDaysPerYear / p.rebalanceDays;
  // Sharpe (excess over 0; crypto rf~0 assumption stated honestly).
  const sharpePerPeriod = sd > 0 ? mean / sd : null;
  const sharpeAnnual =
    sharpePerPeriod === null ? null : +(sharpePerPeriod * Math.sqrt(periodsPerYear)).toFixed(4);

  // Win/loss, expectancy mirror journal-stats so verdicts line up.
  const wins = rets.filter((x) => x > 0);
  const losses = rets.filter((x) => x < 0);
  const winRate = wins.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;

  // Compounded total return + max drawdown on the equity curve.
  const eq = buildEquityCurve(periods);
  let peak = -Infinity;
  let maxDD = 0;
  for (const pt of eq) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? (pt.equity - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const totalReturn = eq.length ? eq[eq.length - 1].equity - 1 : 0;

  return {
    n_periods: n,
    periods_per_year: +periodsPerYear.toFixed(2),
    mean_period_return: +mean.toFixed(6),
    sd_period_return: +sd.toFixed(6),
    sharpe_annual: sharpeAnnual,
    win_rate_pct: +(winRate * 100).toFixed(2),
    avg_win: +avgWin.toFixed(6),
    avg_loss: +avgLoss.toFixed(6),
    payoff: payoff == null ? null : +payoff.toFixed(4),
    total_return_pct: +(totalReturn * 100).toFixed(2),
    max_drawdown_pct: +(maxDD * 100).toFixed(2),
    long_periods: periods.filter((x) => x.signal > 0).length,
    short_periods: periods.filter((x) => x.signal < 0).length,
    flat_periods: periods.filter((x) => x.signal === 0).length,
  };
}

// Compounded equity curve, starting at 1.0.
export function buildEquityCurve(periods) {
  let eq = 1.0;
  const out = [];
  for (const pt of periods) {
    eq = eq * (1 + pt.period_return);
    out.push({ date: pt.exit_date, equity: +eq.toFixed(6) });
  }
  return out;
}
