#!/usr/bin/env node
// scripts/audit-two-sided-paper.js
// ─────────────────────────────────────────────────────────────────────────────
// Lyra 🎵 — TWO-SIDED PAPER EV instrumentation + Phase-A1 go/no-go dashboard.
//
// WHY (the whole point of Track-A): single-side-SOL LP is STRUCTURALLY short-gamma
// — capped ~+3-5% upside (idle SOL when OOR-up), full bag to the −8/−12% stop on
// the downside. That inverts the payoff to ~0.38:1 ($ avg win +$0.12 / avg loss
// −$0.33) — NOT a bug, the instrument (see memory: payoff-structure-kombinasi).
// Two-sided LP HOLDS a token-X leg that appreciates on price-up, so it is the ONLY
// structural fix that can capture the upside single-side cannot. This audit measures
// whether the PAPER two-sided book ACTUALLY delivers that thesis before ANY real
// money is risked at Phase-A1 (burner-tiny live).
//
// WHAT IT COMPUTES:
//   1. Per-trade TWO-ASSET paper PnL (SOL) INCLUDING the simulated entry-swap cost
//      (est_swap_cost_sol @100bps) — reusing Andromeda's authoritative
//      computeTwoSidedPaperPnl (fees + swap-cost-in-basis already baked in).
//   2. Split by close reason: two_sided_upside_capture vs two_sided_down_cut.
//   3. Win-rate, avg win / avg loss, PAYOFF RATIO (the number that must beat
//      single-side's inverted 0.38:1), expectancy, break-even WR, t-stat.
//   4. $/trade distribution — does it produce the >=$1-2 winners the thesis needs?
//   5. Upside-capture trades whose underlying price moved >+5% (the appreciation a
//      single-side position would have CAPPED — the structural edge, quantified).
//   6. HEAD-TO-HEAD vs single-side LIVE (same window): EV/payoff both sides.
//   7. Phase-A1 go/no-go gate against EXPLICIT numeric success criteria.
//
// EDGE ≠ PAYOFF (memory: edge-payoff-vs-expectancy-trap): payoff >1 is NOT positive
// edge. Edge = expectancy = WR*avgWin − (1−WR)*|avgLoss|; break-even WR = 1/(1+payoff).
// This report ALWAYS reports payoff AND expectancy AND break-even WR — never declares
// "it works" from payoff alone.
//
// POISON-ZERO EXCLUSION (task item 4): the 42 recent LIVE records carried fabricated
// entry_features (sol_regime=0, flow=0, mcap=0 — the Number(null)===0 trap, memory:
// vega-entry-features-null-not-zero). Vega's fix is FORWARD-ONLY, so those historical
// rows still carry poison zeros. They are EXCLUDED from any entry_features-segmented
// dataset and COUNTED here. They are RETAINED in the realized-SOL EV — realized_sol_delta
// is wallet-truth, independent of the EF bug — so the head-to-head is NOT corrupted.
//
// READ-ONLY. No money/gate/DRY_RUN/screening edits. Reads paper-trades.json (two-sided
// records) + lessons.json (single-side live realized). Never writes live data.
//
// Usage:
//   node scripts/audit-two-sided-paper.js
//   node scripts/audit-two-sided-paper.js --since 2026-07-14 --sol-usd 150 --json
//   node scripts/audit-two-sided-paper.js --paper ./paper-trades.json --lessons ./lessons.json
//
// Exit code: 0 = report generated (regardless of go/no-go); 2 = fatal read error.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeTwoSidedPaperPnl } from "../paper-trades.js";

// ── Tunables / benchmarks ────────────────────────────────────────────────────
export const SOL_USD_DEFAULT = 150;            // FX ASSUMPTION (labelled, never silent). Override --sol-usd.
export const MEANINGFUL_BAR_SOL = 0.005;       // lessons.js DEFAULT_MIN_MEANINGFUL_PROFIT_SOL
export const SINGLE_SIDE_PAYOFF_BENCHMARK = 0.38; // documented $-PnL inverted payoff to beat
// Phase-A1 (burner-tiny live) go-live success criteria — EXPLICIT numbers.
export const PHASE_A1 = {
  MIN_CLOSED_TRADES: 15,
  PAYOFF_FLOOR: 1.0,             // must beat break-even structure (>1:1)
  MIN_UPSIDE_CAPTURE_5PCT: 3,    // >=3 upside-capture trades with >+5% underlying move
  UPSIDE_MOVE_PCT: 5,            // the move single-side structurally caps
  RECONCILE_TOL_PCT: 0.5,        // stored vs recomputed two-asset pct tolerance
};

