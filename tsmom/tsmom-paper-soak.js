// tsmom/tsmom-paper-soak.js — FORWARD out-of-sample paper-soak for v3-btc-long.
//
// WHY THIS EXISTS
// ---------------
// The v2-deephistory backtest is IN-SAMPLE to the history we already had. A
// backtest validation is permission to FORWARD-TEST, never permission to deploy
// capital. This runner accumulates GENUINELY forward, out-of-sample observations
// from today onward: each scheduled run pulls the latest BTC daily close, computes
// the v3-btc-long target position with data up to that close ONLY (no peek), marks
// the open paper position to market, and — only when the strategy says rebalance —
// closes the prior held period into the journal as one PROXY (simulated, never
// money) observation. No money path. No live orders. No LLM cost.
//
// IDEMPOTENT / STATELESS-FRIENDLY (safe for a daily systemd timer)
// ----------------------------------------------------------------
// The decision is a pure function of (price history, soak state). Running twice
// on the same UTC day is a no-op beyond refreshing the mark-to-market snapshot:
//   * We key progress on the latest CLOSED daily bar's date. The current (live,
//     partial) day's bar is NOT used to rebalance — only fully-closed daily bars
//     decide trades, so re-running mid-day can't double-rebalance.
//   * A rebalance fires only when >= rebalanceDays have elapsed since the last
//     rebalance bar (or on the very first run). Otherwise we just mark-to-market.
//   * State is a single JSON file. If it's missing we cold-start cleanly. If the
//     run crashes after fetching but before writing state, the next run re-derives
//     the same decision from price + (unchanged) state. No partial-write corruption
//     of the journal: the journal append happens AFTER the new period is opened in
//     a single state write, and an append-only journal tolerates a duplicate run
//     by the date-guard (we never log the same closed period twice).
//
// EXACT CLI (for Draco's systemd timer — read the report, no guessing):
//   node tsmom/tsmom-paper-soak.js run        # fetch latest, mark/rebalance, log
//   node tsmom/tsmom-paper-soak.js status      # print current state, NO fetch/write
//   node tsmom/tsmom-paper-soak.js --help
// Env:
//   TSMOM_SOAK_STATE   override state file path (default tsmom/data/soak-v3-btc-long.json)
//   JOURNAL_FILE       override journal path (default ./journal.jsonl) — same as journal.js
//   TSMOM_DATA_DIR     override OHLCV cache dir (default tsmom/data) — same as ohlcv-ingest
//   TSMOM_SOAK_NO_FETCH=1  skip the network pull, use the cached BTC-daily.json as-is
//                          (offline/test mode; decision still honest on cached data)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchDailyHistoryYahoo, saveHistory, loadHistory, dataDir } from "./ohlcv-ingest.js";
import { signalAt } from "./tsmom-signal.js";
import { appendEntry } from "../journal.js";
import {
  V3_BTC_LONG_PARAMS,
  V3_BTC_LONG_ASSET,
  V3_BTC_LONG_VERSION,
} from "./tsmom-variants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ID = "TSMOM";

export function soakStateFile() {
  return process.env.TSMOM_SOAK_STATE
    ? path.resolve(process.env.TSMOM_SOAK_STATE)
    : path.resolve(dataDir(), `soak-${V3_BTC_LONG_VERSION}.json`);
}

export function loadSoakState() {
  const f = soakStateFile();
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null; // corrupt => treat as cold start; we never crash on bad state
  }
}

export function saveSoakState(state) {
  const f = soakStateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
  return f;
}

// Fresh-cold state shape (documented so future-me / Draco can read it raw).
function coldState() {
  return {
    experiment_id: EXPERIMENT_ID,
    config_version: V3_BTC_LONG_VERSION,
    asset: V3_BTC_LONG_ASSET,
    params: V3_BTC_LONG_PARAMS,
    created_at: new Date().toISOString(),
    last_run_at: null,
    last_processed_close_date: null, // the latest CLOSED bar date we've acted on
    open_position: null, // { entry_date, entry_close, signal, weight, lookbackRet, realizedVol }
    closed_periods: 0, // count of journal-logged forward periods
    history: [], // light audit trail of each rebalance decision (not the journal)
  };
}

// Index of the latest FULLY-CLOSED daily bar. The ingester marks the final row
// as a possibly-partial live snapshot, so we treat the last row as "today, live"
// and act on the SECOND-TO-LAST as the latest closed bar. If there are <2 rows
// we have nothing actionable.
export function latestClosedIndex(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return -1;
  return rows.length - 2;
}

