// tsmom/tsmom-run.js — orchestrate: backtest → honest stats verdict → journal log.
//
// Eats our own dog food: every backtest is logged to the SAME journal that
// governs the rest of Meridian (experiment_id=TSMOM, config_version configurable),
// using the SAME computeStats honesty engine so the verdict can't be cherry-picked.
//
// Each held-out PERIOD return becomes one journal entry (unit "proxy" — these are
// SIMULATED returns, NOT realized money; is_realized stays false by construction).
// That lets `journal-cli report` slice TSMOM v1 alongside everything else and
// apply the n>=10 + |t|>=2 noise gate uniformly.
//
// Usage:
//   node tsmom/tsmom-run.js                      # all majors, config v1
//   node tsmom/tsmom-run.js BTC ETH              # subset
//   TSMOM_CONFIG_VERSION=v2-longflat node tsmom/tsmom-run.js   # variant
//   TSMOM_NO_LOG=1 node tsmom/tsmom-run.js       # dry — compute, don't write journal
//
// Params come from env so config_versions are explicit + reproducible:
//   TSMOM_LOOKBACK, TSMOM_REBALANCE, TSMOM_VOLWINDOW, TSMOM_TARGETVOL,
//   TSMOM_ALLOWSHORT (0/1), TSMOM_MAXLEV
//
// NO money path. NO LLM cost.

import { MAJORS, loadHistory } from "./ohlcv-ingest.js";
import { DEFAULT_PARAMS } from "./tsmom-signal.js";
import { backtestAsset } from "./tsmom-backtest.js";
import { computeStats } from "../journal-stats.js";
import { computeRegimeSplit } from "./tsmom-backtest.js";
import { appendEntry } from "../journal.js";

const EXPERIMENT_ID = "TSMOM";

function paramsFromEnv() {
  const num = (k, d) => (process.env[k] != null ? Number(process.env[k]) : d);
  const p = {
    lookbackDays: num("TSMOM_LOOKBACK", DEFAULT_PARAMS.lookbackDays),
    rebalanceDays: num("TSMOM_REBALANCE", DEFAULT_PARAMS.rebalanceDays),
    volWindowDays: num("TSMOM_VOLWINDOW", DEFAULT_PARAMS.volWindowDays),
    targetAnnualVol: num("TSMOM_TARGETVOL", DEFAULT_PARAMS.targetAnnualVol),
    allowShort: process.env.TSMOM_ALLOWSHORT != null
      ? process.env.TSMOM_ALLOWSHORT === "1"
      : DEFAULT_PARAMS.allowShort,
    maxLeverage: num("TSMOM_MAXLEV", DEFAULT_PARAMS.maxLeverage),
    tradingDaysPerYear: DEFAULT_PARAMS.tradingDaysPerYear,
  };
  return p;
}

function configVersion(p) {
  if (process.env.TSMOM_CONFIG_VERSION) return process.env.TSMOM_CONFIG_VERSION;
  // Default to v2-deephistory: same mechanical spec as v1, but run over the
  // multi-year multi-regime Yahoo daily history instead of the 1yr CoinGecko
  // window. New version string => compares cleanly against v1 in the journal.
  return "v2-deephistory";
}

function pct(x) {
  return x == null ? "n/a" : `${(x * 100).toFixed(2)}%`;
}