// ── Poison-zero entry_features signature (task item 4) ───────────────────────
// The fabricated-zero tell: sol_regime_24h_pct === 0 AND buy_sell_flow_ratio === 0
// AND mcap === 0 simultaneously. A genuine reading is never exactly all-three-zero
// (mcap==0 alone is implausible for a deployed pool). FAIL-SAFE: only flags the exact
// triple-zero; a record missing entry_features entirely is NOT poison (just absent).
export function isPoisonZeroEntryFeatures(record) {
  const ef = record?.entry_features;
  if (!ef || typeof ef !== "object") return false;
  const z = (k) => ef[k] === 0; // strict 0 (not null/undefined) — the fabricated value
  return z("sol_regime_24h_pct") && z("buy_sell_flow_ratio") && z("mcap");
}

// ── numeric helpers ──────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(n, d = 4) { return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stddev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// ── trade classification ─────────────────────────────────────────────────────
export function isTwoSidedClosed(trade) {
  return trade?.two_sided === true && trade?.status === "closed";
}

// upside_capture | down_cut | other — from close_action first, close_reason fallback.
export function classifyTwoSidedReason(trade) {
  const a = String(trade?.close_action || "");
  const r = String(trade?.close_reason || "");
  if (a === "TWO_SIDED_UPSIDE_CAPTURE" || /two_sided_upside_capture/.test(r)) return "upside_capture";
  if (a === "TWO_SIDED_DOWN_CUT" || /two_sided_down_cut/.test(r)) return "down_cut";
  return "other";
}

// ── per-trade two-asset economics (SOL), INCLUDING simulated entry-swap cost ──
// PRIMARY path reuses Andromeda's computeTwoSidedPaperPnl(trade, closePrice) — the
// authoritative mark-to-market (entry_basis = Y + X-at-entry + swap_cost;
// current = Y + X-at-close + fees). closePrice = the close-cycle snapshot price
// (trade.latest_snapshot.price is set immediately before closePaperTrade). Returns
// pnl_sol directly. FALLBACK (no close price stored): derive pnl_sol from the stored
// final_two_sided_pnl_pct against a recomputed entry basis. FAIL-CLOSED: no usable
// pct AND no close price → { computable:false }.
export function twoSidedTradeEconomics(trade) {
  const ts = trade?.two_sided_paper || {};
  const entryPx = num(trade?.entry_price ?? ts.active_price_sol_per_token);
  const yLeg = num(ts.y_leg?.sol_amount);
  const tokenX = num(ts.x_leg?.token_x_amount);
  const swapCost = num(ts.entry_swap?.est_swap_cost_sol) ?? 0;
  const reason = classifyTwoSidedReason(trade);
  const entryBasis =
    entryPx != null && yLeg != null && tokenX != null && entryPx > 0
      ? yLeg + tokenX * entryPx + (swapCost >= 0 ? swapCost : 0)
      : null;

  const closePrice = num(trade?.latest_snapshot?.price);
  // PRIMARY — authoritative recompute at the close price.
  if (closePrice != null) {
    const pnl = computeTwoSidedPaperPnl(trade, closePrice);
    if (!pnl.uncomputable && Number.isFinite(pnl.pnl_pct) && Number.isFinite(pnl.pnl_sol)) {
      const xEntry = num(pnl.x_leg_entry_sol);
      const xNow = num(pnl.x_leg_now_sol);
      const xMovePct = xEntry != null && xEntry > 0 && xNow != null ? (xNow / xEntry - 1) * 100 : null;
      return {
        computable: true,
        source: "recompute_at_close_price",
        pnl_pct: pnl.pnl_pct,
        pnl_sol: pnl.pnl_sol,
        entry_basis_sol: pnl.entry_basis_sol,
        swap_cost_sol: swapCost,
        x_leg_move_pct: xMovePct,     // underlying price appreciation of the token leg
        close_price: closePrice,
        reason,
      };
    }
  }
  // FALLBACK — derive from the stored two-asset pct against recomputed basis.
  const storedPct = num(trade?.final_two_sided_pnl_pct ?? trade?.final_pnl_pct);
  if (storedPct != null && entryBasis != null && entryBasis > 0) {
    return {
      computable: true,
      source: "derived_from_stored_pct",
      pnl_pct: storedPct,
      pnl_sol: round((storedPct / 100) * entryBasis, 9),
      entry_basis_sol: round(entryBasis, 9),
      swap_cost_sol: swapCost,
      // Underlying move proxy from stored pct isn't leg-separable; approximate with pct
      // (upside-capture trades are positive by construction) — flagged as approx.
      x_leg_move_pct: null,
      close_price: null,
      reason,
    };
  }
  return { computable: false, source: "uncomputable", pnl_pct: null, pnl_sol: null, reason };
}

