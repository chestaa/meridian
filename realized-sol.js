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

export const LAMPORTS_PER_SOL_ACC = 1_000_000_000;

/**
 * Vega close-formula accuracy fix (2026-07-11 — Draco on-chain reconcile):
 * sum the ACTUAL per-transaction fee lamports of a close sequence into SOL, so the
 * realized-SOL formula can subtract MEASURED close gas instead of the flat
 * `DEFAULT_CLOSE_GAS_SOL` estimate.
 *
 * ROOT CAUSE this addresses: the flat estimate 0.00203928 SOL/close was set
 * conservatively HIGH; real burner close gas averaged lower, so the formula
 * over-deducted ~0.00067 SOL/trade → over 12 trades it OVERSTATED loss by ~0.008
 * SOL (formula −0.027 vs on-chain −0.019). Rent nets out on both sides (paid at
 * open, refunded at close — see computeLiveRealizedSolDelta docs), so gas was the
 * only mis-calibrated term. Measuring the real tx fees removes the estimate error.
 *
 * HONESTY RULE (anti-pattern #2 — never flatter): returns null unless EVERY entry
 * is a finite, non-negative fee. A PARTIAL sum (some tx fees unreadable) would
 * UNDER-count gas → understate loss → a flattering bias; the caller must instead
 * fall back to the CONSERVATIVE flat estimate. So this fn only yields a number
 * when the full close-gas is known; otherwise null (fall back, never guess low).
 *
 * Pure. No I/O. The getTransaction reads that produce `feeLamportsList` live in
 * the caller (dlmm.js), keeping this module I/O-free and unit-testable.
 *
 * @param {Array<number|string|null>} feeLamportsList per-tx meta.fee, in lamports
 * @returns {number|null} total close gas in SOL, or null if any leg is unreadable
 */
