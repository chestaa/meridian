#!/usr/bin/env node
// scripts/audit-datamode-daily.js
// ─────────────────────────────────────────────────────────────────────────────
// Lyra 🎵 — DATA-COLLECTION-MODE daily audit + rollback-trigger check.
//
// WHY: data-mode (2026-07-10) deploys ~daily at 0.10 SOL flat to collect 30-50
// REAL trades for direction-gating design. The mode is only justified while the
// bleed stays bounded AND the data we're buying is actually captured. This script
// is the daily go/no-go read against the agreed rollback triggers:
//
//   1. CB halt 2 CONSECUTIVE days          (account-circuit-breaker daily loss cap)
//   2. >= 10 closes AND realized win-rate < 20%
//   3. cumulative realized PnL < -0.15 SOL
//   4. entry_features MISSING on > 20% of closes  (data-capture integrity)
//
// SOURCE OF TRUTH: lessons.json performance[] (realized_sol_delta, source field).
// Real money only — source !== "paper". See memory: realized-pnl-source-of-truth,
// loss-attribution-64-live-2026-07-06.
//
// READ-ONLY. No money/gate/DRY_RUN/screening code. Audit-only.
//
// Usage:
//   node scripts/audit-datamode-daily.js
//   node scripts/audit-datamode-daily.js --since 2026-07-10
//   node scripts/audit-datamode-daily.js --file /opt/meridian/lessons.json --json
//
// Exit code: 0 = all clear, 1 = one or more rollback triggers FIRED (for cron/alerting).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

// ── Config (mirrors the agreed data-mode rollback triggers) ──────────────────
const DATA_MODE_START = "2026-07-10";     // ignore the historical pre-data-mode ledger
const MEANINGFUL_BAR_SOL = 0.005;         // lessons.js DEFAULT_MIN_MEANINGFUL_PROFIT_SOL
const CB_DAILY_LOSS_CAP_SOL = 0.10;       // account-circuit-breaker DAILY_LOSS_CAP_SOL
const MIN_CLOSES_FOR_WR_TRIGGER = 10;
const WR_FLOOR_PCT = 20;
const CUM_PNL_FLOOR_SOL = -0.15;
const EF_MISSING_CEIL_PCT = 20;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes("--json");
const since = arg("--since", DATA_MODE_START);
const lessonsFile = arg("--file", path.resolve(process.cwd(), "lessons.json"));
const cbFile = arg("--cb", path.resolve(process.cwd(), "circuit-breaker-state.json"));

// ── Load real closes in the data-mode window ─────────────────────────────────
function loadPerformance() {
  if (!fs.existsSync(lessonsFile)) return { ok: false, reason: `lessons file not found: ${lessonsFile}`, rows: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(lessonsFile, "utf8")); }
  catch (e) { return { ok: false, reason: `lessons file unparseable: ${e.message}`, rows: [] }; }
  const perf = Array.isArray(parsed?.performance) ? parsed.performance : [];
  return { ok: true, rows: perf };
}

function dayOf(r) {
  const ts = r?.recorded_at || r?.closed_at || null;
  return typeof ts === "string" && ts.length >= 10 ? ts.slice(0, 10) : null;
}

// A record "has entry_features" if the object exists AND at least one of the five
// direction-gating fields is a finite number (fail-safe: an all-null object counts
// as MISSING — it carries no signal for direction-gating design).
const EF_FIELDS = ["sol_regime_24h_pct", "token_price_change_1h", "token_price_change_24h", "buy_sell_flow_ratio", "mcap"];
function efCoverage(r) {
  const ef = r?.entry_features;
  if (!ef || typeof ef !== "object") return { present: false, fields: {} };
  const fields = {};
  let any = false;
  for (const k of EF_FIELDS) {
    const ok = Number.isFinite(Number(ef[k]));
    fields[k] = ok;
    if (ok) any = true;
  }
  return { present: any, fields };
}