// ── payoff / expectancy stats over an array of realized SOL deltas ────────────
// win = pnl_sol > 0, loss = pnl_sol < 0 (flat excluded from payoff, counted in n).
export function payoffStats(pnlSolArray) {
  const vals = pnlSolArray.filter((x) => Number.isFinite(x));
  const n = vals.length;
  const winsArr = vals.filter((x) => x > 0);
  const lossArr = vals.filter((x) => x < 0);
  const wins = winsArr.length;
  const losses = lossArr.length;
  const avgWin = mean(winsArr);
  const avgLoss = mean(lossArr);           // negative
  const payoff = avgWin != null && avgLoss != null && avgLoss !== 0
    ? avgWin / Math.abs(avgLoss)
    : null;
  const wrPct = n > 0 ? (wins / n) * 100 : null;
  const total = vals.reduce((s, x) => s + x, 0);
  const expectancy = n > 0 ? total / n : null;   // SOL per trade
  const breakEvenWrPct = payoff != null ? (1 / (1 + payoff)) * 100 : null;
  const sd = stddev(vals);
  const tStat = expectancy != null && sd != null && sd > 0 && n > 0
    ? expectancy / (sd / Math.sqrt(n))
    : null;
  return {
    n, wins, losses,
    wr_pct: round(wrPct, 1),
    avg_win_sol: round(avgWin, 6),
    avg_loss_sol: round(avgLoss, 6),
    payoff_ratio: round(payoff, 3),
    expectancy_sol: round(expectancy, 6),
    break_even_wr_pct: round(breakEvenWrPct, 1),
    total_pnl_sol: round(total, 6),
    per_trade_sd_sol: round(sd, 6),
    t_stat: round(tStat, 2),
  };
}

function inWindow(dateStr, since) {
  if (!since) return true;
  return typeof dateStr === "string" && dateStr.length >= 10 && dateStr.slice(0, 10) >= since;
}

