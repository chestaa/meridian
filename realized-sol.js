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
 * close and again after the post-close auto-swap.
 *
 *   ⚠️ BUG FIXED (Vega 2026-06-21 honesty audit): the pre-close wallet does NOT
 *   contain the deployed modal — it is locked in the LP position. The close RETURNS
 *   that modal to the wallet. So `wallet_after - wallet_before` ≈
 *   (modal_returned + fees - gas), which COUNTS THE RETURNED MODAL AS PROFIT. A
 *   break-even trade then reads ≈ +100% (glippy "+103%" while actually -7%). The
 *   true economic delta is the change RELATIVE TO THE MODAL THAT WENT IN:
 *
 *       realized_sol_delta = (wallet_after - wallet_before) - sol_deployed
 *                          = (modal_returned + fees - gas) - modal_deployed
 *
 *   This is now IDENTICAL in meaning to the formula path (received + fees -
 *   deployed - gas) — both measure SOL-out-net vs SOL-in. The wallet path stays
 *   preferred because the measured `wallet_after - wallet_before` already bakes in
 *   IL + slippage + gas with no estimation; we mark estimate=false. Requires
 *   sol_deployed to be known — if it is missing we CANNOT honestly net the modal,
 *   so we fall through to the formula path rather than report a modal-inflated %.
 *
 * Otherwise we fall back to the formula using the Meteora closed-PnL API SOL
 * figures + a gas estimate, marked estimate=true.
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
 *  1. wallet-delta (estimate=false): when walletSolBefore, walletSolAfter AND
 *     solDeployed are all finite. delta = (after - before) - deployed. The wallet
 *     gain (after - before) is the modal returned + fees - gas; subtracting the
 *     deployed modal yields the TRUE economic delta. IL + slippage + gas are
 *     already baked into the measured wallet movement, so we do NOT subtract gas
 *     again. Requires deployed (else we cannot net the modal — fall through).
 *  2. formula (estimate=true): when the wallet path is unavailable. Uses the SOL
 *     figures from the Meteora closed-PnL API + a gas estimate.
 *
 * @param {object} args
 * @param {number} [args.walletSolBefore]    wallet SOL right before close sequence
 * @param {number} [args.walletSolAfter]     wallet SOL after close + auto-swap
 * @param {number} [args.solDeployed]        initial amount_sol deployed
 * @param {number} [args.solReceivedOnClose] SOL back from close+swap (formula path)
 * @param {number} [args.feesClaimedSol]     fees claimed, in SOL
 * @param {number} [args.gasSpentSol]        measured/estimated gas (formula path)
 * @param {number} [args.finalValueUsd]      USD value withdrawn at close (economics
 *                                           cross-check — used ONLY to refuse a
 *                                           fabricated ~-100% catastrophe)
 * @param {number} [args.pnlPct]             closed-PnL % from the API (economics
 *                                           cross-check — same purpose)
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
  finalValueUsd,
  pnlPct,
} = {}) {
  const deployed = finiteOrNull(solDeployed);
  const before = finiteOrNull(walletSolBefore);
  const after = finiteOrNull(walletSolAfter);

  // ── Path 1: measured wallet delta (ground truth) ──────────────
  // (after - before) = modal returned + fees - gas. We MUST subtract the deployed
  // modal to get the true economic delta — otherwise the returned modal is counted
  // as profit (the +100%-on-breakeven bug). Requires a known deployed; without it
  // we cannot net the modal honestly, so fall through to the formula path.
  if (before != null && after != null && deployed != null && deployed > 0) {
    const delta = round8((after - before) - deployed);
    return {
      realized_sol_delta: delta,
      realized_sol_delta_pct: round2((delta / deployed) * 100),
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
    // HONESTY GUARD (Vega 2026-06-23): a PRESENT-but-ZERO SOL withdrawal
    // (received === 0, fees 0) makes the formula read delta ≈ -(deployed + gas)
    // ≈ -1× deploy ≈ -100% — a fabricated total wipe. But the Meteora SOL field
    // is frequently zero/absent on a settling record even when the trade did NOT
    // wipe. If the USD economics CONTRADICT a wipe (finalValueUsd > 0, i.e. SOL
    // came back; or pnlPct > -90, i.e. not a near-total loss), refuse the
    // catastrophic figure and fail toward UNKNOWN (null) — an honest gap, never a
    // fabricated -100%. We only let a true wipe through when USD agrees it wiped.
    const usdValueOut = finiteOrNull(finalValueUsd);
    const closedPnlPct = finiteOrNull(pnlPct);
    const noSolBack = received === 0 && fees === 0;
    const usdSaysNotWiped = (usdValueOut != null && usdValueOut > 0) ||
                            (closedPnlPct != null && closedPnlPct > -90);
    if (noSolBack && usdSaysNotWiped) {
      return {
        realized_sol_delta: null,
        realized_sol_delta_pct: null,
        method: "unavailable_zero_sol_usd_disagree",
        estimate: true,
        sol_deployed: deployed,
      };
    }
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
 * NOTIFY single source of truth (Vega 2026-07-11).
 *
 * Given a close result that carries the LEDGER figures dlmm.js already computed
 * (the per-trade-attributed formula path — `received + fees - deployed - gas` —
 * which is the EXACT number written into lessons.json), return the fields to
 * surface in the Telegram notif AND the LLM `result`. Both must report the SAME
 * number the ledger records.
 *
 * This DELIBERATELY does NOT use any wallet-delta method. Lyra forensic
 * (2026-07-11): under maxPositions>1, the wallet snapshot `(after - before)` is
 * corrupted by a CONCURRENT position's returned modal (e.g. another trade's 0.10
 * SOL lands in the same wallet between the two reads and is miscounted as THIS
 * trade's profit → fake "+55%"). Wallet-delta is unfixable without per-trade
 * wallet attribution, and the formula path ALREADY does that attribution
 * correctly — so we use the ledger figure everywhere and notif == ledger by
 * construction.
 *
 * Anti-pattern #2 (never fabricate): if the ledger figure is missing, return an
 * honest null — NEVER fall back to the broken wallet-delta.
 *
 * Pure. No I/O, no wallet read.
 *
 * @param {object} result close-position result carrying ledger_realized_sol_*
 * @returns {{ realized_sol_delta: number|null, realized_sol_delta_pct: number|null,
 *             realized_sol_method: string|null, realized_sol_estimate: boolean|null }}
 */
export function selectNotifyRealizedSol(result = {}) {
  if (result && result.ledger_realized_sol_delta != null) {
    return {
      realized_sol_delta: result.ledger_realized_sol_delta,
      realized_sol_delta_pct: result.ledger_realized_sol_delta_pct ?? null,
      realized_sol_method: result.ledger_realized_sol_method ?? null,
      realized_sol_estimate: result.ledger_realized_sol_estimate ?? null,
    };
  }
  return {
    realized_sol_delta: null,
    realized_sol_delta_pct: null,
    realized_sol_method: "unavailable",
    realized_sol_estimate: true,
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
