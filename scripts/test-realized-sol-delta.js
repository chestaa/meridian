// scripts/test-realized-sol-delta.js
// Vega fix #1 — TRUE realized SOL delta accounting.
//
// PROBLEM: bot reports LP-PnL (+X%, price-only) while wallet SOL drops, because
// IL + close-swap slippage + gas are NOT in the LP figure. This test proves the
// new realized_sol_delta accounting surfaces the honest economic outcome and is
// strictly more conservative than lp_pnl, while leaving lp_pnl untouched.
//
// Covers:
//   - LIVE wallet-delta path: +5% LP-PnL but measured wallet delta is small/neg
//     → realized_sol_delta_pct < lp_pnl_pct (estimate=false, ground truth)
//   - LIVE formula path: closed-API SOL figures + gas → realized < lp, estimate=true
//   - PAPER close: exit slippage + gas applied → realized_sol_delta_pct < lp_pnl_pct
//   - Both fields present on a closed paper record + lp_pnl preserved
//   - Fail-safe: missing data → null + estimate flag (no fabrication)
//
// Pure accounting — no on-chain calls, no DRY_RUN toggle, no risk constant touched.

import assert from "node:assert/strict";

const {
  computeLiveRealizedSolDelta,
  computePaperRealizedSolDelta,
  DEFAULT_CLOSE_GAS_SOL,
  DEFAULT_PAPER_EXIT_SLIPPAGE_PCT,
} = await import("../realized-sol.js");
const { closePaperTrade } = await import("../paper-trades.js");
const { config } = await import("../config.js");

// Keep this test side-effect-free: do NOT let the test paper close write into the
// real lessons.json / pool-memory.json learning loop. realizedSolAccounting stays
// ON (default) so the realized_sol_delta fields are still computed + asserted.
config.internalAgents.paperFeedsLessons = false;

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

console.log("Vega fix #1 — realized SOL delta accounting\n");

// ── 1. LIVE wallet-delta path (ground truth) ───────────────────────
// Deployed 1.0 SOL, LP-PnL reported +5%. But the wallet only moved +0.01 SOL
// (IL + slippage + gas ate almost all the price gain). Realized must reflect the
// SMALL real delta, NOT the +5% headline.
check("LIVE wallet-delta: realized reflects true wallet move, not LP +5%", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 2.0,
    walletSolAfter: 2.01, // only +0.01 SOL really came back
    solDeployed: 1.0,
  });
  assert.equal(r.method, "wallet_delta");
  assert.equal(r.estimate, false, "measured wallet delta is NOT an estimate");
  assert.ok(Math.abs(r.realized_sol_delta - 0.01) < 1e-9, `expected +0.01, got ${r.realized_sol_delta}`);
  assert.ok(Math.abs(r.realized_sol_delta_pct - 1.0) < 1e-9, `expected +1.0%, got ${r.realized_sol_delta_pct}`);
  // The honest economic % (1.0%) is far below the headline LP-PnL (+5%).
  assert.ok(r.realized_sol_delta_pct < 5, "realized% must be below the LP +5% headline");
});

// ── 2. LIVE wallet-delta NEGATIVE despite positive LP-PnL ──────────
check("LIVE wallet-delta: can be NEGATIVE while LP-PnL is positive", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 2.0,
    walletSolAfter: 1.98, // wallet actually shrank
    solDeployed: 1.0,
  });
  assert.equal(r.method, "wallet_delta");
  assert.ok(r.realized_sol_delta < 0, "realized delta must be negative");
  assert.ok(r.realized_sol_delta_pct < 0, "realized% must be negative even if LP-PnL was +");
});

// ── 3. LIVE formula path (no wallet snapshots) ─────────────────────
// Deployed 1.0 SOL, got back 1.03 SOL + 0.01 fees, minus default gas. LP would
// say +5% (price), but realized formula nets ~+4% after gas.
check("LIVE formula: closed-API SOL + gas → realized < LP, flagged estimate", () => {
  const r = computeLiveRealizedSolDelta({
    solDeployed: 1.0,
    solReceivedOnClose: 1.03,
    feesClaimedSol: 0.01,
    // gasSpentSol omitted → DEFAULT_CLOSE_GAS_SOL used
  });
  assert.equal(r.method, "formula");
  assert.equal(r.estimate, true);
  const expected = 1.03 + 0.01 - (1.0 + DEFAULT_CLOSE_GAS_SOL);
  assert.ok(Math.abs(r.realized_sol_delta - Number(expected.toFixed(8))) < 1e-9,
    `expected ${expected}, got ${r.realized_sol_delta}`);
  assert.ok(r.realized_sol_delta_pct < 5, "realized% must be below a +5% LP headline");
});