// ── two-sided paper summary ───────────────────────────────────────────────────
export function summarizeTwoSided(trades, { solUsd = SOL_USD_DEFAULT, since = null } = {}) {
  const closed = (Array.isArray(trades) ? trades : [])
    .filter(isTwoSidedClosed)
    .filter((t) => inWindow(t.closed_at || t.opened_at, since));

  const econ = closed.map((t) => ({ trade: t, e: twoSidedTradeEconomics(t) }));
  const computable = econ.filter((x) => x.e.computable);
  const uncomputable = econ.filter((x) => !x.e.computable);

  const pnlSol = computable.map((x) => x.e.pnl_sol);
  const stats = payoffStats(pnlSol);

  // Split by close reason.
  const byReason = { upside_capture: [], down_cut: [], other: [] };
  for (const x of computable) byReason[x.e.reason].push(x);
  const reasonStats = (arr) => {
    const p = arr.map((x) => x.e.pnl_sol);
    return {
      n: arr.length,
      total_pnl_sol: round(p.reduce((s, v) => s + v, 0), 6),
      avg_pnl_sol: round(mean(p), 6),
      avg_pnl_usd: round(mean(p) != null ? mean(p) * solUsd : null, 2),
    };
  };

  // $/trade distribution among WINNERS (the thesis: >=$1-2 winners).
  const winnerUsd = computable.filter((x) => x.e.pnl_sol > 0).map((x) => round(x.e.pnl_sol * solUsd, 2));
  const winnersOver1 = winnerUsd.filter((u) => u >= 1).length;
  const winnersOver2 = winnerUsd.filter((u) => u >= 2).length;

  // Upside-capture trades whose UNDERLYING price moved >+5% (single-side would cap).
  const upsideBig = byReason.upside_capture.filter(
    (x) => Number.isFinite(x.e.x_leg_move_pct) && x.e.x_leg_move_pct > PHASE_A1.UPSIDE_MOVE_PCT,
  );

  const totalSwapCostSol = round(
    computable.reduce((s, x) => s + (Number.isFinite(x.e.swap_cost_sol) ? x.e.swap_cost_sol : 0), 0),
    6,
  );

  return {
    ...stats,
    sol_usd_assumption: solUsd,
    closed_total: closed.length,
    computable_n: computable.length,
    uncomputable_n: uncomputable.length,
    uncomputable_ids: uncomputable.map((x) => x.trade.id || x.trade.pool_name || "?").slice(0, 10),
    total_pnl_usd: round(stats.total_pnl_sol != null ? stats.total_pnl_sol * solUsd : null, 2),
    avg_win_usd: round(stats.avg_win_sol != null ? stats.avg_win_sol * solUsd : null, 2),
    avg_loss_usd: round(stats.avg_loss_sol != null ? stats.avg_loss_sol * solUsd : null, 2),
    total_entry_swap_cost_sol: totalSwapCostSol,
    by_reason: {
      upside_capture: reasonStats(byReason.upside_capture),
      down_cut: reasonStats(byReason.down_cut),
      other: reasonStats(byReason.other),
    },
    winners_over_1usd: winnersOver1,
    winners_over_2usd: winnersOver2,
    winner_usd_values: winnerUsd.sort((a, b) => b - a),
    upside_capture_over_5pct_move: upsideBig.length,
    upside_capture_moves_pct: upsideBig.map((x) => round(x.e.x_leg_move_pct, 1)),
  };
}

// ── single-side LIVE summary (realized_sol_delta, wallet-truth) ───────────────
export function summarizeSingleSideLive(perfRows, { solUsd = SOL_USD_DEFAULT, since = null } = {}) {
  const rows = Array.isArray(perfRows) ? perfRows : [];
  const real = rows.filter((r) => (r?.source || "live") !== "paper");
  const windowed = real.filter((r) => inWindow(r.recorded_at || r.closed_at, since));
  const withRealized = windowed.filter((r) => num(r.realized_sol_delta) != null);
  const poisonZero = windowed.filter(isPoisonZeroEntryFeatures);

  const pnlSol = withRealized.map((r) => num(r.realized_sol_delta));
  const stats = payoffStats(pnlSol);

  return {
    ...stats,
    sol_usd_assumption: solUsd,
    real_rows_in_window: windowed.length,
    with_realized_n: withRealized.length,
    missing_realized_n: windowed.length - withRealized.length,
    poison_zero_ef_n: poisonZero.length,          // task item 4 — counted, excluded from EF datasets
    avg_win_usd: round(stats.avg_win_sol != null ? stats.avg_win_sol * solUsd : null, 2),
    avg_loss_usd: round(stats.avg_loss_sol != null ? stats.avg_loss_sol * solUsd : null, 2),
    total_pnl_usd: round(stats.total_pnl_sol != null ? stats.total_pnl_sol * solUsd : null, 2),
  };
}

// ── head-to-head (same-window) ────────────────────────────────────────────────
export function headToHead(twoSided, singleSide) {
  const tsPayoff = twoSided.payoff_ratio;
  const ssPayoff = singleSide.payoff_ratio;
  const tsExp = twoSided.expectancy_sol;
  const ssExp = singleSide.expectancy_sol;
  return {
    two_sided_payoff: tsPayoff,
    single_side_payoff: ssPayoff,
    single_side_payoff_benchmark: SINGLE_SIDE_PAYOFF_BENCHMARK,
    payoff_beats_single_side: tsPayoff != null && ssPayoff != null ? tsPayoff > ssPayoff : null,
    payoff_beats_benchmark: tsPayoff != null ? tsPayoff > SINGLE_SIDE_PAYOFF_BENCHMARK : null,
    two_sided_expectancy_sol: tsExp,
    single_side_expectancy_sol: ssExp,
    expectancy_beats_single_side: tsExp != null && ssExp != null ? tsExp > ssExp : null,
    two_sided_wr_pct: twoSided.wr_pct,
    two_sided_break_even_wr_pct: twoSided.break_even_wr_pct,
    wr_beats_break_even: twoSided.wr_pct != null && twoSided.break_even_wr_pct != null
      ? twoSided.wr_pct > twoSided.break_even_wr_pct
      : null,
  };
}

