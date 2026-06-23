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

// ── 1. LIVE wallet-delta path (ground truth) — MODAL EXCLUDED ──────
// HONESTY-AUDIT 2026-06-21: the pre-close wallet does NOT contain the deployed
// modal — it is locked in the LP. The close RETURNS the modal to the wallet.
// So (after - before) = modal_returned + fees - gas; the realized delta is that
// MINUS the deployed modal. Deployed 1.0; before=0.5 (modal in LP); after=1.515
// (modal + small gain came back) → realized = (1.515-0.5) - 1.0 = +0.015 SOL.
check("LIVE wallet-delta: nets the returned modal (no +100% on modal return)", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 0.5,
    walletSolAfter: 1.515,
    solDeployed: 1.0,
  });
  assert.equal(r.method, "wallet_delta");
  assert.equal(r.estimate, false, "measured wallet delta is NOT an estimate");
  assert.ok(Math.abs(r.realized_sol_delta - 0.015) < 1e-9, `expected +0.015, got ${r.realized_sol_delta}`);
  assert.ok(Math.abs(r.realized_sol_delta_pct - 1.5) < 1e-9, `expected +1.5%, got ${r.realized_sol_delta_pct}`);
});

// ── 1b. THE BUG: a break-even trade must read ~0%, NOT +100% ───────
// Modal fully returned, nothing gained/lost. before=0.0 (whole wallet was in LP),
// after=1.0 (modal back). OLD buggy math: after-before = 1.0 → /deployed = +100%.
// FIXED math: (1.0 - 0.0) - 1.0 = 0.0 → 0%. This is the glippy/SOLANGELES class.
check("LIVE wallet-delta: BREAK-EVEN reads ~0% (not the +100% modal-return bug)", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 0.0,
    walletSolAfter: 1.0,
    solDeployed: 1.0,
  });
  assert.ok(Math.abs(r.realized_sol_delta) < 1e-9, `break-even delta must be ~0, got ${r.realized_sol_delta}`);
  assert.ok(Math.abs(r.realized_sol_delta_pct) < 1e-9, `break-even % must be ~0, got ${r.realized_sol_delta_pct}`);
  assert.ok(r.realized_sol_delta_pct < 50, "must NOT report a +100% modal-return profit");
});

// ── 2. LIVE wallet-delta NEGATIVE: a losing trade (glippy -7%) ─────
// Deployed 1.0; modal came back DOWN ~7% (IL/slippage). before=0.5; after=1.43
// → realized = (1.43-0.5) - 1.0 = -0.07 SOL = -7%. Must be NEGATIVE, never +100%.
check("LIVE wallet-delta: losing trade reports NEGATIVE (glippy-style -7%)", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 0.5,
    walletSolAfter: 1.43,
    solDeployed: 1.0,
  });
  assert.equal(r.method, "wallet_delta");
  assert.ok(r.realized_sol_delta < 0, "realized delta must be negative");
  assert.ok(Math.abs(r.realized_sol_delta_pct - (-7)) < 1e-6, `expected ~-7%, got ${r.realized_sol_delta_pct}`);
});

