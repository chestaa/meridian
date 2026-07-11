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
// PLUS integrity guards (the fake-realized bug must not silently recur):
//
//   G1. realized_sol_delta present + finite on EVERY live close  (ledger integrity)
//   G2. inflation-signature scan: realized_sol_delta positive & large (>= +40% or
//       >= +0.03 SOL) WHILE the price-only LP-PnL (pnl_pct/lp_pnl_pct) is NEGATIVE.
//       That combination is the tell-tale of the old wallet-delta bug (a concurrent
//       position's returned modal miscounted as this trade's profit → fake "+55%").
//
// DIVERGENCE-GUARD HONESTY: post Vega 2026-07-11 fix, the notify-reported realized
// and the ledger realized are the SAME field (result.realized_sol_delta ===
// result.ledger_realized_sol_delta). The notify value itself lands only in a
// Telegram message — it is NOT persisted to any queryable store — so a literal
// notify-vs-ledger diff cannot be recomputed after the fact. The practical guard is
// therefore G1 (assert the ledger figure the ledger writes is present+finite) plus
// G2 (flag the old bug's inflation signature should it ever reappear in a record).
//
// DEPLOY-GAS DRAG: per-trade realized (realized-sol.js) captures IL + exit slippage
// + CLOSE-leg gas, but NOT the DEPLOY-leg gas (~0.003 SOL/tx; ~0.042 SOL/day at ~14
// deploys — roughly HALF the daily tuition, previously invisible). This audit surfaces
// it so the TRUE daily economics (realized PnL − deploy gas) are visible. Source:
// deploy-gas-ledger.getDeployGasDailySol(). CAVEAT: that ledger is in-memory / process-
// local, so a separate audit invocation reads it as 0 (only the running bot process
// has the live total). When the live ledger reads 0 we fall back to an ESTIMATE =
// (closes in last 24h) × DEFAULT_DEPLOY_GAS_SOL — labelled as an estimate, never
// dressed up as a measured figure (anti-pattern #2).
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
const DAY_MS = 86400000;

// Inflation-signature thresholds (integrity guard G2). The old wallet-delta bug
// produced a fake realized ~ +55% / ~+0.05 SOL on a 0.10 deploy while the position's
// price-only LP-PnL was NEGATIVE. A modest positive realized on a slight price dip is
// LEGIT (fees can net the wallet positive), so we only flag when realized is BOTH
// positive AND large enough that fees alone can't plausibly explain it while LP-PnL
// is underwater. Fail-safe: never flag on absent data.
const INFLATION_PCT_FLOOR = 40;   // realized_sol_delta_pct >= this WHILE lp_pnl < 0
const INFLATION_ABS_SOL = 0.03;   // fallback abs floor (~+30% on a 0.10 deploy) when pct absent

// Fallback deploy-gas per-tx estimate, used only if deploy-gas-ledger.js can't be
// imported (kept in sync with deploy-gas-ledger.DEFAULT_DEPLOY_GAS_SOL).
let DEFAULT_DEPLOY_GAS_SOL = 0.003;

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

// realized_sol_delta_pct as written by the executor/ledger; null if absent/non-finite.
function realizedPct(r) {
  const v = Number(r?.realized_sol_delta_pct);
  return Number.isFinite(v) ? v : null;
}

// Price-only LP-PnL pct. lessons.js writes it as pnl_pct (= apiPnlPct, price-only);
// the executor labels the same value lp_pnl_pct on the result. Read either.
function lpPnlPct(r) {
  const v = Number(r?.lp_pnl_pct ?? r?.pnl_pct);
  return Number.isFinite(v) ? v : null;
}

// Integrity guard G2 — old fake-realized bug signature. Fires ONLY on a live close
// whose realized SOL is positive AND large (>= +40% or, if pct is absent, >= +0.03 SOL)
// WHILE its price-only LP-PnL is negative. FAIL-SAFE: any missing input → false (a
// data gap is caught by G1, not mislabelled as inflation here).
function inflationSignature(r) {
  const rs = realized(r);       // SOL
  const rsPct = realizedPct(r); // %
  const lp = lpPnlPct(r);       // %
  if (rs === null || lp === null || rs <= 0 || lp >= 0) return false;
  const bigPct = rsPct !== null && rsPct >= INFLATION_PCT_FLOOR;
  const bigAbsFallback = rsPct === null && rs >= INFLATION_ABS_SOL;
  return bigPct || bigAbsFallback;
}