// ── accounting reconciliation (stored vs recomputed two-asset pct) ────────────
export function reconcileTwoSided(trades, { tolPct = PHASE_A1.RECONCILE_TOL_PCT } = {}) {
  const closed = (Array.isArray(trades) ? trades : []).filter(isTwoSidedClosed);
  const results = [];
  for (const t of closed) {
    const stored = num(t.final_two_sided_pnl_pct);
    const closePrice = num(t.latest_snapshot?.price);
    let recomputed = null;
    if (closePrice != null) {
      const pnl = computeTwoSidedPaperPnl(t, closePrice);
      recomputed = pnl.uncomputable ? null : num(pnl.pnl_pct);
    }
    const checkable = stored != null && recomputed != null;
    const diff = checkable ? Math.abs(stored - recomputed) : null;
    results.push({
      id: t.id || t.pool_name || "?",
      stored, recomputed,
      checkable,
      reconciled: checkable ? diff <= tolPct : null,
      diff_pct: diff != null ? round(diff, 4) : null,
    });
  }
  const checkable = results.filter((r) => r.checkable);
  const reconciled = checkable.filter((r) => r.reconciled);
  return {
    total: closed.length,
    checkable: checkable.length,
    reconciled: reconciled.length,
    unreconciled: checkable.length - reconciled.length,
    all_reconciled: checkable.length > 0 && reconciled.length === checkable.length,
    results,
  };
}

// ── Phase-A1 go/no-go gate — EXPLICIT numeric success criteria ────────────────
export function evaluatePhaseA1Gate(twoSided, singleSide, reconciliation) {
  const c = [];
  const add = (id, label, target, actual, pass) => c.push({ id, label, target, actual, pass: !!pass });

  add(
    "sample_size",
    `>= ${PHASE_A1.MIN_CLOSED_TRADES} closed two-sided paper trades`,
    `>= ${PHASE_A1.MIN_CLOSED_TRADES}`,
    twoSided.computable_n,
    twoSided.computable_n >= PHASE_A1.MIN_CLOSED_TRADES,
  );
  add(
    "payoff_over_1",
    `payoff ratio > ${PHASE_A1.PAYOFF_FLOOR}:1`,
    `> ${PHASE_A1.PAYOFF_FLOOR}`,
    twoSided.payoff_ratio,
    twoSided.payoff_ratio != null && twoSided.payoff_ratio > PHASE_A1.PAYOFF_FLOOR,
  );
  add(
    "payoff_beats_single_side",
    "payoff beats single-side live payoff (same window)",
    `> ${singleSide.payoff_ratio ?? "n/a"}`,
    twoSided.payoff_ratio,
    twoSided.payoff_ratio != null && singleSide.payoff_ratio != null &&
      twoSided.payoff_ratio > singleSide.payoff_ratio,
  );
  add(
    "positive_expectancy",
    "expectancy > 0 (positive EDGE — not payoff alone)",
    "> 0 SOL/trade",
    twoSided.expectancy_sol,
    twoSided.expectancy_sol != null && twoSided.expectancy_sol > 0,
  );
  add(
    "wr_over_break_even",
    "win-rate > break-even WR (1/(1+payoff))",
    `> ${twoSided.break_even_wr_pct ?? "n/a"}%`,
    twoSided.wr_pct,
    twoSided.wr_pct != null && twoSided.break_even_wr_pct != null &&
      twoSided.wr_pct > twoSided.break_even_wr_pct,
  );
  add(
    "upside_capture_structural_edge",
    `>= ${PHASE_A1.MIN_UPSIDE_CAPTURE_5PCT} upside-capture trades with >+${PHASE_A1.UPSIDE_MOVE_PCT}% move (single-side would cap)`,
    `>= ${PHASE_A1.MIN_UPSIDE_CAPTURE_5PCT}`,
    twoSided.upside_capture_over_5pct_move,
    twoSided.upside_capture_over_5pct_move >= PHASE_A1.MIN_UPSIDE_CAPTURE_5PCT,
  );
  add(
    "dollar_winners",
    "produces >=$1 winners (thesis single-side can't)",
    ">= 1 winner >= $1",
    twoSided.winners_over_1usd,
    twoSided.winners_over_1usd >= 1,
  );
  add(
    "accounting_reconciles",
    "every closed trade's two-asset PnL reconciles (stored == recomputed)",
    "all reconciled",
    `${reconciliation.reconciled}/${reconciliation.checkable}`,
    reconciliation.all_reconciled,
  );

  const go = c.every((x) => x.pass);
  return { criteria: c, go };
}

