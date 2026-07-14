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

// ─────────────────────────────────────────────────────────────────────────────
// LIVE two-sided MACHINERY (Vega 🔥 — BUILT, NOT ENABLED).
//
// Everything below is the safety machinery the LIVE two-sided path will use once
// Bro gives the explicit final go. It is BUILT + UNIT-TESTED now, but the LIVE
// path stays HARD-REFUSED by the existing twoSidedGateDecision belts (paperOnly
// TRUE) PLUS the new inner belt liveTwoSidedFullyAuthorized (default FALSE).
// BUILD ≠ ENABLE. None of these relax any existing belt.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CODE-PINNED hard ceiling on TOTAL two-sided notional (Y-leg SOL + X-leg-in-SOL),
 * denominated in SOL. Burner-tiny Phase-1 live cap. Lives in CODE, not JSON — a
 * config/LLM value can tighten below this but can NEVER exceed it (anti-pattern #7).
 * This is a TOTAL-notional cap (both legs), NOT a per-leg cap: the token leg CANNOT
 * escape the ceiling by being denominated in tokens.
 */
export const MAX_TWO_SIDED_NOTIONAL_SOL = 0.1;

/** The canonical wSOL mint (the ONLY quote leg a SOL deposit is valid against). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Resolve the effective total-notional cap: min(code-pinned ceiling, config tunable).
 * FAIL-CLOSED: a missing / non-finite / non-positive config value falls back to the
 * code ceiling; the config can only ever TIGHTEN (min), never loosen.
 */
export function resolveTwoSidedNotionalCapSol(cfg) {
  const raw = strictNum(cfg?.strategy?.twoSidedNotionalCapSol);
  if (raw == null || raw <= 0) return MAX_TWO_SIDED_NOTIONAL_SOL;
  return Math.min(raw, MAX_TWO_SIDED_NOTIONAL_SOL);
}

/**
 * The FOURTH, INNERMOST belt authorizing a LIVE two-sided deposit. This is the
 * "explicit final go" gate — it is ADDITIONAL to (never replaces) the outer
 * twoSidedGateDecision belts. Requires ALL of:
 *   - twoSidedEnabled === true          (master flag)
 *   - LIVE (dryRunEnv !== "true")        (not paper)
 *   - twoSidedPaperOnly === false        (belt 2 explicitly lowered)
 *   - twoSidedLiveAuthorized === true    (belt 4 — NEW explicit final go)
 * Any missing/non-true value → false (fail-safe). We set NEITHER paperOnly=false
 * NOR twoSidedLiveAuthorized=true this phase → always false in practice.
 */
export function liveTwoSidedFullyAuthorized(cfg, dryRunEnv) {
  const enabled = cfg?.strategy?.twoSidedEnabled === true;
  const isDry = dryRunEnv === "true";
  const paperOnly = cfg?.strategy?.twoSidedPaperOnly !== false;
  const liveAuthorized = cfg?.strategy?.twoSidedLiveAuthorized === true;
  return enabled && !isDry && paperOnly === false && liveAuthorized === true;
}

/**
 * HARD total-notional cap assertion. Binds the TRUE two-leg exposure
 * (computeTwoSidedNotionalSol) against the effective cap BEFORE any real deposit.
 * The token leg is valued in SOL so it can NEVER escape the ceiling (anti-pattern #7).
 *
 * FAIL-CLOSED (anti-pattern #2): if the notional cannot be computed (any leg / price
 * missing or non-finite → computeTwoSidedNotionalSol returns null), we REFUSE with
 * "cannot verify exposure", never treat unverifiable exposure as zero. A non-finite
 * or non-positive cap also refuses.
 *
 * @returns {{ ok:boolean, reason:string|null, notional:object|null, capSol:number }}
 */
export function assertTwoSidedNotionalCap({ amountYSol, amountXTokens, priceSolPerToken, capSol } = {}) {
  const cap = strictNum(capSol);
  if (cap == null || cap <= 0) {
    return { ok: false, reason: "two_sided_notional_cap_invalid", notional: null, capSol: cap };
  }
  const notional = computeTwoSidedNotionalSol({ amountYSol, amountXTokens, priceSolPerToken });
  if (notional == null) {
    return {
      ok: false,
      reason: "two_sided_notional_unverifiable_refuse",
      notional: null,
      capSol: cap,
    };
  }
  if (notional.total_notional_sol > cap) {
    return {
      ok: false,
      reason: `two_sided_total_notional_${notional.total_notional_sol}_exceeds_cap_${cap}`,
      notional,
      capSol: cap,
    };
  }
  return { ok: true, reason: null, notional, capSol: cap };
}

/**
 * CHAIN-LEG assertion for a LIVE two-sided deposit. Confirms, from AUTHORITATIVE
 * on-chain mints (the caller reads pool.lbPair.token{X,Y}Mint), that:
 *   1. tokenY (quote leg) === wSOL   → SOL can only be deposited into the wSOL leg.
 *   2. baseMint (tokenX) is in the CURATED exempt set → only known-safe LST bases.
 *
 * The curated-base check is delegated to an injected predicate (`isBaseAllowed`,
 * e.g. screening.isLstMintFreezeExempt) so the curated set has a SINGLE source of
 * truth and this module stays dependency-free (no circular import).
 *
 * FAIL-CLOSED (anti-pattern #2): missing/empty mint, a non-function predicate, or a
 * predicate that throws → REFUSE. Never assume a leg is safe when it can't be verified.
 *
 * @returns {{ ok:boolean, reason:string|null }}
 */
export function assertTwoSidedChainLegs({ quoteMint, baseMint, wsolMint = WSOL_MINT, isBaseAllowed } = {}) {
  if (!quoteMint || typeof quoteMint !== "string") {
    return { ok: false, reason: "two_sided_quote_mint_missing" };
  }
  if (quoteMint !== wsolMint) {
    return { ok: false, reason: `two_sided_quote_not_wsol_${quoteMint}` };
  }
  if (!baseMint || typeof baseMint !== "string") {
    return { ok: false, reason: "two_sided_base_mint_missing" };
  }
  if (typeof isBaseAllowed !== "function") {
    return { ok: false, reason: "two_sided_base_predicate_missing" };
  }
  let allowed = false;
  try {
    allowed = isBaseAllowed(baseMint) === true;
  } catch {
    return { ok: false, reason: "two_sided_base_predicate_threw" };
  }
  if (!allowed) {
    return { ok: false, reason: `two_sided_base_not_curated_lst_${baseMint}` };
  }
  return { ok: true, reason: null };
}

/**
 * Split a TOTAL SOL budget into a two-sided entry plan: the SOL that stays as the
 * Y leg, the SOL routed through the entry swap for the X leg, and the resulting
 * token-X target. PURE — the caller feeds a total already <= the notional cap.
 *
 * FAIL-CLOSED: any bad input (non-finite total/price/share, share outside (0,1),
 * non-positive price) → null. Never fabricates a fill.
 *
 * @returns {{ y_leg_sol:number, x_leg_sol:number, token_x_target:number, x_share:number }|null}
 */
export function computeTwoSidedEntryPlan({ totalNotionalSol, xSharePct, priceSolPerToken } = {}) {
  const total = strictNum(totalNotionalSol);
  const share = strictNum(xSharePct);
  const px = strictNum(priceSolPerToken);
  if (total == null || share == null || px == null) return null;
  if (total < 0 || px <= 0) return null;
  if (share <= 0 || share >= 1) return null; // must be genuinely two-sided
  const xLegSol = total * share;
  const yLegSol = total - xLegSol;
  const tokenXTarget = xLegSol / px;
  return {
    y_leg_sol: parseFloat(yLegSol.toFixed(9)),
    x_leg_sol: parseFloat(xLegSol.toFixed(9)),
    token_x_target: parseFloat(tokenXTarget.toFixed(9)),
    x_share: share,
  };
}

/**
 * STRANDED-ASSET detection for the NON-ATOMIC entry path (swap-then-deposit).
 * When the SOL→token entry swap SUCCEEDS but the subsequent liquidity deposit
 * FAILS, the wallet is left holding a token-X bag that was never deposited — a
 * stranded position that MUST be surfaced to the operator and NEVER auto-retried
 * (anti-pattern #4 — deposit state is unknown; a blind retry risks a double bag /
 * double spend). This function decides whether that condition holds and what to do.
 *
 * @returns {{ stranded:boolean, retry:false, alert:string|null, tokenXAmount:number|null }}
 */
export function detectStrandedAsset({ swapSucceeded, tokenXReceived, depositSucceeded } = {}) {
  const gotToken = strictNum(tokenXReceived);
  const swapOk = swapSucceeded === true && gotToken != null && gotToken > 0;
  const depositOk = depositSucceeded === true;
  if (swapOk && !depositOk) {
    return {
      stranded: true,
      retry: false, // NEVER auto-retry — deposit state unknown, manual verify required
      alert:
        `STRANDED two-sided entry: SOL→token swap FILLED (${gotToken} token-X held) but the ` +
        `liquidity deposit FAILED. Token-X bag is stranded in the wallet. NO auto-retry — ` +
        `manual on-chain review + disposition required.`,
      tokenXAmount: gotToken,
    };
  }
  return { stranded: false, retry: false, alert: null, tokenXAmount: gotToken };
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