export function runAsset(asset, params, configVer, { log = true } = {}) {
  const history = loadHistory(asset);
  if (!history) {
    return { asset, error: `no data file — run: node tsmom/ohlcv-ingest.js ${asset}` };
  }
  const bt = backtestAsset(history, params);
  // Honest stats verdict on the SET of held-out period returns (unit=proxy).
  const periodReturns = bt.periods.map((x) => x.period_return);
  const stats = computeStats(periodReturns, "proxy");

  // Per-regime honest verdict: same computeStats gate (n>=10 + |t|>=2) on each
  // ex-ante regime bucket. The whole B1 question lives here.
  const regimeStats = {};
  for (const regime of ["UPTREND", "DOWNTREND", "CHOP"]) {
    const rets = bt.periods.filter((x) => x.regime === regime).map((x) => x.period_return);
    regimeStats[regime] = computeStats(rets, "proxy");
  }

  let journalEntry = null;
  if (log && process.env.TSMOM_NO_LOG !== "1") {
    journalEntry = appendEntry({
      experiment_id: EXPERIMENT_ID,
      config_version: configVer,
      market: "crypto-spot",
      asset,
      hypothesis:
        `TSMOM (Moskowitz/Ooi/Pedersen): sign of trailing ${params.lookbackDays}d return ` +
        `=> long/${params.allowShort ? "short" : "flat"}, vol-scaled to ${params.targetAnnualVol} ann. ` +
        `vol, rebalance ${params.rebalanceDays}d. Betting trend persistence > whipsaw cost on crypto majors.`,
      setup: {
        params,
        data_source: bt.data_source,
        data_first: bt.data_first,
        data_last: bt.data_last,
        data_rows: bt.data_rows,
        n_periods: bt.metrics.n_periods,
        sharpe_annual: bt.metrics.sharpe_annual,
        max_drawdown_pct: bt.metrics.max_drawdown_pct,
        total_return_pct: bt.metrics.total_return_pct,
        regime_split: bt.regimeSplit,
        regime_verdicts: Object.fromEntries(
          Object.entries(regimeStats).map(([r, s]) => [r, { n: s.n, t: s.tStat, verdict: s.verdict }])
        ),
      },
      status: "closed",
      // outcome = per-trade EXPECTANCY of the held-out periods, as a PROXY
      // (simulated, NOT realized money). is_realized cannot be true for proxy.
      outcome: {
        value: stats.expectancy,
        unit: "proxy",
        is_realized: false,
        note: `mean per-period sim return over n=${stats.n} held-out periods; verdict=${stats.verdict}`,
      },
      lesson:
        `Backtest ${configVer} on ${asset}: ${stats.verdict}. ${stats.honesty}` +
        (stats.payoffTrap ? ` PAYOFF-TRAP: ${stats.payoffTrap}` : ""),
      tags: ["tsmom", "backtest", "walk-forward", "proxy", asset.toLowerCase()],
    });
  }

  return { asset, bt, stats, regimeStats, journalEntry };
}