// Realized SOL delta is the ONLY honest win/loss signal (wallet-truth). Legacy
// records without it fall back to pnl_usd sign (mirrors lessons.js getTradeJournal).
function realized(r) {
  const v = Number(r?.realized_sol_delta);
  return Number.isFinite(v) ? v : null;
}
function isWin(r) {
  const rs = realized(r);
  if (rs !== null) return rs >= MEANINGFUL_BAR_SOL;
  return Number(r?.pnl_usd ?? 0) > 0;
}

// CB-style daily realized loss reconstruction (mirrors recordRealizedLoss):
// lossSol = amount_sol * (-pnl_pct/100) summed over losing closes that day.
// pnl_pct here is the API price-only pct forwarded into the record.
function cbLossForRecord(r) {
  const pct = Number(r?.pnl_pct ?? r?.apiPnlPct ?? 0);
  const sol = Number(r?.amount_sol ?? 0);
  if (pct < 0 && sol > 0) return sol * (-pct / 100);
  return 0;
}

function readLiveCbHalt() {
  if (!fs.existsSync(cbFile)) return { available: false, halted_today: false };
  try {
    const s = JSON.parse(fs.readFileSync(cbFile, "utf8"));
    return { available: true, halted_today: !!s.halted, date: s.date, halt_reason: s.halt_reason || null,
             realized_loss_sol: Number(s.realized_loss_sol ?? 0) };
  } catch {
    return { available: true, halted_today: true, corrupt: true, halt_reason: "state_unreadable" };
  }
}

