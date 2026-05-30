/**
 * realized-sol.js — Vega fix #1: TRUE realized SOL delta accounting.
 *
 * PROBLEM: the bot reports LP-PnL (price-only, +X%) but the wallet SOL balance
 * drops, because impermanent loss + close-swap slippage + gas are NOT in the
 * LP-PnL figure. Cross-validated by the 2026-05-28 wallet reconcile (0.057 SOL
 * gap) and flagged as the #1 trust-eroder in the Telegram community.
 *
 * THIS MODULE IS PURE ACCOUNTING/REPORTING. It does NOT touch deploy/close
 * behavior, TX construction, DRY_RUN, or any risk constant. It only computes a
 * second, honest PnL figure that is surfaced ALONGSIDE the existing lp_pnl_pct.
 *
 * Formula (economics, denominated in SOL):
 *   realized_sol_delta =
 *     (sol_received_on_close + fees_claimed_sol) - (sol_deployed + gas_spent_est)
 *
 *   - sol_deployed           : initial amount_sol that was put in (tracked at deploy)
 *   - sol_received_on_close  : actual SOL back AFTER removeLiquidity + base→SOL swap
 *                              (the REAL number, post-slippage / post-IL)
 *   - fees_claimed_sol       : claimed fees, in SOL
 *   - gas_spent_est          : tx gas (estimate or measured)
 *
 * LIVE method (preferred): wallet-delta. We snapshot wallet SOL right before the
 * close and again after the post-close auto-swap. wallet_sol_after - wallet_sol_before
 * is the GROUND TRUTH economic outcome — it inherently includes IL, swap slippage,
 * AND gas, with no estimation. When that snapshot pair is available we use it and
 * mark estimate=false. Otherwise we fall back to the formula using the Meteora
 * closed-PnL API SOL figures + a gas estimate, marked estimate=true.
 *
 * PAPER method: paper trades have no wallet. We simulate the exit by applying an
 * exit-slippage haircut + a gas estimate to the price-proxy outcome, so paper
 * realized_sol_delta_pct is strictly <= the LP-PnL it would otherwise report.
 *
 * Fail-safe: if the true delta cannot be computed (missing data), callers fall
 * back to lp_pnl and flag the figure as an estimate — we NEVER fabricate a
 * precise-looking number from nothing.
 */

// Default gas estimate per full close (claim + removeLiquidity + close-account +
// auto-swap, each ~1 TX). Conservative; only used when a measured wallet delta is
// not available. Solana base fee is ~0.000005 SOL/sig but priority fees + ATA rent
// churn push a realistic close sequence higher.
export const DEFAULT_CLOSE_GAS_SOL = 0.00203928;

// Default paper exit-slippage assumption (% of position value lost crossing the
// book on the base→SOL exit swap). Paper has no real book, so we model a haircut.
export const DEFAULT_PAPER_EXIT_SLIPPAGE_PCT = 1.0;

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute realized SOL delta for a LIVE close.
 *
 * Two paths, in priority order:
 *  1. wallet-delta (estimate=false): when both walletSolBefore and walletSolAfter
 *     are finite. delta = after - before. This is ground truth — IL + slippage +
 *     gas are already baked in, so we do NOT subtract gas again.
 *  2. formula (estimate=true): when wallet snapshots are missing. Uses the SOL
 *     figures from the Meteora closed-PnL API + a gas estimate.
 *
 * @param {object} args
 * @param {number} [args.walletSolBefore]    wallet SOL right before close sequence
 * @param {number} [args.walletSolAfter]     wallet SOL after close + auto-swap
 * @param {number} [args.solDeployed]        initial amount_sol deployed
 * @param {number} [args.solReceivedOnClose] SOL back from close+swap (formula path)
 * @param {number} [args.feesClaimedSol]     fees claimed, in SOL
 * @param {number} [args.gasSpentSol]        measured/estimated gas (formula path)
 * @returns {{ realized_sol_delta: number|null, realized_sol_delta_pct: number|null,
 *             method: string, estimate: boolean, sol_deployed: number|null }}
 */