// ── 4. Fail-safe: missing data → null + estimate ───────────────────
check("LIVE fail-safe: missing data → null delta + estimate flag (no fabrication)", () => {
  const r = computeLiveRealizedSolDelta({ solDeployed: 1.0 }); // no wallet, no received
  assert.equal(r.realized_sol_delta, null);
  assert.equal(r.realized_sol_delta_pct, null);
  assert.equal(r.estimate, true);
  assert.equal(r.method, "unavailable");
});

// ── 5. PAPER exit slippage applied ─────────────────────────────────
// Paper trade: 1.0 SOL, +5% LP-PnL. Apply default 1% exit slippage + gas.
// realized must be strictly below the +5% LP figure.
check("PAPER: exit slippage + gas → realized_sol_delta_pct < lp_pnl_pct", () => {
  const lpPnlPct = 5;
  const r = computePaperRealizedSolDelta({ amountSol: 1.0, lpPnlPct });
  assert.equal(r.method, "paper_sim");
  assert.equal(r.estimate, true);
  assert.ok(r.realized_sol_delta_pct < lpPnlPct,
    `realized% ${r.realized_sol_delta_pct} must be < LP ${lpPnlPct}%`);
  // Sanity: grossOut 1.05, minus 1.05*1% slippage, minus gas
  const gross = 1.05;
  const expected = gross - gross * (DEFAULT_PAPER_EXIT_SLIPPAGE_PCT / 100) - DEFAULT_CLOSE_GAS_SOL - 1.0;
  assert.ok(Math.abs(r.realized_sol_delta - Number(expected.toFixed(8))) < 1e-9,
    `expected ${expected}, got ${r.realized_sol_delta}`);
});

// ── 6. PAPER fail-safe ─────────────────────────────────────────────
check("PAPER fail-safe: no pnl/amount → null + estimate", () => {
  const r = computePaperRealizedSolDelta({ amountSol: 0, lpPnlPct: 5 });
  assert.equal(r.realized_sol_delta, null);
  assert.equal(r.estimate, true);
});

// ── 7. closePaperTrade attaches BOTH fields, lp_pnl preserved ──────
await (async () => {
  // Build a minimal open paper trade + snapshot and close it. Stub network-free:
  // closePaperTrade reads snapshot.price_proxy_pnl_pct and trade fields only.
  const trade = {
    id: "paper_test_realized",
    status: "open",
    opened_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    pool_name: "TEST-SOL",
    pool_address: "PoolTestAddr",
    base_mint: "BaseMintTest",
    amount_sol: 1.0,
    fees_claimed_sol: 0.01,
    notes: [],
  };
  const snapshot = { price_proxy_pnl_pct: 5, fee_inclusive_pnl_pct: 5.2 };
  const exit = { action: "TAKE_PROFIT", reason: "Take profit: +5%" };

  await closePaperTrade(trade, exit, snapshot);

  check("closePaperTrade: lp_pnl_pct preserved (= price-only +5%)", () => {
    assert.equal(trade.final_pnl_pct, 5, "final_pnl_pct (LP) must stay 5");
    assert.equal(trade.lp_pnl_pct, 5, "lp_pnl_pct label must equal price-only PnL");
  });
  check("closePaperTrade: realized_sol_delta fields present + smaller than LP", () => {
    assert.ok(Number.isFinite(trade.realized_sol_delta), "realized_sol_delta present");
    assert.ok(Number.isFinite(trade.realized_sol_delta_pct), "realized_sol_delta_pct present");
    assert.equal(trade.realized_sol_method, "paper_sim");
    assert.equal(trade.realized_sol_estimate, true);
    assert.ok(trade.realized_sol_delta_pct < trade.lp_pnl_pct,
      `realized% ${trade.realized_sol_delta_pct} must be < LP ${trade.lp_pnl_pct}%`);
  });
  check("closePaperTrade: BOTH lp_pnl and realized_sol shown (additive, not replaced)", () => {
    // lp_pnl untouched AND realized present → both visible to reporting.
    assert.ok(trade.lp_pnl_pct != null && trade.realized_sol_delta_pct != null);
  });
})();

// ── 8. Monotonic property: higher slippage → lower realized ────────
check("PAPER: higher exit slippage strictly lowers realized delta", () => {
  const lo = computePaperRealizedSolDelta({ amountSol: 1, lpPnlPct: 5, exitSlippagePct: 1 });
  const hi = computePaperRealizedSolDelta({ amountSol: 1, lpPnlPct: 5, exitSlippagePct: 3 });
  assert.ok(hi.realized_sol_delta < lo.realized_sol_delta, "more slippage → less realized");
});

console.log(`\nALL ${assertions} ASSERTIONS PASS — realized SOL delta accounting verified`);