function main() {
  const { ok, reason, rows } = loadPerformance();

  // Filter: real money (source !== "paper") AND within the data-mode window.
  const real = rows.filter((r) => (r?.source || "live") !== "paper");
  const windowed = real.filter((r) => {
    const d = dayOf(r);
    return d && d >= since;
  });

  // ── Metric 1: cumulative realized PnL (SOL) over window ───────────────────
  let cumPnlSol = 0;
  let cumKnown = false;
  for (const r of windowed) {
    const rs = realized(r);
    if (rs !== null) { cumPnlSol += rs; cumKnown = true; }
  }

  // ── Metric 2: win rate over window ────────────────────────────────────────
  const closes = windowed.length;
  const wins = windowed.filter(isWin).length;
  const wrPct = closes > 0 ? (wins / closes) * 100 : null;

  // ── Metric 3: entry_features coverage over window ─────────────────────────
  const efPresent = windowed.filter((r) => efCoverage(r).present).length;
  const efMissingPct = closes > 0 ? ((closes - efPresent) / closes) * 100 : 0;
  const fieldCounts = Object.fromEntries(EF_FIELDS.map((k) => [k, 0]));
  for (const r of windowed) {
    const cov = efCoverage(r).fields;
    for (const k of EF_FIELDS) if (cov[k]) fieldCounts[k] += 1;
  }

  // ── Metric 4: CB halt reconstruction per UTC day + live-state read ────────
  const byDay = {};
  for (const r of windowed) {
    const d = dayOf(r);
    if (!d) continue;
    byDay[d] ||= { loss_sol: 0, closes: 0 };
    byDay[d].loss_sol += cbLossForRecord(r);
    byDay[d].closes += 1;
  }
  const days = Object.keys(byDay).sort();
  const haltedDays = days.filter((d) => byDay[d].loss_sol >= CB_DAILY_LOSS_CAP_SOL);
  // 2 consecutive halted days?
  let twoConsecHalt = false;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + "T00:00:00Z");
    const cur = new Date(days[i] + "T00:00:00Z");
    const consecutive = (cur - prev) === 86400000;
    if (consecutive && byDay[days[i - 1]].loss_sol >= CB_DAILY_LOSS_CAP_SOL && byDay[days[i]].loss_sol >= CB_DAILY_LOSS_CAP_SOL) {
      twoConsecHalt = true;
    }
  }
  const liveCb = readLiveCbHalt();

  // ── Rollback triggers ─────────────────────────────────────────────────────
  const triggers = [
    {
      id: "cb_halt_2_consec_days",
      label: "CB halt 2 consecutive days",
      fired: twoConsecHalt,
      detail: `halted-days(reconstructed, loss>=${CB_DAILY_LOSS_CAP_SOL} SOL): [${haltedDays.join(", ") || "none"}]; live-CB halted_today=${liveCb.halted_today}${liveCb.corrupt ? " (STATE CORRUPT)" : ""}`,
    },
    {
      id: "win_rate_below_20",
      label: ">=10 closes AND win-rate <20%",
      fired: closes >= MIN_CLOSES_FOR_WR_TRIGGER && wrPct !== null && wrPct < WR_FLOOR_PCT,
      detail: `closes=${closes} (need >=${MIN_CLOSES_FOR_WR_TRIGGER}), realized WR=${wrPct === null ? "n/a" : wrPct.toFixed(1) + "%"} (floor ${WR_FLOOR_PCT}%)`,
    },
    {
      id: "cum_pnl_below_-0.15_sol",
      label: "cumulative realized PnL < -0.15 SOL",
      fired: cumKnown && cumPnlSol < CUM_PNL_FLOOR_SOL,
      detail: `cum realized PnL=${cumKnown ? cumPnlSol.toFixed(4) + " SOL" : "unknown (no realized figures)"} (floor ${CUM_PNL_FLOOR_SOL} SOL)`,
    },
    {
      id: "entry_features_missing_over_20pct",
      label: "entry_features missing on >20% of closes",
      fired: closes > 0 && efMissingPct > EF_MISSING_CEIL_PCT,
      detail: `missing=${efMissingPct.toFixed(1)}% of ${closes} closes (ceil ${EF_MISSING_CEIL_PCT}%); covered=${efPresent}/${closes}`,
    },
  ];
  const anyFired = triggers.some((t) => t.fired);

  const report = {
    generated_at: new Date().toISOString(),
    lessons_file: lessonsFile,
    lessons_readable: ok,
    lessons_error: ok ? null : reason,
    window_since: since,
    real_closes_in_window: closes,
    cumulative_realized_pnl_sol: cumKnown ? Math.round(cumPnlSol * 10000) / 10000 : null,
    win_rate_pct: wrPct === null ? null : Math.round(wrPct * 10) / 10,
    wins,
    entry_features_missing_pct: Math.round(efMissingPct * 10) / 10,
    entry_features_field_coverage: fieldCounts,
    cb_halted_days_reconstructed: haltedDays,
    live_cb: liveCb,
    triggers,
    ROLLBACK_RECOMMENDED: anyFired,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = "─".repeat(64);
    console.log(line);
    console.log("Lyra 🎵 — DATA-MODE daily audit");
    console.log(`  window since ${since}   |   lessons: ${lessonsFile}`);
    if (!ok) console.log(`  ⚠️  ${reason}`);
    console.log(line);
    console.log(`  real closes in window .......... ${closes}`);
    console.log(`  cumulative realized PnL ........ ${cumKnown ? cumPnlSol.toFixed(4) + " SOL" : "unknown"}`);
    console.log(`  realized win-rate .............. ${wrPct === null ? "n/a" : wrPct.toFixed(1) + "%"} (${wins}/${closes})`);
    console.log(`  entry_features missing ......... ${efMissingPct.toFixed(1)}% (covered ${efPresent}/${closes})`);
    console.log(`  ef field coverage .............. ${EF_FIELDS.map((k) => `${k.replace("_", "").slice(0, 8)}=${fieldCounts[k]}`).join("  ")}`);
    console.log(`  CB halted days (reconstructed) . ${haltedDays.join(", ") || "none"}`);
    console.log(`  live CB halted today ........... ${liveCb.halted_today}${liveCb.corrupt ? " (STATE CORRUPT)" : ""}`);
    console.log(line);
    for (const t of triggers) {
      console.log(`  [${t.fired ? "🔴 FIRED" : "🟢 ok  "}] ${t.label}`);
      console.log(`             ${t.detail}`);
    }
    console.log(line);
    console.log(`  ROLLBACK RECOMMENDED: ${anyFired ? "🔴 YES — escalate to Polaris → Bro" : "🟢 NO — continue data-mode"}`);
    console.log(line);
  }

  process.exit(anyFired ? 1 : 0);
}

main();
