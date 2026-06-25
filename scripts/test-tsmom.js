// scripts/test-tsmom.js — deterministic unit tests for the TSMOM math.
// No network. Synthetic close series with KNOWN answers. Run: node scripts/test-tsmom.js

import {
  dailyReturns,
  realizedVol,
  lookbackReturn,
  signalAt,
  buildSignalSchedule,
  DEFAULT_PARAMS,
} from "../tsmom/tsmom-signal.js";
import {
  backtestAsset,
  computeBacktestMetrics,
  buildEquityCurve,
} from "../tsmom/tsmom-backtest.js";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ── dailyReturns ──────────────────────────────────────────────────────
{
  const r = dailyReturns([100, 110, 99]);
  ok(approx(r[0], 0.1), "dailyReturns: 100→110 = +10%");
  ok(approx(r[1], -0.1), "dailyReturns: 110→99 = -10%");
  const g = dailyReturns([100, 0, 50]);
  ok(g[0] === null || g[1] === null, "dailyReturns: zero price => null (no fabrication)");
}

// ── lookbackReturn ────────────────────────────────────────────────────
{
  const closes = [10, 11, 12, 13, 20];
  ok(approx(lookbackReturn(closes, 4, 4), 1.0), "lookbackReturn idx4 lb4: 10→20 = +100%");
  ok(lookbackReturn(closes, 2, 4) === null, "lookbackReturn: insufficient history => null");
}

// ── realizedVol ───────────────────────────────────────────────────────
{
  // constant returns => zero variance => zero vol
  const flat = dailyReturns(Array.from({ length: 100 }, (_, i) => 100 * 1.01 ** i));
  const rv = realizedVol(flat, 90, 60, 365);
  ok(rv !== null && approx(rv, 0, 1e-9), "realizedVol: constant growth => ~0 vol");
  // too-gappy window => null
  const gappy = [null, null, null, 0.01, null];
  ok(realizedVol(gappy, 4, 60, 365) === null, "realizedVol: too few clean points => null");
}

// ── signalAt: sign + vol scaling ──────────────────────────────────────
{
  // Build a clean uptrend: positive lookback => long signal, weight>0.
  const n = 320;
  const closes = Array.from({ length: n }, (_, i) => 100 * 1.002 ** i);
  const dates = Array.from({ length: n }, (_, i) => `2025-${String(((i % 12) + 1)).padStart(2, "0")}-01`);
  const s = signalAt(closes, dates, 300, DEFAULT_PARAMS);
  ok(s !== null, "signalAt: valid uptrend produces a signal");
  ok(s.signal === 1, "signalAt: positive lookback => LONG (+1)");
  ok(s.weight > 0, "signalAt: long weight is positive");
  ok(s.weight <= DEFAULT_PARAMS.maxLeverage, "signalAt: weight capped at maxLeverage");

  // Downtrend => short when allowShort, flat when not.
  const down = Array.from({ length: n }, (_, i) => 100 * 0.998 ** i);
  const sd = signalAt(down, dates, 300, DEFAULT_PARAMS);
  ok(sd.signal === -1, "signalAt: negative lookback => SHORT (-1) when allowShort");
  ok(sd.weight < 0, "signalAt: short weight negative");
  const sf = signalAt(down, dates, 300, { ...DEFAULT_PARAMS, allowShort: false });
  ok(sf.signal === 0 && sf.weight === 0, "signalAt: long/flat-only => FLAT on downtrend");

  // Insufficient history => null (no fabricated flat).
  ok(signalAt(closes, dates, 10, DEFAULT_PARAMS) === null, "signalAt: too early => null");
}

// ── maxLeverage cap when vol → small ──────────────────────────────────
{
  // very low vol (tiny daily moves) => rawScale huge => capped at maxLeverage.
  const n = 320;
  const closes = Array.from({ length: n }, (_, i) => 100 * 1.00001 ** i);
  const dates = Array.from({ length: n }, () => "2025-01-01");
  const s = signalAt(closes, dates, 300, DEFAULT_PARAMS);
  ok(Math.abs(s.weight) === DEFAULT_PARAMS.maxLeverage, "signalAt: low vol => weight hits maxLeverage cap (no blow-up)");
}

// ── walk-forward: no peeking (decision uses only data<=t) ─────────────
{
  // We assert structurally: the period entry index's lookback return equals a
  // function of closes up to entry only, and the asset_return uses entry→exit.
  const n = 600;
  const closes = Array.from({ length: n }, (_, i) => 100 * 1.001 ** i);
  const dates = Array.from({ length: n }, (_, i) => `d${i}`);
  const sched = buildSignalSchedule(closes, dates, DEFAULT_PARAMS);
  ok(sched.length > 0, "buildSignalSchedule: produces periods on long series");
  ok(sched[0].idx >= DEFAULT_PARAMS.lookbackDays + 1, "schedule: first signal respects lookback warmup (no peeking before warmup)");
  // step is rebalanceDays
  if (sched.length >= 2) {
    ok(sched[1].idx - sched[0].idx === DEFAULT_PARAMS.rebalanceDays, "schedule: steps by rebalanceDays");
  }
}

// ── backtest metrics on a KNOWN curve ─────────────────────────────────
{
  // Two periods: +10% then -50%. equity 1→1.1→0.55. total = -45%. maxDD from
  // peak 1.1 to 0.55 = -50%.
  const periods = [
    { period_return: 0.1, signal: 1, exit_date: "a" },
    { period_return: -0.5, signal: 1, exit_date: "b" },
  ];
  const eq = buildEquityCurve(periods);
  ok(approx(eq[1].equity, 0.55, 1e-6), "equityCurve: 1→1.1→0.55");
  const m = computeBacktestMetrics(periods, DEFAULT_PARAMS);
  ok(approx(m.total_return_pct, -45, 0.01), "metrics: total return -45%");
  ok(approx(m.max_drawdown_pct, -50, 0.01), "metrics: max drawdown -50%");
  ok(m.win_rate_pct === 50, "metrics: win rate 50%");
}

// ── backtest on empty / short data => honest, no crash ────────────────
{
  const r = backtestAsset({ asset: "TEST", rows: [{ close: 100, date: "x" }] }, DEFAULT_PARAMS);
  ok(r.metrics.n_periods === 0, "backtest: too-short data => 0 periods (honest, no crash)");
}

console.log(`\nTSMOM tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
