// scripts/test-audit-two-sided-paper.js
// Lyra 🎵 — assert-based test for the two-sided paper EV + Phase-A1 dashboard.
//
// Proves the report:
//   1. Computes two-asset paper PnL (SOL) INCLUDING the simulated entry-swap cost
//      (removing the swap cost changes the result by exactly est_swap_cost_sol).
//   2. Separates upside_capture vs down_cut by close reason.
//   3. Payoff / expectancy / break-even-WR math is correct on a hand-verified book.
//   4. Head-to-head vs single-side live is correct.
//   5. Poison-zero entry_features detection (triple-zero) — excludes fabricated rows,
//      keeps honest-null and genuine rows.
//   6. Phase-A1 gate GO on a passing book and NO-GO on an insufficient one.
//   7. Accounting reconciles (stored final_two_sided_pnl_pct == recomputed).
//
// Pure functions + fixtures only. No RPC, no live data, no writes.

import {
  isTwoSidedClosed,
  classifyTwoSidedReason,
  isPoisonZeroEntryFeatures,
  twoSidedTradeEconomics,
  payoffStats,
  summarizeTwoSided,
  summarizeSingleSideLive,
  headToHead,
  reconcileTwoSided,
  evaluatePhaseA1Gate,
  SINGLE_SIDE_PAYOFF_BENCHMARK,
} from "./audit-two-sided-paper.js";