function printAssetReport(r) {
  if (r.error) {
    console.log(`\n## ${r.asset} — ERROR: ${r.error}`);
    return;
  }
  const m = r.bt.metrics;
  const s = r.stats;
  console.log(`\n## ${r.asset}`);
  console.log(`Data: ${r.bt.data_rows} rows ${r.bt.data_first} → ${r.bt.data_last} (${r.bt.data_source})`);
  if (r.bt.data_warnings.length) {
    for (const w of r.bt.data_warnings) console.log(`  ⚠ ${w}`);
  }
  console.log(`Held-out periods: ${m.n_periods} (long ${m.long_periods} / short ${m.short_periods} / flat ${m.flat_periods})`);
  console.log(`Mean period return: ${pct(m.mean_period_return)}  | SD ${pct(m.sd_period_return)}`);
  console.log(`Sharpe (annual): ${m.sharpe_annual ?? "n/a"}`);
  console.log(`Win rate: ${m.win_rate_pct}%  | payoff ${m.payoff ?? "n/a"}`);
  console.log(`Compounded total: ${m.total_return_pct}%  | MAX DRAWDOWN ${m.max_drawdown_pct}%`);
  console.log(`-- HONEST VERDICT (journal-stats) --`);
  console.log(`  n=${s.n}  expectancy=${s.expectancy} (proxy)  t=${s.tStat ?? "n/a"}`);
  console.log(`  VERDICT: ${s.verdict}`);
  console.log(`  ${s.honesty}`);
  if (s.payoffTrap) console.log(`  PAYOFF TRAP: ${s.payoffTrap}`);
  // Regime split — the core B1 question.
  const rs = r.bt.regimeSplit;
  console.log(`-- REGIME SPLIT (ex-ante trailing-90d trend at entry) --`);
  for (const regime of ["UPTREND", "DOWNTREND", "CHOP"]) {
    const b = rs[regime] || { n: 0 };
    const v = r.regimeStats[regime];
    if (!b.n) { console.log(`  ${regime.padEnd(9)} n=0`); continue; }
    console.log(
      `  ${regime.padEnd(9)} n=${String(b.n).padEnd(3)} mean=${pct(b.mean_period_return).padStart(8)} ` +
      `WR=${String(b.win_rate_pct).padStart(5)}%  L/S/F=${b.long}/${b.short}/${b.flat}  ` +
      `t=${v.tStat ?? "n/a"} ${v.verdict}`
    );
  }
  if (r.journalEntry) console.log(`  journal: logged ${r.journalEntry.id} (${EXPERIMENT_ID}/${r.journalEntry.config_version})`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const assets = args.length ? args.map((a) => a.toUpperCase()) : Object.keys(MAJORS);
  const params = paramsFromEnv();
  const configVer = configVersion(params);

  console.log(`# TSMOM Walk-Forward Backtest — ${EXPERIMENT_ID}/${configVer}`);
  console.log(`Params: ${JSON.stringify(params)}`);
  console.log(`Journal logging: ${process.env.TSMOM_NO_LOG === "1" ? "DRY (no write)" : "ON"}`);

  const results = [];
  for (const asset of assets) {
    const r = runAsset(asset, params, configVer, { log: true });
    results.push(r);
    printAssetReport(r);
  }

  // Pooled verdict across assets (all periods, same unit) — more samples,
  // but HONESTLY flagged: pooling assumes the edge is common across majors.
  const allPeriods = results
    .filter((r) => r.bt)
    .flatMap((r) => r.bt.periods.map((x) => x.period_return));
  if (allPeriods.length) {
    const pooled = computeStats(allPeriods, "proxy");
    console.log(`\n## POOLED (all assets — assumes shared edge across majors)`);
    console.log(`  n=${pooled.n}  expectancy=${pooled.expectancy}  t=${pooled.tStat ?? "n/a"}`);
    console.log(`  VERDICT: ${pooled.verdict}`);
    console.log(`  ${pooled.honesty}`);
    if (pooled.payoffTrap) console.log(`  PAYOFF TRAP: ${pooled.payoffTrap}`);
    console.log(`  ⚠ CORRELATION CAVEAT: BTC/ETH/SOL majors move together; pooled n`);
    console.log(`    overstates independence. Treat pooled as indicative, per-asset as primary.`);

    // Pooled BY REGIME — the cleanest read on "edge across regimes vs bear-short artifact".
    console.log(`\n## POOLED BY REGIME (all assets, ex-ante regime at entry)`);
    const allTagged = results.filter((r) => r.bt).flatMap((r) => r.bt.periods);
    for (const regime of ["UPTREND", "DOWNTREND", "CHOP"]) {
      const rets = allTagged.filter((x) => x.regime === regime).map((x) => x.period_return);
      const st = computeStats(rets, "proxy");
      console.log(
        `  ${regime.padEnd(9)} n=${String(st.n).padEnd(3)} expectancy=${st.expectancy} ` +
        `t=${st.tStat ?? "n/a"} ${st.verdict}`
      );
    }
  }
  console.log(`\n(Run \`node journal-cli.js report\` to see TSMOM alongside other experiments.)`);
}

if (process.argv[1]?.endsWith("tsmom-run.js")) {
  main().catch((e) => {
    console.error("[tsmom-run] fatal:", e.message);
    process.exit(1);
  });
}