export function sumCloseGasSolFromFees(feeLamportsList) {
  if (!Array.isArray(feeLamportsList) || feeLamportsList.length === 0) return null;
  let totalLamports = 0;
  for (const raw of feeLamportsList) {
    // Explicit missing-leg guard FIRST: Number(null)===0 and Number('')===0 would
    // silently pass the finite/non-negative check and book the unreadable leg as
    // 0 gas → UNDER-count gas → flatter the loss (anti-pattern #2 fail-open). A
    // missing/blank leg means the fee is unreadable → fail-closed to null so the
    // caller uses the conservative flat estimate, never guesses low.
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    // Any non-finite/negative leg → cannot honestly total → null (caller falls
    // back to the conservative flat estimate, never under-counts gas).
    if (!Number.isFinite(n) || n < 0) return null;
    totalLamports += n;
  }
  return round8(totalLamports / LAMPORTS_PER_SOL_ACC);
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * STRICT coercion (Vega 2026-07-14, [[vega-entry-features-null-not-zero]] discipline):
 * unlike finiteOrNull, this does NOT fall into the `Number(null)===0` /
 * `Number('')===0` trap — a genuinely-missing value stays null instead of being
 * fabricated as a finite 0. Used by the two-sided realized-SOL accounting where a
 * missing leg (null) MUST be distinguished from an empty-but-real leg (0): a null
 * proceeds = STRANDED/unverifiable → honest null; a 0 proceeds = empty bag = valid.
 */
function strictFiniteOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return null;
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

/**
 * Compute realized SOL delta for a LIVE TWO-SIDED close (Vega 2026-07-14).
 *
 * A two-sided position holds a FULL token-X leg (a real bag, NOT the small
 * base-FEE remainder a single-side close produces). At close the SDK withdraws
 * both legs to the wallet; the token-X bag is then swapped → SOL. This function
 * computes the HONEST wallet-to-wallet economic delta of the whole round trip.
 *
 * GROUND TRUTH (denominated in SOL, mirrors the single-side `received + fees −
 * deployed − gas`, extended to two legs on each side):
 *
 *   solIn  = entryYLegSol + entryXLegSol        (total SOL OUT of wallet at entry)
 *   solOut = yLegExitSol + tokenXSwapOutSol + feesClaimedSol   (total SOL back)
 *   realized_sol_delta = solOut − solIn − closeGas
 *
 * WHY the entry-swap-cost AND close-swap-cost are NOT subtracted as separate
 * terms (avoiding a DOUBLE-COUNT):
 *   - `entryXLegSol` is the PRE-SWAP SOL BUDGET actually spent acquiring the
 *     token-X leg (= notional.total − y_leg = SOL that left the wallet). The SOL
 *     lost to ENTRY-swap slippage is therefore already inside solIn, and it
 *     re-surfaces as a lower `tokenXSwapOutSol` at close — subtracting an entry
 *     swap cost again would double-count it.
 *   - `tokenXSwapOutSol` is the ACTUAL post-slippage SOL proceeds of the CLOSE
 *     swap (task: "Token-X valued at ACTUAL swap-out proceeds, NOT a mark"), so
 *     the close-swap cost is likewise already embedded.
 *   `entrySwapCostSol` is accepted only as a DIAGNOSTIC field (reconciles with
 *   Andromeda's live monitor drag, state.computeTwoSidedLivePnl) — reported,
 *   never re-subtracted.
 *
 * FAIL-CLOSED (anti-pattern #2 — never fabricate, never mark):
 *   - basis (entryYLegSol/entryXLegSol) missing/negative or solIn<=0 → null.
 *   - yLegExitSol missing → null (two_sided_unverifiable_y_leg).
 *   - tokenXSwapOutSol === null (swap failed / STRANDED bag) → null
 *     (two_sided_unverifiable_x_leg). We NEVER value a stranded bag at a mark;
 *     an un-liquidated leg is an honest gap, not a number.
 *
 * Pure. No I/O. The wallet read + swap that produce these actuals live in the
 * caller (dlmm.js executeTwoSidedCloseSwapAndAccount).
 *
 * @returns {{ realized_sol_delta:number|null, realized_sol_delta_pct:number|null,
 *             method:string, estimate:boolean, sol_deployed:number|null, ... }}
 */
export function computeTwoSidedRealizedSolDelta({
  entryYLegSol,
  entryXLegSol,
  yLegExitSol,
  tokenXSwapOutSol,
  feesClaimedSol,
  gasSpentSol,
  entrySwapCostSol,
} = {}) {
  const yIn = strictFiniteOrNull(entryYLegSol);
  const xIn = strictFiniteOrNull(entryXLegSol);
  if (yIn == null || xIn == null || yIn < 0 || xIn < 0) {
    return {
      realized_sol_delta: null,
      realized_sol_delta_pct: null,
      method: "two_sided_unverifiable_basis",
      estimate: true,
      sol_deployed: null,
      two_sided: true,
    };
  }
  const solIn = yIn + xIn;
  if (solIn <= 0) {
    return {
      realized_sol_delta: null,
      realized_sol_delta_pct: null,
      method: "two_sided_unverifiable_basis",
      estimate: true,
      sol_deployed: round8(solIn),
      two_sided: true,
    };
  }

  const yOut = strictFiniteOrNull(yLegExitSol);
  // tokenXSwapOutSol === null means the close swap failed / the bag is STRANDED:
  // an un-liquidated leg cannot be honestly valued → null (never a mark). A
  // genuine 0 (no token-X bag — fully converted in-pool, already in yLegExitSol)
  // is a VALID number and passes (strictFiniteOrNull keeps 0 as 0, null as null).
  const xOut = strictFiniteOrNull(tokenXSwapOutSol);
  if (yOut == null || xOut == null) {
    return {
      realized_sol_delta: null,
      realized_sol_delta_pct: null,
      method: yOut == null ? "two_sided_unverifiable_y_leg" : "two_sided_unverifiable_x_leg",
      estimate: true,
      sol_deployed: round8(solIn),
      two_sided: true,
    };
  }

  const fees = strictFiniteOrNull(feesClaimedSol) ?? 0;
  const gas = strictFiniteOrNull(gasSpentSol) ?? DEFAULT_CLOSE_GAS_SOL;
  const solOut = yOut + xOut + fees;
  const delta = round8(solOut - solIn - gas);
  return {
    realized_sol_delta: delta,
    realized_sol_delta_pct: round2((delta / solIn) * 100),
    method: "two_sided_formula",
    estimate: true,
    sol_deployed: round8(solIn),
    // diagnostics (embedded in the actuals above — reported, not re-subtracted)
    y_leg_exit_sol: round8(yOut),
    token_x_swap_out_sol: round8(xOut),
    fees_claimed_sol: round8(fees),
    entry_swap_cost_sol: strictFiniteOrNull(entrySwapCostSol),
    two_sided: true,
  };
}

function round8(n) {
  return Number.isFinite(n) ? Number(n.toFixed(8)) : null;
}

function round2(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}