let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}  ${detail}`); process.exitCode = 1; }
}
function approx(a, b, tol = 1e-6) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol; }

// ── fixture builder ──────────────────────────────────────────────────────────
// A closed two-sided paper trade. close price drives computeTwoSidedPaperPnl.
let seq = 0;
function mkTwoSided({ entry, tokenX, yLeg, swap, fees = 0, close, reason, storedPct, noClosePrice = false }) {
  seq += 1;
  const action = reason === "upside_capture" ? "TWO_SIDED_UPSIDE_CAPTURE" : "TWO_SIDED_DOWN_CUT";
  return {
    id: `paper_test_${seq}`,
    status: "closed",
    two_sided: true,
    opened_at: "2026-07-14T00:00:00.000Z",
    closed_at: "2026-07-14T02:00:00.000Z",
    entry_price: entry,
    amount_sol: yLeg,
    fees_claimed_sol: fees,
    close_action: action,
    close_reason: `${reason}: fixture`,
    final_two_sided_pnl_pct: storedPct,
    final_pnl_pct: storedPct,
    latest_snapshot: noClosePrice ? null : { price: close, ts: "2026-07-14T02:00:00.000Z" },
    two_sided_paper: {
      two_sided: true,
      active_price_sol_per_token: entry,
      x_leg: { token_x_amount: tokenX },
      y_leg: { sol_amount: yLeg },
      entry_swap: { est_swap_cost_sol: swap },
    },
  };
}

// ── Trade A — hand-verified upside capture (+20% move) ───────────────────────
// entryBasis = 0.2(Y) + 100*0.002(=0.2 X) + 0.002(swap) = 0.402
// current    = 0.2(Y) + 100*0.0024(=0.24 X) + 0.001(fees) = 0.441
// pnlSol     = 0.441 − 0.402 = 0.039 ; pct = 9.70
const tradeA = mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0.002, fees: 0.001, close: 0.0024, reason: "upside_capture", storedPct: 9.7 });

// ── ECONOMICS (task item 1) ──────────────────────────────────────────────────
{
  const e = twoSidedTradeEconomics(tradeA);
  check("A: computable", e.computable === true, JSON.stringify(e));
  check("A: source = recompute_at_close_price", e.source === "recompute_at_close_price", e.source);
  check("A: pnl_sol = 0.039 (incl swap cost + fees)", approx(e.pnl_sol, 0.039), `got ${e.pnl_sol}`);
  check("A: entry_basis_sol = 0.402", approx(e.entry_basis_sol, 0.402), `got ${e.entry_basis_sol}`);
  check("A: swap_cost_sol = 0.002", approx(e.swap_cost_sol, 0.002), `got ${e.swap_cost_sol}`);
  check("A: x_leg_move_pct = +20%", approx(e.x_leg_move_pct, 20), `got ${e.x_leg_move_pct}`);
  check("A: reason = upside_capture", e.reason === "upside_capture", e.reason);
}
// Swap-cost inclusion proof: same trade with swap=0 nets exactly +0.002 more PnL.
{
  const noSwap = mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0, fees: 0.001, close: 0.0024, reason: "upside_capture", storedPct: 10.25 });
  const withSwap = twoSidedTradeEconomics(tradeA).pnl_sol;
  const without = twoSidedTradeEconomics(noSwap).pnl_sol;
  check("swap cost is deducted: Δpnl == est_swap_cost_sol (0.002)", approx(without - withSwap, 0.002), `withSwap=${withSwap} without=${without}`);
}
// Fallback path — no close price, derive from stored pct against recomputed basis.
{
  const noPx = mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0.002, fees: 0, close: 0, reason: "upside_capture", storedPct: 9.7, noClosePrice: true });
  const e = twoSidedTradeEconomics(noPx);
  check("fallback: computable via stored pct", e.computable === true, e.source);
  check("fallback: source = derived_from_stored_pct", e.source === "derived_from_stored_pct", e.source);
  check("fallback: pnl_sol = 9.7% * 0.402 = 0.038994", approx(e.pnl_sol, 0.038994, 1e-6), `got ${e.pnl_sol}`);
}

// ── CLASSIFICATION (task item 1) ─────────────────────────────────────────────
check("classify: upside via close_action", classifyTwoSidedReason(tradeA) === "upside_capture");
check("classify: down via close_action",
  classifyTwoSidedReason({ close_action: "TWO_SIDED_DOWN_CUT" }) === "down_cut");
check("classify: down via close_reason fallback",
  classifyTwoSidedReason({ close_reason: "two_sided_down_cut: net -9%" }) === "down_cut");
check("classify: other when neither", classifyTwoSidedReason({ close_action: "STOP_LOSS" }) === "other");
check("isTwoSidedClosed: true for closed two_sided", isTwoSidedClosed(tradeA) === true);
check("isTwoSidedClosed: false for single-side", isTwoSidedClosed({ status: "closed", two_sided: false }) === false);
check("isTwoSidedClosed: false for open two_sided", isTwoSidedClosed({ status: "open", two_sided: true }) === false);

// ── PAYOFF STATS (task item 1) ───────────────────────────────────────────────
{
  // 12 winners @ +0.039, 5 losers @ -0.022.
  const arr = [...Array(12).fill(0.039), ...Array(5).fill(-0.022)];
  const s = payoffStats(arr);
  check("stats: n = 17", s.n === 17);
  check("stats: wins/losses 12/5", s.wins === 12 && s.losses === 5);
  check("stats: wr = 70.6%", approx(s.wr_pct, 70.6, 0.05), `got ${s.wr_pct}`);
  check("stats: payoff = 0.039/0.022 = 1.773", approx(s.payoff_ratio, 1.773, 0.001), `got ${s.payoff_ratio}`);
  check("stats: expectancy = 0.021059 SOL", approx(s.expectancy_sol, 0.021059, 1e-5), `got ${s.expectancy_sol}`);
  check("stats: break-even WR = 1/(1+1.773) = 36.06%", approx(s.break_even_wr_pct, 36.1, 0.1), `got ${s.break_even_wr_pct}`);
  check("stats: expectancy > 0 (positive edge)", s.expectancy_sol > 0);
}

// ── BUILD A PASSING TWO-SIDED BOOK (>=15 trades) ─────────────────────────────
function passingBook() {
  const winners = Array.from({ length: 12 }, () =>
    mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0.002, fees: 0.001, close: 0.0024, reason: "upside_capture", storedPct: 9.7 }));
  const losers = Array.from({ length: 5 }, () =>
    mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0.002, fees: 0, close: 0.0018, reason: "down_cut", storedPct: -5.47 }));
  return [...winners, ...losers];
}

// ── SINGLE-SIDE LIVE fixture (same window), realistic −EV / low payoff ────────
// 3 wins @ +0.008, 7 losses @ -0.021 → payoff ≈ 0.381 (≈ documented 0.38 benchmark).
// PLUS 2 poison-zero-EF rows (retained in realized EV, flagged) + 1 honest-null row.
function singleSideRows() {
  const win = (i) => ({ source: "live", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: 0.008, pnl_usd: 1, id: `w${i}` });
  const loss = (i) => ({ source: "live", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: -0.021, pnl_usd: -1, id: `l${i}` });
  return [
    win(1), win(2), win(3),
    loss(1), loss(2), loss(3), loss(4), loss(5), loss(6), loss(7),
    // poison-zero EF rows (fabricated triple-zero) — still have realized_sol_delta:
    { source: "live", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: -0.021, entry_features: { sol_regime_24h_pct: 0, buy_sell_flow_ratio: 0, mcap: 0 }, id: "pz1" },
    { source: "live", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: 0.008, entry_features: { sol_regime_24h_pct: 0, buy_sell_flow_ratio: 0, mcap: 0 }, id: "pz2" },
    // honest-null EF row — NOT poison:
    { source: "live", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: -0.021, entry_features: { sol_regime_24h_pct: null, buy_sell_flow_ratio: null, mcap: null }, id: "hn1" },
    // paper row must be excluded entirely:
    { source: "paper", recorded_at: "2026-07-14T01:00:00.000Z", realized_sol_delta: 5.0, id: "paper1" },
  ];
}

// ── SUMMARIES + HEAD-TO-HEAD (task items 1, 2) ───────────────────────────────
{
  const ts = summarizeTwoSided(passingBook(), { solUsd: 150 });
  check("TS: computable_n = 17", ts.computable_n === 17, `got ${ts.computable_n}`);
  check("TS: payoff = 1.773", approx(ts.payoff_ratio, 1.773, 0.002), `got ${ts.payoff_ratio}`);
  check("TS: expectancy > 0", ts.expectancy_sol > 0, `got ${ts.expectancy_sol}`);
  check("TS: by_reason upside n=12", ts.by_reason.upside_capture.n === 12, `got ${ts.by_reason.upside_capture.n}`);
  check("TS: by_reason down_cut n=5", ts.by_reason.down_cut.n === 5, `got ${ts.by_reason.down_cut.n}`);
  check("TS: winners_over_2usd = 12 (0.039*150=$5.85)", ts.winners_over_2usd === 12, `got ${ts.winners_over_2usd}`);
  check("TS: upside moves >+5% = 12", ts.upside_capture_over_5pct_move === 12, `got ${ts.upside_capture_over_5pct_move}`);
  check("TS: total entry-swap cost = 17*0.002 = 0.034", approx(ts.total_entry_swap_cost_sol, 0.034, 1e-6), `got ${ts.total_entry_swap_cost_sol}`);

  const ss = summarizeSingleSideLive(singleSideRows(), { solUsd: 150 });
  // paper row excluded; poison-zero (2) + honest-null (1) rows RETAINED in realized EV
  // (realized_sol_delta is wallet-truth, independent of the EF bug) → 3+7+2+1 = 13.
  check("SS: excludes paper row, retains real (with_realized_n = 13)", ss.with_realized_n === 13, `got ${ss.with_realized_n}`);
  check("SS: poison_zero_ef_n = 2 (flagged, still in EV)", ss.poison_zero_ef_n === 2, `got ${ss.poison_zero_ef_n}`);
  check("SS: payoff ≈ 0.381 (near 0.38 benchmark)", approx(ss.payoff_ratio, 0.381, 0.01), `got ${ss.payoff_ratio}`);
  check("SS: expectancy < 0 (−EV single-side, realistic)", ss.expectancy_sol < 0, `got ${ss.expectancy_sol}`);

  const h2h = headToHead(ts, ss);
  check("H2H: two-sided payoff beats single-side", h2h.payoff_beats_single_side === true);
  check("H2H: two-sided payoff beats 0.38 benchmark", h2h.payoff_beats_benchmark === true);
  check("H2H: two-sided expectancy beats single-side", h2h.expectancy_beats_single_side === true);
  check("H2H: benchmark constant surfaced", h2h.single_side_payoff_benchmark === SINGLE_SIDE_PAYOFF_BENCHMARK);
  check("H2H: two-sided WR beats break-even", h2h.wr_beats_break_even === true);
}

// ── RECONCILIATION (task item 3) ─────────────────────────────────────────────
{
  const recon = reconcileTwoSided(passingBook());
  check("RECON: all 17 checkable", recon.checkable === 17, `got ${recon.checkable}`);
  check("RECON: all reconciled (stored == recomputed)", recon.all_reconciled === true, JSON.stringify(recon.results.filter(r => !r.reconciled)));
  // A deliberately-wrong stored pct must FAIL reconciliation.
  const bad = mkTwoSided({ entry: 0.002, tokenX: 100, yLeg: 0.2, swap: 0.002, fees: 0.001, close: 0.0024, reason: "upside_capture", storedPct: 99.0 });
  const r2 = reconcileTwoSided([bad]);
  check("RECON: wrong stored pct → unreconciled", r2.all_reconciled === false && r2.unreconciled === 1, JSON.stringify(r2));
}

// ── PHASE-A1 GATE (task item 3) ──────────────────────────────────────────────
{
  const book = passingBook();
  const ts = summarizeTwoSided(book, { solUsd: 150 });
  const ss = summarizeSingleSideLive(singleSideRows(), { solUsd: 150 });
  const recon = reconcileTwoSided(book);
  const gate = evaluatePhaseA1Gate(ts, ss, recon);
  check("GATE: 8 criteria evaluated", gate.criteria.length === 8, `got ${gate.criteria.length}`);
  check("GATE: GO on passing book", gate.go === true, JSON.stringify(gate.criteria.filter(c => !c.pass)));
  check("GATE: sample_size PASS", gate.criteria.find(c => c.id === "sample_size").pass === true);
  check("GATE: positive_expectancy PASS", gate.criteria.find(c => c.id === "positive_expectancy").pass === true);
  check("GATE: payoff_beats_single_side PASS", gate.criteria.find(c => c.id === "payoff_beats_single_side").pass === true);
  check("GATE: accounting_reconciles PASS", gate.criteria.find(c => c.id === "accounting_reconciles").pass === true);
}
// NO-GO on an insufficient book (2 trades) — sample size gate must fail.
{
  const tiny = summarizeTwoSided(passingBook().slice(0, 2), { solUsd: 150 });
  const ss = summarizeSingleSideLive(singleSideRows(), { solUsd: 150 });
  const recon = reconcileTwoSided(passingBook().slice(0, 2));
  const gate = evaluatePhaseA1Gate(tiny, ss, recon);
  check("GATE: NO-GO on 2-trade book", gate.go === false);
  check("GATE: sample_size FAILS on tiny book", gate.criteria.find(c => c.id === "sample_size").pass === false);
}

// ── POISON-ZERO DETECTION (task item 4) ──────────────────────────────────────
check("poison: triple-zero → TRUE",
  isPoisonZeroEntryFeatures({ entry_features: { sol_regime_24h_pct: 0, buy_sell_flow_ratio: 0, mcap: 0 } }) === true);
check("poison: real mcap → FALSE",
  isPoisonZeroEntryFeatures({ entry_features: { sol_regime_24h_pct: 0, buy_sell_flow_ratio: 0, mcap: 150000 } }) === false);
check("poison: genuine values → FALSE",
  isPoisonZeroEntryFeatures({ entry_features: { sol_regime_24h_pct: -3.5, buy_sell_flow_ratio: 1.2, mcap: 200000 } }) === false);
check("poison: honest nulls → FALSE (not fabricated 0)",
  isPoisonZeroEntryFeatures({ entry_features: { sol_regime_24h_pct: null, buy_sell_flow_ratio: null, mcap: null } }) === false);
check("poison: no entry_features → FALSE",
  isPoisonZeroEntryFeatures({ id: "x" }) === false);

// ── summary ──────────────────────────────────────────────────────────────────
console.log("\n──────────────────────");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed === 0) console.log("AUDIT TWO-SIDED PAPER TEST OK");
else console.error("AUDIT TWO-SIDED PAPER TEST FAILED");