// ── 2b. Fall-through: wallet snapshots present but deployed UNKNOWN ─
// Without a known modal we cannot honestly net it, so the wallet path must NOT
// fire (it would report a modal-inflated %). Falls through to formula/unavailable.
check("LIVE wallet-delta: missing deployed → does NOT use wallet path (no modal inflation)", () => {
  const r = computeLiveRealizedSolDelta({
    walletSolBefore: 0.0,
    walletSolAfter: 1.0,
    // solDeployed omitted
  });
  assert.notEqual(r.method, "wallet_delta", "must not report a modal-inflated wallet delta");
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

// ── 9. HONESTY-AUDIT: notif == ledger, on the real reported trades ─────────
// The notif (executor) and the ledger (lessons.json via dlmm formula) BOTH derive
// from computeLiveRealizedSolDelta. Prove the formula path (the ledger's source)
// reproduces the CONFIRMED honest figures, and that the wallet path (notif's
// preferred source) yields the SAME economic quantity — so notif == ledger and a
// losing trade can never headline as profit.
check("HONESTY: SOLANGELES → +13.31% (not the +63% modal-inflated headline)", () => {
  // deployed 1.0; net economic gain 0.1331 SOL after fees - gas - IL.
  // formula (ledger): received 1.1351 + fees 0 - (1.0 + ~0.002 gas) ≈ +0.1331.
  const received = 1.0 + 0.1331 + DEFAULT_CLOSE_GAS_SOL; // back-solve so net == +0.1331
  const r = computeLiveRealizedSolDelta({ solDeployed: 1.0, solReceivedOnClose: received, feesClaimedSol: 0 });
  assert.ok(Math.abs(r.realized_sol_delta_pct - 13.31) < 0.01, `expected +13.31%, got ${r.realized_sol_delta_pct}`);
  assert.ok(r.realized_sol_delta_pct < 63, "must NOT report the +63% modal-inflated headline");
  // Wallet path on the SAME trade (before 0.0, after = modal+gain) → same quantity.
  const w = computeLiveRealizedSolDelta({ walletSolBefore: 0.0, walletSolAfter: 1.1331, solDeployed: 1.0 });
  assert.ok(Math.abs(w.realized_sol_delta_pct - 13.31) < 0.01, "wallet path agrees with ledger");
});
check("HONESTY: COZY → -0.40% NEGATIVE (not +112%)", () => {
  const received = 1.0 - 0.0040 + DEFAULT_CLOSE_GAS_SOL; // net == -0.0040 after gas
  const r = computeLiveRealizedSolDelta({ solDeployed: 1.0, solReceivedOnClose: received, feesClaimedSol: 0 });
  assert.ok(r.realized_sol_delta_pct < 0, "COZY must read NEGATIVE");
  assert.ok(Math.abs(r.realized_sol_delta_pct - (-0.40)) < 0.01, `expected -0.40%, got ${r.realized_sol_delta_pct}`);
});
check("HONESTY: glippy → -7.14% NEGATIVE (not the +103% trust-eroder)", () => {
  const received = 1.0 - 0.0714 + DEFAULT_CLOSE_GAS_SOL; // net == -0.0714 after gas
  const r = computeLiveRealizedSolDelta({ solDeployed: 1.0, solReceivedOnClose: received, feesClaimedSol: 0 });
  assert.ok(r.realized_sol_delta_pct < 0, "glippy must read NEGATIVE (it was a loss)");
  assert.ok(Math.abs(r.realized_sol_delta_pct - (-7.14)) < 0.01, `expected -7.14%, got ${r.realized_sol_delta_pct}`);
  // Wallet path: before 0.0, modal came back DOWN 7.14% → same negative quantity.
  const w = computeLiveRealizedSolDelta({ walletSolBefore: 0.0, walletSolAfter: 0.9286, solDeployed: 1.0 });
  assert.ok(Math.abs(w.realized_sol_delta_pct - (-7.14)) < 0.01, "wallet path agrees: negative");
});

// ── 10. HONESTY GUARD (2026-06-23): present-but-zero SOL must NOT fabricate -100% ─
// The Meteora closed-PnL API frequently reports allTimeWithdrawals.total.sol === 0
// on a still-settling record. The OLD formula read delta ≈ -(deployed+gas) ≈ -100%.
// When USD economics CONTRADICT a wipe, the formula must FAIL TO UNKNOWN (null).
check("HONESTY GUARD: received=0 + pnlPct says NOT-wiped → UNKNOWN (not fabricated -100%)", () => {
  const r = computeLiveRealizedSolDelta({
    solDeployed: 1.0,
    solReceivedOnClose: 0,   // present-but-zero (settling record)
    feesClaimedSol: 0,
    pnlPct: -3,              // USD says it lost ~3%, NOT a wipe
  });
  assert.equal(r.realized_sol_delta, null, "must NOT emit a fabricated -100%");
  assert.equal(r.realized_sol_delta_pct, null);
  assert.equal(r.method, "unavailable_zero_sol_usd_disagree");
  assert.equal(r.estimate, true);
});
check("HONESTY GUARD: received=0 + finalValueUsd>0 → UNKNOWN (USD value came back)", () => {
  const r = computeLiveRealizedSolDelta({
    solDeployed: 1.0,
    solReceivedOnClose: 0,
    feesClaimedSol: 0,
    finalValueUsd: 180, // USD value DID come back → not a wipe
  });
  assert.equal(r.realized_sol_delta, null);
  assert.equal(r.method, "unavailable_zero_sol_usd_disagree");
});
check("HONESTY GUARD: received=0 + USD AGREES wipe (pnlPct=-99, no usd) → real catastrophe through", () => {
  // When USD ALSO says wiped, we do NOT mask it — a real total loss is honest.
  const r = computeLiveRealizedSolDelta({
    solDeployed: 1.0,
    solReceivedOnClose: 0,
    feesClaimedSol: 0,
    pnlPct: -99,            // USD agrees: near-total wipe
  });
  assert.equal(r.method, "formula", "USD-agreed wipe must pass through, not be masked");
  assert.ok(r.realized_sol_delta < -0.9, "a genuine wipe stays deeply negative");
});
check("HONESTY GUARD: positive received unaffected (guard only fires on zero-SOL)", () => {
  const r = computeLiveRealizedSolDelta({
    solDeployed: 1.0, solReceivedOnClose: 1.02, feesClaimedSol: 0, pnlPct: 2,
  });
  assert.equal(r.method, "formula");
  assert.ok(r.realized_sol_delta != null, "normal formula path still computes");
});

// ── 11. Backfill detection (pure fn) ───────────────────────────────────────
const { isMisbookedRealizedRow } = await import("./backfill-realized-sol-delta.js");
check("BACKFILL: mis-booked -100% row with USD non-wipe → detected", () => {
  assert.equal(isMisbookedRealizedRow({
    realized_sol_delta: -0.20, amount_sol: 0.20, // ratio = -1.0 (~-100%)
    pnl_pct: -4, final_value_usd: 190, close_reason: "OOR rebalance",
  }), true);
});
check("BACKFILL: genuine stop-loss disaster → NOT touched", () => {
  assert.equal(isMisbookedRealizedRow({
    realized_sol_delta: -0.18, amount_sol: 0.20,
    pnl_pct: -92, final_value_usd: 0, close_reason: "Stop loss -8%",
  }), false);
});
check("BACKFILL: a normal small loss (not -100%) → NOT touched", () => {
  assert.equal(isMisbookedRealizedRow({
    realized_sol_delta: -0.01, amount_sol: 0.20, // ratio = -0.05
    pnl_pct: -5, final_value_usd: 190, close_reason: "agent decision",
  }), false);
});
check("BACKFILL: USD ALSO confirms wipe → NOT touched (honest catastrophe)", () => {
  assert.equal(isMisbookedRealizedRow({
    realized_sol_delta: -0.20, amount_sol: 0.20,
    pnl_pct: -97, final_value_usd: 0, close_reason: "OOR",
  }), false);
});
check("BACKFILL: missing amount_sol → NOT touched (cannot judge ratio)", () => {
  assert.equal(isMisbookedRealizedRow({
    realized_sol_delta: -0.20, amount_sol: 0, pnl_pct: -4, final_value_usd: 190,
  }), false);
});

console.log(`\nALL ${assertions} ASSERTIONS PASS — realized SOL delta accounting verified`);