function parseTs(r) {
  const t = Date.parse(r?.recorded_at || r?.closed_at || "");
  return Number.isFinite(t) ? t : null;
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : n;
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

async function main() {
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

  // ── Integrity guards (G1 ledger presence, G2 inflation signature) ─────────
  // Only meaningful for LIVE closes (paper never had a wallet realized figure).
  const liveWindowed = windowed.filter((r) => (r?.source || "live") !== "paper");
  const missingRealized = liveWindowed.filter((r) => realized(r) === null);
  const inflationHits = liveWindowed.filter(inflationSignature);
  const g1Fired = missingRealized.length > 0;
  const g2Fired = inflationHits.length > 0;

  function describeRow(r) {
    const rs = realized(r);
    const rsPct = realizedPct(r);
    const lp = lpPnlPct(r);
    const name = r?.pool_name || (r?.pool ? String(r.pool).slice(0, 8) : "?");
    const day = dayOf(r) || "?";
    return `${name}@${day} realized=${rs === null ? "MISSING" : rs.toFixed(4) + " SOL"}` +
           `${rsPct === null ? "" : " (" + rsPct.toFixed(1) + "%)"}` +
           ` lp_pnl=${lp === null ? "?" : lp.toFixed(1) + "%"} amt=${Number(r?.amount_sol ?? 0).toFixed(3)} SOL`;
  }

  const integrityGuards = [
    {
      id: "realized_sol_delta_present_all_live_closes",
      label: "G1 — realized_sol_delta present+finite on every live close",
      fired: g1Fired,
      detail: g1Fired
        ? `${missingRealized.length}/${liveWindowed.length} live close(s) MISSING realized_sol_delta: ${missingRealized.slice(0, 5).map(describeRow).join(" | ")}${missingRealized.length > 5 ? " …" : ""}`
        : `all ${liveWindowed.length} live close(s) carry a finite ledger realized_sol_delta`,
    },
    {
      id: "realized_inflation_signature",
      label: "G2 — fake-realized inflation signature (realized big-positive while LP-PnL negative)",
      fired: g2Fired,
      detail: g2Fired
        ? `${inflationHits.length} close(s) match the old-bug tell (>=+${INFLATION_PCT_FLOOR}% or >=+${INFLATION_ABS_SOL} SOL realized WHILE lp_pnl<0): ${inflationHits.slice(0, 5).map(describeRow).join(" | ")}${inflationHits.length > 5 ? " …" : ""}`
        : `no inflation signature in ${liveWindowed.length} live close(s)`,
    },
  ];
  const anyIntegrityFired = integrityGuards.some((g) => g.fired);

  // ── Deploy-gas drag (true daily economics = realized PnL − deploy gas) ─────
  // getDeployGasDailySol() is a rolling 24h total from an in-memory, process-local
  // ledger; a separate audit process sees 0 (only the running bot holds the live
  // total). When live reads 0 we fall back to an estimate from close-count.
  const now = Date.now();
  let deployGasLiveSol = null;
  let deployGasCount = null;
  let deployGasLedgerAvailable = false;
  let deployGasLedgerError = null;
  try {
    const gasMod = await import("../deploy-gas-ledger.js");
    if (Number.isFinite(Number(gasMod.DEFAULT_DEPLOY_GAS_SOL))) DEFAULT_DEPLOY_GAS_SOL = Number(gasMod.DEFAULT_DEPLOY_GAS_SOL);
    deployGasLiveSol = Number(gasMod.getDeployGasDailySol(now));
    deployGasCount = Number(gasMod.getDeployGasCount(now));
    deployGasLedgerAvailable = true;
  } catch (e) {
    deployGasLedgerError = e.message;
  }

  // Estimate deploy gas from lessons closes as a proxy for deploys (1 deploy ≈ 1 close).
  const closes24h = liveWindowed.filter((r) => { const t = parseTs(r); return t !== null && (now - t) <= DAY_MS; });
  const deployGasEstimate24hSol = round4(closes24h.length * DEFAULT_DEPLOY_GAS_SOL);
  const deployGasEstimateWindowSol = round4(liveWindowed.length * DEFAULT_DEPLOY_GAS_SOL);

  // Effective daily deploy gas: prefer the live ledger figure when it's a positive
  // in-process total; otherwise use the estimate (honestly flagged).
  const liveGasUsable = deployGasLedgerAvailable && Number.isFinite(deployGasLiveSol) && deployGasLiveSol > 0;
  const effectiveDailyDeployGasSol = liveGasUsable ? round4(deployGasLiveSol) : deployGasEstimate24hSol;
  const deployGasSource = liveGasUsable ? "live-ledger" : (deployGasLedgerAvailable ? "estimate (live ledger 0 — separate process)" : `estimate (ledger unavailable: ${deployGasLedgerError})`);

  // Realized over last 24h to pair with the daily deploy-gas figure.
  let realized24hSol = 0;
  let realized24hKnown = false;
  for (const r of closes24h) { const rs = realized(r); if (rs !== null) { realized24hSol += rs; realized24hKnown = true; } }
  const netDaily24hSol = realized24hKnown ? round4(realized24hSol - effectiveDailyDeployGasSol) : null;
  const netWindowWithGasSol = cumKnown ? round4(cumPnlSol - deployGasEstimateWindowSol) : null;

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
  const exitAlert = anyFired || anyIntegrityFired;

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
    deploy_gas: {
      default_per_tx_sol: DEFAULT_DEPLOY_GAS_SOL,
      ledger_available: deployGasLedgerAvailable,
      ledger_error: deployGasLedgerError,
      live_daily_sol: deployGasLedgerAvailable ? round4(deployGasLiveSol) : null,
      live_deploy_count: deployGasCount,
      estimate_24h_sol: deployGasEstimate24hSol,
      estimate_window_sol: deployGasEstimateWindowSol,
      effective_daily_sol: effectiveDailyDeployGasSol,
      source: deployGasSource,
      realized_24h_sol: realized24hKnown ? round4(realized24hSol) : null,
      net_daily_24h_sol: netDaily24hSol,
      net_window_with_gas_sol: netWindowWithGasSol,
    },
    integrity_guards: integrityGuards,
    INTEGRITY_ALERT: anyIntegrityFired,
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
    console.log("  DEPLOY-GAS DRAG (true daily economics = realized − deploy gas)");
    console.log(`  deploy gas / day ............... ${effectiveDailyDeployGasSol.toFixed(4)} SOL  [${deployGasSource}]`);
    if (deployGasLedgerAvailable) console.log(`    live ledger .................. ${round4(deployGasLiveSol).toFixed(4)} SOL (${deployGasCount} deploy(s) in-process, 24h)`);
    console.log(`    estimate (closes×${DEFAULT_DEPLOY_GAS_SOL}) ....... 24h=${deployGasEstimate24hSol.toFixed(4)} SOL (${closes24h.length} closes)  window=${deployGasEstimateWindowSol.toFixed(4)} SOL (${liveWindowed.length} closes)`);
    console.log(`  realized last 24h .............. ${realized24hKnown ? round4(realized24hSol).toFixed(4) + " SOL" : "unknown"}`);
    console.log(`  NET last 24h (realized − gas) .. ${netDaily24hSol === null ? "unknown" : netDaily24hSol.toFixed(4) + " SOL"}`);
    console.log(`  NET window (cum realized − gas)  ${netWindowWithGasSol === null ? "unknown" : netWindowWithGasSol.toFixed(4) + " SOL"}`);
    console.log(line);
    console.log("  INTEGRITY GUARDS (fake-realized bug watch)");
    for (const g of integrityGuards) {
      console.log(`  [${g.fired ? "🔴 FIRED" : "🟢 ok  "}] ${g.label}`);
      console.log(`             ${g.detail}`);
    }
    console.log(line);
    for (const t of triggers) {
      console.log(`  [${t.fired ? "🔴 FIRED" : "🟢 ok  "}] ${t.label}`);
      console.log(`             ${t.detail}`);
    }
    console.log(line);
    console.log(`  INTEGRITY ALERT: ${anyIntegrityFired ? "🔴 YES — fake-realized signature/gap; escalate to Polaris → Bro" : "🟢 NO — ledger integrity intact"}`);
    console.log(`  ROLLBACK RECOMMENDED: ${anyFired ? "🔴 YES — escalate to Polaris → Bro" : "🟢 NO — continue data-mode"}`);
    console.log(line);
  }

  process.exit(exitAlert ? 1 : 0);
}

main().catch((e) => {
  console.error(`audit-datamode-daily fatal: ${e?.stack || e?.message || e}`);
  process.exit(2);
});