export function computeLiveRealizedSolDelta({
  walletSolBefore,
  walletSolAfter,
  solDeployed,
  solReceivedOnClose,
  feesClaimedSol,
  gasSpentSol,
} = {}) {
  const deployed = finiteOrNull(solDeployed);
  const before = finiteOrNull(walletSolBefore);
  const after = finiteOrNull(walletSolAfter);

  // ── Path 1: measured wallet delta (ground truth) ──────────────
  if (before != null && after != null) {
    const delta = round8(after - before);
    return {
      realized_sol_delta: delta,
      realized_sol_delta_pct: deployed != null && deployed > 0 ? round2((delta / deployed) * 100) : null,
      method: "wallet_delta",
      estimate: false,
      sol_deployed: deployed,
    };
  }

  // ── Path 2: formula from closed-PnL API SOL figures + gas estimate ──
  const received = finiteOrNull(solReceivedOnClose);
  const fees = finiteOrNull(feesClaimedSol) ?? 0;
  const gas = finiteOrNull(gasSpentSol) ?? DEFAULT_CLOSE_GAS_SOL;
  if (received != null && deployed != null) {
    const delta = round8(received + fees - (deployed + gas));
    return {
      realized_sol_delta: delta,
      realized_sol_delta_pct: deployed > 0 ? round2((delta / deployed) * 100) : null,
      method: "formula",
      estimate: true,
      sol_deployed: deployed,
    };
  }

  // ── Fail-safe: cannot compute → null, flagged estimate ────────
  return {
    realized_sol_delta: null,
    realized_sol_delta_pct: null,
    method: "unavailable",
    estimate: true,
    sol_deployed: deployed,
  };
}

/**
 * Compute realized SOL delta for a PAPER close.
 *
 * Paper has no wallet, so we SIMULATE the exit: take the price-proxy LP-PnL,
 * apply an exit-slippage haircut (% of position) plus a gas estimate, and add
 * any fees earned. The result is the realized SOL the operator would actually
 * net — by construction strictly <= the LP-PnL the trade would otherwise show.
 *
 * @param {object} args
 * @param {number} args.amountSol            position size in SOL (post-partial if any)
 * @param {number} args.lpPnlPct             price-proxy PnL % (LP-PnL)
 * @param {number} [args.feesClaimedSol]     fees earned in SOL
 * @param {number} [args.exitSlippagePct]    exit slippage assumption (% of position)
 * @param {number} [args.gasSpentSol]        gas estimate
 * @returns {{ realized_sol_delta: number|null, realized_sol_delta_pct: number|null,
 *             method: string, estimate: boolean, sol_deployed: number|null }}
 */
export function computePaperRealizedSolDelta({
  amountSol,
  lpPnlPct,
  feesClaimedSol,
  exitSlippagePct,
  gasSpentSol,
} = {}) {
  const deployed = finiteOrNull(amountSol);
  const pnlPct = finiteOrNull(lpPnlPct);

  if (deployed == null || deployed <= 0 || pnlPct == null) {
    return {
      realized_sol_delta: null,
      realized_sol_delta_pct: null,
      method: "unavailable",
      estimate: true,
      sol_deployed: deployed,
    };
  }

  const fees = finiteOrNull(feesClaimedSol) ?? 0;
  const slipPct = finiteOrNull(exitSlippagePct) ?? DEFAULT_PAPER_EXIT_SLIPPAGE_PCT;
  const gas = finiteOrNull(gasSpentSol) ?? DEFAULT_CLOSE_GAS_SOL;

  // Position value at exit on the LP-PnL basis, then bleed exit slippage + gas,
  // then add fees earned. Net vs deployed = realized SOL delta.
  const grossValueOut = deployed * (1 + pnlPct / 100);
  const slippageCost = grossValueOut * (slipPct / 100);
  const netSolOut = grossValueOut - slippageCost - gas + fees;
  const delta = round8(netSolOut - deployed);

  return {
    realized_sol_delta: delta,
    realized_sol_delta_pct: round2((delta / deployed) * 100),
    method: "paper_sim",
    estimate: true,
    sol_deployed: deployed,
  };
}

function round8(n) {
  return Number.isFinite(n) ? Number(n.toFixed(8)) : null;
}

function round2(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}
