// tools/two-sided.js
// ─────────────────────────────────────────────────────────────────────────────
// Vega 🔥 — Flag-gated TWO-SIDED LP path (PAPER-ONLY foundation).
//
// GOAL: enable two-sided (SOL + token) deposits that capture UPSIDE (the token
// leg appreciates on price-up), gated behind a flag AND restricted to
// DRY_RUN/paper simulation ONLY for this phase.
//
// SAFETY MODEL (two independent belts):
//   1. twoSidedEnabled  (default FALSE) — master flag. OFF ⇒ single-side only,
//      byte-for-byte unchanged (the refuse message is the ORIGINAL string).
//   2. twoSidedPaperOnly (default TRUE)  — hard paper belt. Even if
//      twoSidedEnabled is ON, a LIVE two-sided deploy is REFUSED unless
//      twoSidedPaperOnly is EXPLICITLY false (which we do NOT set this phase).
//
// This module is PURE (no I/O, no SDK, no tx) so it is trivially unit-testable
// and can be shared by dlmm.js (deploy money-path) and executor.js (pre-deploy
// safety check) without duplicating the gate logic.
//
// EVERYTHING here is fail-CLOSED (anti-pattern #2): a missing/non-finite input
// never fabricates a "safe" default — it refuses or returns null.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STRICT numeric coercion. Mirrors dlmm.buildEntryFeatures / screening.strictNumeric
 * discipline: `Number(null)===0`, `Number('')===0`, `Number(false)===0` are all
 * finite and would FABRICATE 0 for a genuinely-missing input. Only a real finite
 * number (or a non-empty numeric string) survives; everything else → null.
 */
export function strictNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Resolve the two-sided deploy mode from live config + the DRY_RUN env value.
 * PURE — the DRY_RUN value is passed in (never read from process here) so the
 * function is deterministic and testable.
 *
 * @param {object} cfg        the config object (reads cfg.strategy.twoSided*)
 * @param {string} dryRunEnv  the raw process.env.DRY_RUN value
 */
export function resolveTwoSidedMode(cfg, dryRunEnv) {
  const enabled = cfg?.strategy?.twoSidedEnabled === true;
  // paperOnly is a SAFETY belt — it is TRUE unless EXPLICITLY set to false.
  // Any other value (missing / null / undefined / true) → TRUE (fail-safe): you
  // cannot accidentally disable the paper belt by leaving the key unset.
  const paperOnly = cfg?.strategy?.twoSidedPaperOnly !== false;
  const isDry = dryRunEnv === "true";
  return {
    enabled,
    paperOnly,
    isDry,
    // Paper two-sided runs ONLY when the master flag is ON AND we are in dry-run.
    paperTwoSidedAllowed: enabled && isDry,
    // Live two-sided requires master flag ON, live mode, AND paperOnly EXPLICITLY
    // false. We never set paperOnly=false this phase → always false in practice.
    liveTwoSidedAllowed: enabled && !isDry && paperOnly === false,
  };
}

/**
 * The SINGLE authority deciding whether an `amount_x > 0` (two-sided) deploy is
 * permitted, and — when refused — exactly WHY. Both the executor pre-check and
 * the dlmm money-path call this so the gate logic lives in one place.
 *
 * Returns { allowed:boolean, mode:object, refuseReason:string|null }.
 *
 * Refusal precedence (all fail-CLOSED):
 *   - flag OFF                         → ORIGINAL single-side message (byte-unchanged)
 *   - flag ON + LIVE + paperOnly TRUE  → paper-only belt refusal
 *   - flag ON + LIVE + paperOnly FALSE → live-not-authorized refusal (still refused)
 *   - flag ON + DRY_RUN                → ALLOWED (paper two-sided)
 */
export function twoSidedGateDecision(cfg, dryRunEnv) {
  const mode = resolveTwoSidedMode(cfg, dryRunEnv);

  // Belt 1 — master flag OFF ⇒ single-side invariant, unchanged refusal string.
  if (!mode.enabled) {
    return {
      allowed: false,
      mode,
      refuseReason:
        "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
    };
  }

  // LIVE attempt with two-sided enabled — two INDEPENDENT belts refuse it.
  if (!mode.isDry) {
    // Belt 2 — twoSidedPaperOnly hard belt.
    if (mode.paperOnly) {
      return {
        allowed: false,
        mode,
        refuseReason:
          "Two-sided LIVE deploy REFUSED: twoSidedPaperOnly is enabled (paper simulation only). " +
          "Live two-sided is not authorized in this phase.",
      };
    }
    // Belt 3 — even with the paper belt lowered, the LIVE two-sided path is not
    // built/authorized. amount_x>0 remains paper-only for now. (Defence in depth.)
    return {
      allowed: false,
      mode,
      refuseReason:
        "Two-sided LIVE deploy path is not implemented/authorized. amount_x>0 is paper-simulation only in this phase.",
    };
  }

  // flag ON + DRY_RUN ⇒ paper two-sided permitted.
  return { allowed: true, mode, refuseReason: null };
}

/**
 * TRUE total exposure of a two-sided position, denominated in SOL:
 *   exposure = Y-leg SOL + (X-leg tokens valued at price SOL/token).
 *
 * This is the accounting GROUNDWORK for the eventual live cap — it is EXPOSED
 * and computed, but NOT wired to any live cap in this paper phase. When live
 * two-sided is later authorized, the per-position cap must bind against this
 * total (not just the SOL Y leg), else the token leg escapes the cap.
 *
 * FAIL-CLOSED (anti-pattern #2): any missing / non-finite / negative input → null.
 * A null here MUST be treated by a future live cap as "cannot verify exposure ⇒
 * refuse", never as zero exposure.
 */
export function computeTwoSidedNotionalSol({ amountYSol, amountXTokens, priceSolPerToken } = {}) {
  const y = strictNum(amountYSol);
  const xt = strictNum(amountXTokens);
  const px = strictNum(priceSolPerToken);
  if (y == null || xt == null || px == null) return null;
  if (y < 0 || xt < 0 || px < 0) return null;
  const xLegSol = xt * px;
  return {
    y_leg_sol: parseFloat(y.toFixed(9)),
    x_leg_sol: parseFloat(xLegSol.toFixed(9)),
    total_notional_sol: parseFloat((y + xLegSol).toFixed(9)),
  };
}

/**
 * Simulate the SOL→token entry swap for the X leg (PAPER — no on-chain tx).
 * Given the desired token-X amount and the active price, compute the SOL that
 * would be spent plus an estimated swap cost (slippage+fee in bps). Every field
 * is explicitly labelled an ESTIMATE / simulation.
 *
 * FAIL-CLOSED: bad token amount or price → null (cannot fabricate a fill).
 */
export function simulatePaperEntrySwap({ amountXTokens, priceSolPerToken, slippageBps } = {}) {
  const xt = strictNum(amountXTokens);
  const px = strictNum(priceSolPerToken);
  if (xt == null || px == null || xt < 0 || px < 0) return null;
  const bps = strictNum(slippageBps);
  const effBps = bps != null && bps >= 0 ? bps : 0;
  const solNotional = xt * px;
  const swapCostSol = solNotional * (effBps / 10000);
  return {
    simulated: true,
    token_x_out: xt,
    sol_in_notional: parseFloat(solNotional.toFixed(9)),
    est_swap_cost_sol: parseFloat(swapCostSol.toFixed(9)),
    sol_in_total_est: parseFloat((solNotional + swapCostSol).toFixed(9)),
    price_sol_per_token: px,
    slippage_bps: effBps,
    note: "PAPER simulation — no on-chain swap executed",
  };
}
