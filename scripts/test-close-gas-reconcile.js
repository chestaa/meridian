// scripts/test-close-gas-reconcile.js
// Vega close-formula ACCURACY fix (2026-07-11, Draco on-chain reconcile).
//
// PROBLEM (Draco): lessons.json realized_sol_delta (formula:
//   received + fees - deployed - gas) OVERSTATED loss by ~0.008 SOL over 12 trades
//   — formula summed to -0.027 while the on-chain truth was -0.019.
//
// ROOT CAUSE: the flat close-gas estimate DEFAULT_CLOSE_GAS_SOL (0.00203928) was
//   set conservatively HIGH. Real burner close gas averaged lower, so the formula
//   over-deducted ~0.00067 SOL/trade → 12 × that ≈ 0.008 SOL of phantom loss.
//   Rent NETS OUT (paid at open, refunded at close) so it never entered the
//   formula — it is returned capital, not profit, and must never be credited as
//   profit. So gas was the ONLY mis-calibrated term.
//
// FIX: measure ACTUAL close gas from the confirmed close-tx fees (getTransaction
//   meta.fee, summed by the pure reducer sumCloseGasSolFromFees) and thread it as
//   gasSpentSol. The formula then subtracts real gas → per-trade realized matches
//   on-chain reality. FAIL-SAFE: unreadable fee → null → fall back to the flat
//   conservative estimate (never under-count gas = never flatter the loss).
//
// This test:
//   1. Unit-tests the pure reducer (sum, fail-safe on any bad leg, empty → null).
//   2. Reproduces Draco's reported AGGREGATE on a structural 12-trade fixture:
//      OLD (flat gas) sums to -0.027; NEW (measured gas) reconciles to -0.019;
//      the correction equals the gas over-estimate (~0.008).
//      NOTE: the fixture is SYNTHETIC — it carries the SAME aggregate signature
//      Draco measured, to prove the fix MECHANISM closes the reported gap. The
//      authoritative per-trade validation is Draco's on-chain reconcile against
//      the production lessons.json (VPS); those raw rows are not in the repo.
//   3. Confirms Item 2: entry_features is forwarded at BOTH recordPerformance
//      sites in dlmm.js (owner-side defense-in-depth).
//
// Pure accounting — no on-chain calls, no DRY_RUN toggle, no risk constant touched.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  computeLiveRealizedSolDelta,
  sumCloseGasSolFromFees,
  DEFAULT_CLOSE_GAS_SOL,
  LAMPORTS_PER_SOL_ACC,
} = await import("../realized-sol.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

console.log("Vega close-formula accuracy — measured-gas reconciliation\n");

// ── 1. Pure reducer: sums lamport fees → SOL ───────────────────────
check("reducer: sums multi-tx close fees to SOL", () => {
  // 3-tx close: claim + remove/close + swap = 1,370,000 lamports = 0.00137 SOL
  const sol = sumCloseGasSolFromFees([420000, 500000, 450000]);
  assert.ok(Math.abs(sol - 0.00137) < 1e-9, `expected 0.00137, got ${sol}`);
});
check("reducer: single-tx fee", () => {
  assert.equal(sumCloseGasSolFromFees([5000]), Number((5000 / LAMPORTS_PER_SOL_ACC).toFixed(8)));
});

// ── 1b. Reducer fail-safe (anti-pattern #2 — never under-count) ────
check("reducer: any non-finite leg → null (fall back to flat estimate, never partial)", () => {
  assert.equal(sumCloseGasSolFromFees([420000, null, 450000]), null);
  assert.equal(sumCloseGasSolFromFees([420000, undefined]), null);
  assert.equal(sumCloseGasSolFromFees([420000, NaN]), null);
});
check("reducer: negative leg → null", () => {
  assert.equal(sumCloseGasSolFromFees([420000, -1]), null);
});
check("reducer: empty / non-array → null", () => {
  assert.equal(sumCloseGasSolFromFees([]), null);
  assert.equal(sumCloseGasSolFromFees(null), null);
  assert.equal(sumCloseGasSolFromFees("500000"), null);
});

// ── 2. AGGREGATE RECONCILIATION — reproduce Draco's -0.027 vs -0.019 ─────────
// SYNTHETIC 12-trade fixture (see header). Each trade: deployed 0.10 SOL (data-mode
// size), a small pre-gas economic delta, and a real close-gas of 1,370,000 lamports
// (= 0.00137 SOL, split across a realistic 3-tx close sequence).
//   old (flat gas 0.00203928): each = -0.00225      → Σ12 = -0.027  (formula)
//   new (measured gas 0.00137): each = -0.00158072   → Σ12 ≈ -0.019 (on-chain)
const TRADES = Array.from({ length: 12 }, () => ({
  solDeployed: 0.10,
  // received back so the PRE-GAS delta is -0.00021072 SOL/trade
  solReceivedOnClose: 0.09978928,
  feesClaimedSol: 0,
  closeTxFeesLamports: [420000, 500000, 450000], // sums to 0.00137 SOL
}));

function sumRealized(trades, { useMeasuredGas }) {
  let total = 0;
  for (const t of trades) {
    const measured = useMeasuredGas ? sumCloseGasSolFromFees(t.closeTxFeesLamports) : undefined;
    const r = computeLiveRealizedSolDelta({
      solDeployed: t.solDeployed,
      solReceivedOnClose: t.solReceivedOnClose,
      feesClaimedSol: t.feesClaimedSol,
      gasSpentSol: Number.isFinite(measured) ? measured : undefined,
    });
    assert.equal(r.method, "formula", "formula path expected for this fixture");
    total += r.realized_sol_delta;
  }
  return Number(total.toFixed(8));
}

const oldSum = sumRealized(TRADES, { useMeasuredGas: false }); // flat DEFAULT_CLOSE_GAS_SOL
const newSum = sumRealized(TRADES, { useMeasuredGas: true });  // measured real gas

check("OLD flat-gas formula reproduces the reported -0.027 overstatement", () => {
  assert.ok(Math.abs(oldSum - (-0.027)) < 5e-4, `expected ≈ -0.027, got ${oldSum}`);
});
check("NEW measured-gas formula reconciles to the on-chain -0.019", () => {
  assert.ok(Math.abs(newSum - (-0.019)) < 5e-4, `expected ≈ -0.019, got ${newSum}`);
});
check("correction == the gas over-estimate (~0.008), loss is LESS after fix", () => {
  const correction = Number((newSum - oldSum).toFixed(8));
  assert.ok(correction > 0, "measured gas < flat estimate → realized less negative");
  assert.ok(Math.abs(correction - 0.008) < 5e-4, `expected ≈ +0.008, got ${correction}`);
  // Mechanism identity: correction == 12 × (flat − measured) per-trade.
  const perTradeDiff = DEFAULT_CLOSE_GAS_SOL - 0.00137;
  assert.ok(Math.abs(correction - 12 * perTradeDiff) < 1e-6,
    "correction must equal 12 × (flat − measured) gas");
});

// ── 2b. Per-trade honesty: measured gas HIGHER than flat → MORE loss booked ─────
// The fix is not a blanket discount — on a high-priority-fee close where real gas
// EXCEEDS the flat estimate, the measured path books MORE loss (honest per-trade).
check("per-trade: real gas above flat estimate → realized MORE negative (honest)", () => {
  const deployed = 0.10, received = 0.10, fees = 0; // break-even pre-gas
  const flat = computeLiveRealizedSolDelta({ solDeployed: deployed, solReceivedOnClose: received, feesClaimedSol: fees });
  const bigGas = sumCloseGasSolFromFees([2_500_000, 900_000]); // 0.0034 SOL > flat 0.00203928
  const measured = computeLiveRealizedSolDelta({
    solDeployed: deployed, solReceivedOnClose: received, feesClaimedSol: fees, gasSpentSol: bigGas,
  });
  assert.ok(measured.realized_sol_delta < flat.realized_sol_delta,
    "higher measured gas → more negative realized than the flat estimate");
});

// ── 2c. Fallback preserves current behavior (measured unavailable) ──────────────
check("fallback: no measured gas → identical to the flat-estimate formula", () => {
  const a = computeLiveRealizedSolDelta({ solDeployed: 0.10, solReceivedOnClose: 0.099, feesClaimedSol: 0 });
  const b = computeLiveRealizedSolDelta({ solDeployed: 0.10, solReceivedOnClose: 0.099, feesClaimedSol: 0, gasSpentSol: undefined });
  assert.equal(a.realized_sol_delta, b.realized_sol_delta);
  assert.equal(a.method, "formula");
});

// ── 2d. RENT honesty: rent refund is NOT credited as profit ─────────────────────
// The formula uses deployed = LP modal only and received = LP withdrawal only.
// Rent (paid at open, refunded at close) is absent from BOTH → nets to zero. Prove
// that a break-even LP round-trip reads ~0 (minus gas) and does NOT gain ~+0.057
// SOL of phantom "profit" from the returned rent.
check("rent: break-even LP round-trip reads ~0 (returned rent NOT booked as profit)", () => {
  // deployed modal 0.10, LP value back 0.10 (break-even), no fees. Rent (~0.057)
  // is returned capital and is (correctly) NOT part of received/deployed here.
  const r = computeLiveRealizedSolDelta({
    solDeployed: 0.10, solReceivedOnClose: 0.10, feesClaimedSol: 0,
    gasSpentSol: sumCloseGasSolFromFees([420000, 500000, 450000]),
  });
  // Only gas is lost; NO +0.057 rent windfall.
  assert.ok(Math.abs(r.realized_sol_delta - (-0.00137)) < 1e-9,
    `break-even should read ≈ -gas (-0.00137), got ${r.realized_sol_delta}`);
  assert.ok(r.realized_sol_delta > -0.01 && r.realized_sol_delta < 0.001,
    "must NOT show a rent-inflated profit");
});

// ── 3. ITEM 2 — entry_features forwarded at BOTH recordPerformance sites ────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const dlmmSrc = readFileSync(join(__dirname, "..", "tools", "dlmm.js"), "utf8");
check("entry_features forwarded at BOTH recordPerformance sites (direct + relay)", () => {
  const matches = dlmmSrc.match(/entry_features:\s*tracked\.entry_features\s*\?\?\s*null/g) || [];
  assert.equal(matches.length, 2,
    `expected entry_features forward at both sites, found ${matches.length}`);
});
check("measured-gas wired into the direct close path", () => {
  assert.ok(dlmmSrc.includes("measureCloseGasSol(txHashes)"),
    "direct close path must thread measured close gas");
  assert.ok(/gasSpentSol:\s*Number\.isFinite\(measuredCloseGasSol\)/.test(dlmmSrc),
    "measured gas must be passed as gasSpentSol with a finite guard");
});

console.log(`\nALL ${assertions} ASSERTIONS PASS — close-gas reconciliation + entry_features verified`);
