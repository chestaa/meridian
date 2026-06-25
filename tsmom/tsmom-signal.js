// tsmom/tsmom-signal.js — mechanical Time-Series Momentum signal (TSMOM v1).
//
// FAITHFUL to Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", JFE.
// Their core, replicated result:
//   * SIGNAL: sign of the trailing ~12-month excess return. Positive past
//     return => go LONG; negative => go SHORT (or FLAT if shorts disallowed).
//   * SIZING: VOLATILITY SCALING. Position scaled to a constant target
//     annualized volatility: weight = targetVol / realizedVol. This is the
//     paper's defining mechanic — it equalizes risk across assets/time so a
//     calm asset gets MORE notional and a wild one LESS, holding portfolio
//     vol ~constant. WITHOUT this, TSMOM results don't replicate.
//   * REBALANCE: monthly (paper's base case). Configurable here.
//
// EVERYTHING is explicit + configurable so config-versions compare via the
// journal (lookback, rebalance freq, vol target, vol window, allowShort).
//
// Pure arithmetic over a daily close series. No I/O, no money, no LLM.

// Default params — the paper's classic spec adapted to a DAILY close series.
export const DEFAULT_PARAMS = {
  lookbackDays: 252, // ~12 months of trading days. The signal horizon.
  rebalanceDays: 21, // ~1 month. How often we re-evaluate sign + resize.
  volWindowDays: 60, // ex-ante realized-vol estimate window (paper uses ~exp-weighted; we use a trailing window, simpler + honest).
  targetAnnualVol: 0.40, // 40% annualized target. Paper targets ~40% per-instrument vol; crypto is high-vol so this keeps weights sane (often <1).
  allowShort: true, // paper goes short on negative momentum. Toggle for long/flat-only variant.
  maxLeverage: 2.0, // hard cap on |weight| so vol-scaling can't blow up when realizedVol→0.
  tradingDaysPerYear: 365, // crypto trades 365d/yr (no weekends). Used to annualize daily vol.
};

// daily simple returns from a close array. returns[i] = close[i]/close[i-1]-1
export function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
      r.push(cur / prev - 1);
    } else {
      r.push(null); // honest gap marker
    }
  }
  return r;
}

// Trailing realized ANNUALIZED volatility ending at index `endIdx` (inclusive)
// over `window` daily returns. Returns null if insufficient clean data.
export function realizedVol(returns, endIdx, window, tradingDaysPerYear) {
  const start = endIdx - window + 1;
  if (start < 0) return null;
  const slice = returns.slice(start, endIdx + 1).filter((x) => Number.isFinite(x));
  if (slice.length < Math.max(5, Math.floor(window * 0.6))) return null; // too gappy
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance =
    slice.reduce((a, b) => a + (b - m) ** 2, 0) / (slice.length - 1);
  const dailySd = Math.sqrt(variance);
  return dailySd * Math.sqrt(tradingDaysPerYear);
}

// Cumulative return over the lookback window ending at index `endIdx`.
// Uses close-to-close: close[endIdx]/close[endIdx-lookback] - 1.
export function lookbackReturn(closes, endIdx, lookbackDays) {
  const start = endIdx - lookbackDays;
  if (start < 0) return null;
  const a = closes[start];
  const b = closes[endIdx];
  if (!(a > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b / a - 1;
}

// Compute the TSMOM signal at a single rebalance index.
// Returns { idx, date, signal (-1|0|+1), lookbackRet, realizedVol, weight }
// weight = signal * min(maxLeverage, targetAnnualVol / realizedVol)
// null if data insufficient (HONEST — we don't fabricate a flat 0).
export function signalAt(closes, dates, idx, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const lr = lookbackReturn(closes, idx, p.lookbackDays);
  if (lr === null) return null;

  const returns = dailyReturns(closes);
  // returns[] is offset by 1 vs closes[] (returns[i] = closes[i+1]/closes[i]-1).
  // The return realized INTO close index `idx` lives at returns[idx-1].
  const rv = realizedVol(returns, idx - 1, p.volWindowDays, p.tradingDaysPerYear);
  if (rv === null || !(rv > 0)) return null;

  let sign = lr > 0 ? 1 : lr < 0 ? -1 : 0;
  if (sign < 0 && !p.allowShort) sign = 0; // long/flat-only variant

  const rawScale = p.targetAnnualVol / rv;
  const scale = Math.min(p.maxLeverage, rawScale);
  const weight = +(sign * scale).toFixed(6);

  return {
    idx,
    date: dates[idx],
    signal: sign,
    lookbackRet: +lr.toFixed(6),
    realizedVol: +rv.toFixed(6),
    weight,
  };
}

// Generate the full rebalance schedule of signals for a close series.
// Returns array of signal objects at each rebalance index where data permits.
// We start at the first index where the lookback is satisfiable, then step by
// rebalanceDays.
export function buildSignalSchedule(closes, dates, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const firstValid = p.lookbackDays + 1; // need lookback history + 1 for return calc
  const out = [];
  for (let idx = firstValid; idx < closes.length; idx += p.rebalanceDays) {
    const s = signalAt(closes, dates, idx, p);
    if (s) out.push(s);
  }
  return out;
}

export { };