// ─────────────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: `not found: ${file}`, data: null };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch (e) { return { ok: false, reason: `unparseable: ${e.message}`, data: null }; }
}

function main() {
  const asJson = process.argv.includes("--json");
  const since = arg("--since", null);
  const solUsd = Number(arg("--sol-usd", String(SOL_USD_DEFAULT))) || SOL_USD_DEFAULT;
  const paperFile = arg("--paper", path.resolve(process.cwd(), "paper-trades.json"));
  const lessonsFile = arg("--lessons", path.resolve(process.cwd(), "lessons.json"));

  const paper = loadJson(paperFile);
  const lessons = loadJson(lessonsFile);
  const trades = Array.isArray(paper.data?.trades) ? paper.data.trades : [];
  const perf = Array.isArray(lessons.data?.performance) ? lessons.data.performance : [];

  const twoSided = summarizeTwoSided(trades, { solUsd, since });
  const singleSide = summarizeSingleSideLive(perf, { solUsd, since });
  const h2h = headToHead(twoSided, singleSide);
  const recon = reconcileTwoSided(trades);
  const gate = evaluatePhaseA1Gate(twoSided, singleSide, recon);

  const report = {
    generated_at: new Date().toISOString(),
    window_since: since || "(all)",
    sol_usd_assumption: solUsd,
    paper_file: paperFile,
    paper_readable: paper.ok,
    lessons_file: lessonsFile,
    lessons_readable: lessons.ok,
    two_sided_paper: twoSided,
    single_side_live: singleSide,
    head_to_head: h2h,
    reconciliation: { total: recon.total, checkable: recon.checkable, reconciled: recon.reconciled, all_reconciled: recon.all_reconciled },
    phase_a1_gate: gate,
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  const line = "─".repeat(70);
  const ts = twoSided, ss = singleSide;
  console.log(line);
  console.log("Lyra 🎵 — TWO-SIDED PAPER EV + Phase-A1 go/no-go");
  console.log(`  window: ${since || "(all)"}   |   SOL/USD assumption: $${solUsd} (labelled, not measured)`);
  if (!paper.ok) console.log(`  ⚠️  paper-trades: ${paper.reason}`);
  if (!lessons.ok) console.log(`  ⚠️  lessons: ${lessons.reason}`);
  console.log(line);
  console.log("  TWO-SIDED PAPER (two-asset PnL, incl. simulated entry-swap cost)");
  console.log(`    closed two-sided ............. ${ts.closed_total} (computable ${ts.computable_n}, uncomputable ${ts.uncomputable_n})`);
  console.log(`    win-rate ..................... ${ts.wr_pct == null ? "n/a" : ts.wr_pct + "%"} (${ts.wins}W / ${ts.losses}L)`);
  console.log(`    avg win / avg loss ........... ${ts.avg_win_sol ?? "n/a"} / ${ts.avg_loss_sol ?? "n/a"} SOL  ($${ts.avg_win_usd ?? "n/a"} / $${ts.avg_loss_usd ?? "n/a"})`);
  console.log(`    PAYOFF RATIO ................. ${ts.payoff_ratio == null ? "n/a" : ts.payoff_ratio + ":1"}   (must beat single-side ${SINGLE_SIDE_PAYOFF_BENCHMARK}:1)`);
  console.log(`    expectancy (EDGE) ............ ${ts.expectancy_sol == null ? "n/a" : ts.expectancy_sol + " SOL/trade"}  ($${round(ts.expectancy_sol != null ? ts.expectancy_sol * solUsd : null, 3) ?? "n/a"})`);
  console.log(`    break-even WR ................ ${ts.break_even_wr_pct == null ? "n/a" : ts.break_even_wr_pct + "%"}   |   t-stat ${ts.t_stat ?? "n/a"} (N=${ts.computable_n})`);
  console.log(`    total entry-swap cost drag ... ${ts.total_entry_swap_cost_sol} SOL`);
  console.log(`    by reason — upside_capture ... n=${ts.by_reason.upside_capture.n}  avg ${ts.by_reason.upside_capture.avg_pnl_sol ?? "n/a"} SOL ($${ts.by_reason.upside_capture.avg_pnl_usd ?? "n/a"})`);
  console.log(`               down_cut .......... n=${ts.by_reason.down_cut.n}  avg ${ts.by_reason.down_cut.avg_pnl_sol ?? "n/a"} SOL ($${ts.by_reason.down_cut.avg_pnl_usd ?? "n/a"})`);
  console.log(`    $/trade winners .............. >=$1: ${ts.winners_over_1usd}   >=$2: ${ts.winners_over_2usd}   values: [${ts.winner_usd_values.join(", ")}]`);
  console.log(`    upside moves >+${PHASE_A1.UPSIDE_MOVE_PCT}% (single-side caps) . ${ts.upside_capture_over_5pct_move}  moves: [${ts.upside_capture_moves_pct.join(", ")}]%`);
  console.log(line);
  console.log("  SINGLE-SIDE LIVE (realized_sol_delta — wallet truth, same window)");
  console.log(`    real rows / with realized .... ${ss.real_rows_in_window} / ${ss.with_realized_n}  (missing realized ${ss.missing_realized_n})`);
  console.log(`    poison-zero entry_features ... ${ss.poison_zero_ef_n}  (EXCLUDED from EF datasets; retained in realized-SOL EV)`);
  console.log(`    win-rate ..................... ${ss.wr_pct == null ? "n/a" : ss.wr_pct + "%"} (${ss.wins}W / ${ss.losses}L)`);
  console.log(`    payoff / expectancy .......... ${ss.payoff_ratio ?? "n/a"}:1  /  ${ss.expectancy_sol == null ? "n/a" : ss.expectancy_sol + " SOL/trade"}`);
  console.log(`    break-even WR ................ ${ss.break_even_wr_pct == null ? "n/a" : ss.break_even_wr_pct + "%"}   |   t-stat ${ss.t_stat ?? "n/a"} (N=${ss.with_realized_n})`);
  console.log(line);
  console.log("  HEAD-TO-HEAD");
  console.log(`    payoff  two-sided ${h2h.two_sided_payoff ?? "n/a"}  vs  single-side ${h2h.single_side_payoff ?? "n/a"}  → beats: ${h2h.payoff_beats_single_side ?? "n/a"}`);
  console.log(`    expectancy two-sided ${h2h.two_sided_expectancy_sol ?? "n/a"}  vs  single-side ${h2h.single_side_expectancy_sol ?? "n/a"}  → beats: ${h2h.expectancy_beats_single_side ?? "n/a"}`);
  console.log(line);
  console.log("  PHASE-A1 GO/NO-GO (burner-tiny live gate) — Bro decides on these");
  for (const cr of gate.criteria) {
    console.log(`    [${cr.pass ? "🟢 PASS" : "🔴 ----"}] ${cr.label}`);
    console.log(`             target ${cr.target}  |  actual ${cr.actual}`);
  }
  console.log(line);
  console.log(`  PHASE-A1 VERDICT: ${gate.go ? "🟢 GO — criteria met, escalate to Bro" : "🔴 NO-GO — criteria unmet (expected pre-soak)"}`);
  console.log(line);
  process.exit(0);
}

// Run only as CLI (not when imported by the test).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(); }
  catch (e) { console.error(`audit-two-sided-paper fatal: ${e?.stack || e?.message || e}`); process.exit(2); }
}
