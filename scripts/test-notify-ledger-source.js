// scripts/test-notify-ledger-source.js
// Vega 2026-07-11 — notify single-source-of-truth (FIX #1) + deploy-gas
// visibility (FIX #2).
//
// FIX #1 BUG (Lyra forensic): the close NOTIFY computed a wallet-delta
// (wallet_after - wallet_before - deployed) whose snapshots are corrupted by
// concurrent-position SOL inflows under maxPositions>1 → another position's
// returned modal counted as this trade's profit → fake "+55%". The LEDGER
// (dlmm.js formula path, written to lessons.json) was correct all along.
//
// This test proves:
//   - selectNotifyRealizedSol() surfaces the LEDGER figure verbatim (notif==ledger)
//   - in a concurrent-position scenario the OLD wallet-delta WOULD have inflated,
//     but the new notify path reports the honest ledger figure instead
//   - anti-pattern #2: missing ledger figure → honest null (never wallet fallback)
//   - deploy-gas ledger records an estimate + exposes a rolling daily aggregate
//
// Pure accounting/reporting — no on-chain calls, no DRY_RUN toggle, no risk
// constant, no deploy/close/SL/TP/sizing/tx-signing logic touched.

import assert from "node:assert/strict";

const {
  selectNotifyRealizedSol,
  computeLiveRealizedSolDelta,
} = await import("../realized-sol.js");
const {
  recordDeployGas,
  getDeployGasDailySol,
  getDeployGasTotalSol,
  getDeployGasCount,
  DEFAULT_DEPLOY_GAS_SOL,
  __resetDeployGasLedgerForTest,
  __getDeployGasLedgerForTest,
} = await import("../deploy-gas-ledger.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

console.log("Vega — notify ledger source of truth + deploy-gas visibility\n");

// ── 1. notif == ledger: the exact figure lessons.json booked ──────────
check("notify surfaces the LEDGER figure verbatim", () => {
  // Bullscan-style honest loss the ledger booked: -8.43% on 0.10 SOL.
  const result = {
    pnl_pct: 12.5, // price-only LP-PnL (higher — the misleading number)
    ledger_realized_sol_delta: -0.00843,
    ledger_realized_sol_delta_pct: -8.43,
    ledger_realized_sol_method: "formula",
    ledger_realized_sol_estimate: true,
  };
  const notif = selectNotifyRealizedSol(result);
  assert.equal(notif.realized_sol_delta, -0.00843, "notif delta must equal ledger delta");
  assert.equal(notif.realized_sol_delta_pct, -8.43, "notif pct must equal ledger pct");
  assert.equal(notif.realized_sol_method, "formula");
  assert.equal(notif.realized_sol_estimate, true);
});

// ── 2. THE BUG: concurrent-position inflow. Old wallet-delta inflates,
//       new notify path reports the honest ledger figure. ──────────────
check("concurrent-position scenario: notify != inflated wallet-delta, == ledger", () => {
  // This trade (Bullscan): deployed 0.10, honestly returned ~0.0916 → -8.43%.
  const deployed = 0.10;
  const ledgerDelta = -0.00843;

  // Wallet snapshots straddle the close. BUT a CONCURRENT position returned its
  // own 0.10 modal in the same window, so the wallet rose more than this trade
  // earned. before=0.20, after=0.20 - 0.10(deploy stays in LP? no: this close
  // returns ~0.0916) + 0.10(other position's returned modal) + tiny.
  //   after ≈ 0.20 + 0.0916 (this close back) + 0.10 (OTHER modal) = 0.3916
  const walletBefore = 0.20;
  const walletAfter = 0.3916;

  // OLD (buggy) wallet-delta = (after - before) - deployed
  const oldWalletDelta = computeLiveRealizedSolDelta({
    walletSolBefore: walletBefore,
    walletSolAfter: walletAfter,
    solDeployed: deployed,
  });
  // The old method reports a big FAKE gain (~+91.6%) because it swallowed the
  // other position's returned modal.
  assert.equal(oldWalletDelta.method, "wallet_delta");
  assert.ok(oldWalletDelta.realized_sol_delta_pct > 50,
    `old wallet-delta should be fake-inflated (>50%), got ${oldWalletDelta.realized_sol_delta_pct}`);

  // NEW notify path ignores the wallet entirely and reports the ledger figure.
  const result = {
    pnl_pct: 5.0,
    ledger_realized_sol_delta: ledgerDelta,
    ledger_realized_sol_delta_pct: -8.43,
    ledger_realized_sol_method: "formula",
    ledger_realized_sol_estimate: true,
  };
  const notif = selectNotifyRealizedSol(result);
  assert.equal(notif.realized_sol_delta, ledgerDelta, "notif must equal ledger, NOT wallet-delta");
  assert.notEqual(notif.realized_sol_delta, oldWalletDelta.realized_sol_delta,
    "notif must NOT equal the inflated wallet-delta");
  assert.ok(notif.realized_sol_delta_pct < 0, "honest loss preserved (negative), not fake +91%");
});

// ── 3. anti-pattern #2: missing ledger figure → honest null ───────────
check("missing ledger figure → honest null (no fabrication, no wallet fallback)", () => {
  const notif = selectNotifyRealizedSol({ pnl_pct: 7.0 }); // no ledger_* fields
  assert.equal(notif.realized_sol_delta, null);
  assert.equal(notif.realized_sol_delta_pct, null);
  assert.equal(notif.realized_sol_method, "unavailable");
  assert.equal(notif.realized_sol_estimate, true);
});

check("explicit null ledger delta → honest null (not 0, not wallet)", () => {
  const notif = selectNotifyRealizedSol({
    ledger_realized_sol_delta: null,
    ledger_realized_sol_delta_pct: null,
  });
  assert.equal(notif.realized_sol_delta, null);
  assert.equal(notif.realized_sol_method, "unavailable");
});

check("a genuine total wipe (ledger says -100%) is passed through, not nulled", () => {
  const notif = selectNotifyRealizedSol({
    ledger_realized_sol_delta: -0.10,
    ledger_realized_sol_delta_pct: -100,
    ledger_realized_sol_method: "formula",
    ledger_realized_sol_estimate: true,
  });
  assert.equal(notif.realized_sol_delta_pct, -100, "honest wipe must surface");
});

// ── 4. deploy-gas visibility: rolling daily aggregate ─────────────────
check("deploy-gas ledger records an estimate + exposes a daily aggregate", () => {
  __resetDeployGasLedgerForTest();
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  // 14 deploys today, 1 tx each → ~0.042 SOL/day (the invisible tuition).
  for (let i = 0; i < 14; i++) {
    recordDeployGas(DEFAULT_DEPLOY_GAS_SOL * 1, now - i * 60_000);
  }
  const daily = getDeployGasDailySol(now);
  assert.ok(Math.abs(daily - 14 * DEFAULT_DEPLOY_GAS_SOL) < 1e-9,
    `expected ${14 * DEFAULT_DEPLOY_GAS_SOL}, got ${daily}`);
  assert.equal(getDeployGasCount(now), 14);
  assert.ok(daily > 0.04, `daily deploy gas should be visible (~0.042), got ${daily}`);
});

check("multi-tx deploy multiplies the estimate", () => {
  __resetDeployGasLedgerForTest();
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  recordDeployGas(DEFAULT_DEPLOY_GAS_SOL * 2, now); // a 2-tx wide-range open
  assert.ok(Math.abs(getDeployGasDailySol(now) - 2 * DEFAULT_DEPLOY_GAS_SOL) < 1e-9);
});

check("stale (>24h) deploy-gas is pruned from the rolling total", () => {
  __resetDeployGasLedgerForTest();
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  recordDeployGas(DEFAULT_DEPLOY_GAS_SOL, now - 25 * 60 * 60 * 1000); // yesterday+
  recordDeployGas(DEFAULT_DEPLOY_GAS_SOL, now - 60_000); // in window
  const daily = getDeployGasDailySol(now);
  assert.ok(Math.abs(daily - DEFAULT_DEPLOY_GAS_SOL) < 1e-9,
    `only the in-window deploy should count, got ${daily}`);
  assert.equal(getDeployGasCount(now), 1);
});

check("anti-pattern #2: garbage gas inputs are dropped, never coerced", () => {
  __resetDeployGasLedgerForTest();
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  recordDeployGas(0, now);
  recordDeployGas(-1, now);
  recordDeployGas("x", now);
  recordDeployGas(null, now);
  assert.equal(getDeployGasTotalSol(now), 0);
  assert.equal(__getDeployGasLedgerForTest().length, 0);
});

console.log(`\nAll ${assertions} assertions passed.`);