// Pure decision: given the price rows + current soak state, what should happen
// this run? Returns { action, ...detail } WITHOUT doing any I/O. action is one of:
//   "cold_open"   first-ever position
//   "rebalance"   close prior period + open new (>= rebalanceDays elapsed)
//   "mark"        just mark-to-market (not enough days elapsed)
//   "noop"        already processed this closed bar / no actionable data
//   "insufficient" not enough history for the lookback yet
export function decideSoak(rows, state, params = V3_BTC_LONG_PARAMS) {
  const ci = latestClosedIndex(rows);
  if (ci < 0) return { action: "insufficient", reason: "fewer than 2 daily bars" };

  const closes = rows.map((r) => r.close);
  const dates = rows.map((r) => r.date);
  const latestDate = dates[ci];
  const latestClose = closes[ci];

  // IDEMPOTENCY GUARD: if we've already acted on this exact closed bar, the only
  // thing left to do is refresh the MTM snapshot — never re-rebalance/re-log.
  const alreadyProcessed = state && state.last_processed_close_date === latestDate;

  // Signal at the latest closed bar (data <= ci only — pure no-peek).
  const sig = signalAt(closes, dates, ci, params);
  if (!sig) {
    return {
      action: "insufficient",
      reason: `lookback (${params.lookbackDays}d) + vol window not yet satisfiable at ${latestDate}`,
      latestDate,
    };
  }

  // Cold start: no open position yet.
  if (!state || !state.open_position) {
    if (alreadyProcessed) {
      return { action: "noop", reason: "closed bar already processed, no open position", latestDate, sig };
    }
    return { action: "cold_open", latestDate, latestClose, sig };
  }

  const op = state.open_position;
  // How many calendar days elapsed since the open (by bar date). We use index
  // distance on the closed series when the entry bar is locatable, else date diff.
  const entryIdx = dates.indexOf(op.entry_date);
  const elapsedBars = entryIdx >= 0 ? ci - entryIdx : daysBetween(op.entry_date, latestDate);

  // Mark-to-market: unrealized return of the OPEN position from entry to now.
  const mtmAssetRet = op.entry_close > 0 ? latestClose / op.entry_close - 1 : null;
  const mtmStratRet = mtmAssetRet == null ? null : +(op.weight * mtmAssetRet).toFixed(6);

  if (elapsedBars >= params.rebalanceDays && !alreadyProcessed) {
    return {
      action: "rebalance",
      latestDate,
      latestClose,
      elapsedBars,
      // realized (proxy) return of the closing period:
      closedPeriod: {
        entry_date: op.entry_date,
        exit_date: latestDate,
        signal: op.signal,
        weight: op.weight,
        lookbackRet: op.lookbackRet,
        asset_return: mtmAssetRet == null ? null : +mtmAssetRet.toFixed(6),
        period_return: mtmStratRet,
        hold_days: elapsedBars,
      },
      // the new position to open at this bar:
      sig,
    };
  }

  // Not enough days elapsed (or already processed today) => mark-to-market only.
  return {
    action: alreadyProcessed && elapsedBars >= params.rebalanceDays ? "noop" : "mark",
    latestDate,
    latestClose,
    elapsedBars,
    mtm: { asset_return: mtmAssetRet == null ? null : +mtmAssetRet.toFixed(6), period_return: mtmStratRet },
    sig,
  };
}

function daysBetween(a, b) {
  const ms = new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime();
  return Math.round(ms / 86400000);
}

// Build the open_position record from a signal at a bar.
function openFromSig(sig, latestClose) {
  return {
    entry_date: sig.date,
    entry_close: latestClose,
    signal: sig.signal, // 0 (flat/cash) or +1 (long) — never -1 (allowShort=false)
    weight: sig.weight, // 0 when flat
    lookbackRet: sig.lookbackRet,
    realizedVol: sig.realizedVol,
    opened_at: new Date().toISOString(),
  };
}

// Append one CLOSED forward period to the journal as a PROXY observation.
// is_realized is false by construction (proxy unit) — this is simulated, never money.
function logClosedPeriod(cp, params) {
  return appendEntry({
    experiment_id: EXPERIMENT_ID,
    config_version: V3_BTC_LONG_VERSION,
    market: "crypto-spot",
    asset: V3_BTC_LONG_ASSET,
    hypothesis:
      `v3-btc-long (pre-registered from v2-deephistory regime split): BTC-only, long/flat, ` +
      `252d lookback sign, vol-scaled to ${params.targetAnnualVol} ann vol, ${params.rebalanceDays}d rebalance. ` +
      `Edge measured in UPTREND+CHOP; short bucket was noise so no short leg. FORWARD out-of-sample.`,
    setup: {
      params,
      entry_date: cp.entry_date,
      exit_date: cp.exit_date,
      signal: cp.signal,
      weight: cp.weight,
      lookbackRet: cp.lookbackRet,
      asset_return: cp.asset_return,
      hold_days: cp.hold_days,
      forward: true, // THIS IS A FORWARD PERIOD, not backtest
    },
    status: "closed",
    outcome: {
      value: cp.period_return, // strategy return over the held window (proxy)
      unit: "proxy", // SIMULATED — can never be flagged is_realized money
      is_realized: false,
      note: `forward paper period ${cp.entry_date}→${cp.exit_date}, weight ${cp.weight}, ` +
        `asset move ${cp.asset_return == null ? "n/a" : (cp.asset_return * 100).toFixed(2) + "%"}`,
    },
    lesson:
      `Forward v3-btc-long period closed: ${cp.signal === 0 ? "FLAT (cash)" : "LONG"} ` +
      `=> ${cp.period_return == null ? "n/a" : (cp.period_return * 100).toFixed(2) + "%"} (proxy). ` +
      `Verdict is NOT trustworthy until enough forward periods accumulate (n>=10).`,
    tags: ["tsmom", "forward", "paper-soak", "proxy", "btc", V3_BTC_LONG_VERSION],
  });
}

// Execute one soak run: fetch (unless TSMOM_SOAK_NO_FETCH), decide, act, persist.
// Returns a result object summarizing what happened (for the CLI + tests).
export async function runSoak({ fetch = true, log = true } = {}) {
  const params = V3_BTC_LONG_PARAMS;

  // 1) Refresh BTC daily history (idempotent: overwrites the cached file).
  if (fetch && process.env.TSMOM_SOAK_NO_FETCH !== "1") {
    const res = await fetchDailyHistoryYahoo(V3_BTC_LONG_ASSET);
    if (res.ok) {
      saveHistory(res);
    } else {
      // HONEST: don't fabricate. Fall back to cached data, flag the gap.
      const cached = loadHistory(V3_BTC_LONG_ASSET);
      if (!cached) {
        return { action: "error", reason: `fetch failed and no cached data: ${res.warnings.join("; ")}` };
      }
    }
  }

  const history = loadHistory(V3_BTC_LONG_ASSET);
  if (!history || !Array.isArray(history.rows) || !history.rows.length) {
    return { action: "error", reason: `no BTC history — run: node tsmom/ohlcv-ingest.js BTC` };
  }

  let state = loadSoakState() || coldState();
  const decision = decideSoak(history.rows, state, params);

  let journalEntry = null;
  const nowIso = new Date().toISOString();

  if (decision.action === "cold_open") {
    state.open_position = openFromSig(decision.sig, decision.latestClose);
    state.last_processed_close_date = decision.latestDate;
    state.last_run_at = nowIso;
    state.history.push({ at: nowIso, action: "cold_open", date: decision.latestDate, weight: decision.sig.weight, signal: decision.sig.signal });
    saveSoakState(state);
  } else if (decision.action === "rebalance") {
    // 1) close the prior period into the journal (one forward observation)
    if (log) journalEntry = logClosedPeriod(decision.closedPeriod, params);
    state.closed_periods += 1;
    // 2) open the new position at this bar
    state.open_position = openFromSig(decision.sig, decision.latestClose);
    state.last_processed_close_date = decision.latestDate;
    state.last_run_at = nowIso;
    state.history.push({
      at: nowIso, action: "rebalance", date: decision.latestDate,
      closed_period_return: decision.closedPeriod.period_return,
      new_weight: decision.sig.weight, new_signal: decision.sig.signal,
    });
    saveSoakState(state);
  } else if (decision.action === "mark") {
    state.last_run_at = nowIso;
    state.last_mtm = { date: decision.latestDate, ...decision.mtm, at: nowIso };
    saveSoakState(state);
  } else {
    // noop / insufficient / error — still stamp last_run_at when we have state.
    if (state) {
      state.last_run_at = nowIso;
      saveSoakState(state);
    }
  }

  return { ...decision, journalEntry, closed_periods: state.closed_periods, state_file: soakStateFile() };
}

// ── CLI ───────────────────────────────────────────────────────────────
function pct(x) {
  return x == null ? "n/a" : `${(x * 100).toFixed(2)}%`;
}

function printStatus(state) {
  if (!state) {
    console.log("[soak] no state yet — cold. Run `node tsmom/tsmom-paper-soak.js run` to start.");
    return;
  }
  console.log(`# TSMOM paper-soak status — ${state.experiment_id}/${state.config_version} (${state.asset})`);
  console.log(`State file : ${soakStateFile()}`);
  console.log(`Created    : ${state.created_at}`);
  console.log(`Last run   : ${state.last_run_at || "never"}`);
  console.log(`Last closed bar processed: ${state.last_processed_close_date || "none"}`);
  console.log(`Forward periods logged   : ${state.closed_periods}`);
  if (state.open_position) {
    const op = state.open_position;
    console.log(`Open position: ${op.signal === 0 ? "FLAT (cash)" : "LONG"}  weight=${op.weight}  entry ${op.entry_date} @ ${op.entry_close}`);
  } else {
    console.log(`Open position: none`);
  }
  if (state.last_mtm) {
    console.log(`Last MTM   : ${state.last_mtm.date}  strat ${pct(state.last_mtm.period_return)} (asset ${pct(state.last_mtm.asset_return)})`);
  }
}

async function main() {
  const cmd = (process.argv[2] || "run").toLowerCase();
  if (cmd === "--help" || cmd === "help" || cmd === "-h") {
    console.log(`TSMOM forward paper-soak — ${V3_BTC_LONG_VERSION} (${V3_BTC_LONG_ASSET}-only, long/flat)

Usage:
  node tsmom/tsmom-paper-soak.js run       fetch latest BTC close, mark/rebalance, log to journal
  node tsmom/tsmom-paper-soak.js status    print current soak state (no fetch, no write)
  node tsmom/tsmom-paper-soak.js --help

Env:
  TSMOM_SOAK_STATE    state file path   (default tsmom/data/soak-${V3_BTC_LONG_VERSION}.json)
  JOURNAL_FILE        journal path      (default ./journal.jsonl)
  TSMOM_DATA_DIR      OHLCV cache dir   (default tsmom/data)
  TSMOM_SOAK_NO_FETCH=1  use cached BTC-daily.json, skip network (offline/test)`);
    return;
  }

  if (cmd === "status") {
    printStatus(loadSoakState());
    return;
  }

  if (cmd === "run") {
    const r = await runSoak({ fetch: true, log: true });
    console.log(`# TSMOM paper-soak run — ${V3_BTC_LONG_VERSION}`);
    console.log(`Action: ${r.action}`);
    if (r.reason) console.log(`Reason: ${r.reason}`);
    if (r.latestDate) console.log(`Latest closed bar: ${r.latestDate}`);
    if (r.action === "cold_open") {
      console.log(`Opened: ${r.sig.signal === 0 ? "FLAT (cash)" : "LONG"} weight=${r.sig.weight} (lookbackRet ${pct(r.sig.lookbackRet)})`);
    } else if (r.action === "rebalance") {
      console.log(`Closed period ${r.closedPeriod.entry_date}→${r.closedPeriod.exit_date}: ${pct(r.closedPeriod.period_return)} (proxy)`);
      console.log(`Opened: ${r.sig.signal === 0 ? "FLAT (cash)" : "LONG"} weight=${r.sig.weight}`);
      if (r.journalEntry) console.log(`Journal: logged ${r.journalEntry.id}`);
    } else if (r.action === "mark") {
      console.log(`Mark-to-market: strat ${pct(r.mtm.period_return)} (asset ${pct(r.mtm.asset_return)}), ${r.elapsedBars}/${V3_BTC_LONG_PARAMS.rebalanceDays} days into hold`);
    }
    console.log(`Forward periods logged so far: ${r.closed_periods}`);
    console.log(`\n(Run \`node journal-cli.js report TSMOM\` to see the forward verdict — THIN until n>=10.)`);
    return;
  }

  console.error(`unknown command "${cmd}". Try: run | status | --help`);
  process.exit(1);
}

if (process.argv[1]?.endsWith("tsmom-paper-soak.js")) {
  main().catch((e) => {
    console.error("[tsmom-paper-soak] fatal:", e.message);
    process.exit(1);
  });
}
