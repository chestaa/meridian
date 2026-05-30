// tools/damm-v2.js
// ─────────────────────────────────────────────────────────────────────────
// DAMM v2 idle-reserve parking (item 8) — Vega 🔥 owns this money path.
//
// PURPOSE
//   Park ONLY genuinely-idle SOL (capital sitting above the gas reserve and
//   above the headroom needed for active/pending DLMM LP positions) into a
//   Meteora DAMM v2 fee-compounding pool, to earn yield on un-deployed funds.
//   Auto-compound mode means accrued fees fold back into reserves.
//
// HARD SAFETY INVARIANTS (Vega money rules — never violated):
//   1. flag OFF by default (config.damm.enabled === false). A live park
//      requires ALL of: flag ON + DRY_RUN===false + SDK installed + pool set.
//      The flag alone is NOT sufficient — brand-new path, defense in depth.
//   2. HARDCAP: a single park request is CLAMPED to config.damm.maxParkSol.
//      We never park more than the cap, and never leave more than the cap
//      parked. We clamp DOWN, never round up.
//   3. NEVER touch funds needed for gas (gasReserve) or for active LP
//      (sum of open + pending DLMM deploy headroom). computeParkableSol is the
//      single source of truth and is pure + unit-tested.
//   4. FAIL-SAFE: ANY error, missing SDK, missing pool, or ambiguous balance
//      → DO NOT PARK. Log and return a no-op result. Parking is opt-in and
//      must prove safety; absence of proof = no park.
//   5. SEPARATE PATH: this module imports nothing from executor.js and is
//      imported by nothing in the DLMM deploy/close/swap hot path. It cannot
//      change deploy_position / close_position / swap_token behavior.
//
// STATUS: SCAFFOLD. The money-decision logic (computeParkableSol, clamp, flag
//   gate, fail-safe) is COMPLETE and tested. The on-chain SDK wiring
//   (@meteora-ag/cp-amm-sdk createPositionAndAddLiquidity / removeAllLiquidity
//   / claimPositionFee) is behind a lazy import that is only resolved on a real
//   live park — which is currently VETO'd. See report for live-gate checklist.
// ─────────────────────────────────────────────────────────────────────────

import { config } from "../config.js";
import { log } from "../logger.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/cp-amm-sdk pulls @coral-xyz/anchor (same CJS/ESM directory-import
// hazard as @meteora-ag/dlmm). Defer loading until an actual on-chain call is
// needed so the module imports cleanly in dry-run / tests with no SDK present.
// Returns null (NOT throw) when the SDK is absent → callers fail-safe to no-op.
let _CpAmm = null;
let _sdkProbed = false;
async function tryLoadSdk() {
  if (_CpAmm) return _CpAmm;
  if (_sdkProbed) return null; // already probed and failed — don't re-import
  _sdkProbed = true;
  try {
    const mod = await import("@meteora-ag/cp-amm-sdk");
    _CpAmm = mod.CpAmm ?? mod.default?.CpAmm ?? null;
    return _CpAmm;
  } catch {
    return null; // SDK not installed — fail-safe, never throw to caller
  }
}

/**
 * PURE money-decision function (Vega-owned). Given the wallet SOL balance and
 * the SOL already committed to / reserved for DLMM LP, compute how much SOL is
 * genuinely idle and therefore eligible to park in DAMM v2.
 *
 * Reserves subtracted, in order:
 *   - gasReserve            (config.management.gasReserve) — never touchable
 *   - lpCommittedSol        SOL locked in open positions + pending deploys
 *   - lpHeadroomSol         buffer kept free so the next LP deploy never starves
 *
 * Then:
 *   - require idle >= minIdleToPark (skip dust)
 *   - CLAMP to maxParkSol (HARDCAP) and to the currently-parked headroom so the
 *     total parked never exceeds the cap.
 *
 * Returns { parkable, reason, idle } — parkable is always 0 unless every guard
 * passes. NEVER returns a value above maxParkSol. NEVER negative.
 *
 * @param {object} p
 * @param {number} p.walletSol        current free SOL in wallet
 * @param {number} p.lpCommittedSol   SOL in open/pending DLMM LP (default 0)
 * @param {number} p.lpHeadroomSol    free-buffer for next LP deploy (default 0)
 * @param {number} p.alreadyParkedSol SOL already parked in DAMM v2 (default 0)
 * @param {object} p.cfg              config (test seam; defaults to live config)
 */
export function computeParkableSol({
  walletSol,
  lpCommittedSol = 0,
  lpHeadroomSol = 0,
  alreadyParkedSol = 0,
  cfg = config,
} = {}) {
  const gasReserve = num(cfg?.management?.gasReserve, 0.2);
  const maxParkSol = num(cfg?.damm?.maxParkSol, 0.3);
  const minIdle    = num(cfg?.damm?.minIdleToPark, 0.1);

  const wallet  = num(walletSol, NaN);
  const lpCmt   = Math.max(0, num(lpCommittedSol, 0));
  const lpHead  = Math.max(0, num(lpHeadroomSol, 0));
  const parked  = Math.max(0, num(alreadyParkedSol, 0));

  // FAIL-SAFE: ambiguous / non-finite balance → never park.
  if (!Number.isFinite(wallet) || wallet < 0) {
    return { parkable: 0, idle: 0, reason: "wallet_balance_unknown" };
  }
  if (!(maxParkSol > 0)) {
    return { parkable: 0, idle: 0, reason: "maxParkSol_not_positive" };
  }

  // Idle = wallet minus everything we must never touch.
  const idle = wallet - gasReserve - lpCmt - lpHead;
  if (idle <= 0) {
    return { parkable: 0, idle: round(idle), reason: "no_idle_above_reserves" };
  }
  if (idle < minIdle) {
    return { parkable: 0, idle: round(idle), reason: "idle_below_min_threshold" };
  }

  // Cap headroom: how much MORE we may park before total parked hits the cap.
  const capHeadroom = Math.max(0, maxParkSol - parked);
  if (capHeadroom <= 0) {
    return { parkable: 0, idle: round(idle), reason: "hardcap_already_reached" };
  }

  // HARDCAP clamp — park the smaller of (idle, remaining cap headroom).
  const parkable = round(Math.min(idle, capHeadroom));

  // Final invariant guards (suspenders): never above cap, never negative.
  if (parkable <= 0) {
    return { parkable: 0, idle: round(idle), reason: "clamped_to_zero" };
  }
  if (parkable > maxParkSol) {
    // Should be unreachable given the clamp above; refuse rather than over-park.
    return { parkable: 0, idle: round(idle), reason: "clamp_invariant_violated" };
  }
  return { parkable, idle: round(idle), reason: "ok" };
}

/**
 * Park idle SOL into a DAMM v2 pool. Fully fail-safe and gated.
 *
 * Live execution requires ALL of:
 *   - config.damm.enabled === true
 *   - DRY_RUN !== "true"  (must be explicitly "false")
 *   - config.damm.poolAddress set
 *   - @meteora-ag/cp-amm-sdk installed
 *   - amountSol <= maxParkSol (HARDCAP — clamped, never over-parked)
 *
 * In dry-run or when disabled / SDK-absent → returns a logged no-op. NEVER
 * sends a transaction unless every gate passes. ANY error → no-op + log.
 *
 * NOTE: the on-chain branch is SCAFFOLD. Until Bro live-gates and the SDK is
 * installed, this function cannot reach a real send (SDK absent → no-op).
 *
 * @param {number} amountSol   requested park amount (will be hardcap-clamped)
 * @param {string} [poolAddress] override; defaults to config.damm.poolAddress
 */
export async function deployToDammV2(amountSol, poolAddress = null) {
  const enabled = config?.damm?.enabled === true;
  const pool    = poolAddress || config?.damm?.poolAddress || null;
  const maxPark = num(config?.damm?.maxParkSol, 0.3);

  // ── Gate 1: flag OFF → no-op (brand-new, default disabled). ──
  if (!enabled) {
    return noop("damm_disabled", { requested: amountSol });
  }

  // ── Gate 2: amount sanity + HARDCAP clamp. ──
  const req = num(amountSol, NaN);
  if (!Number.isFinite(req) || req <= 0) {
    return noop("invalid_amount", { requested: amountSol });
  }
  const amount = Math.min(req, maxPark); // CLAMP DOWN — never park more than cap
  if (amount <= 0 || amount > maxPark) {
    return noop("hardcap_clamp_failed", { requested: req, maxPark });
  }
  if (amount < req) {
    log("damm_park", `Clamped park ${req} → ${amount} SOL (hardcap ${maxPark})`);
  }

  // ── Gate 3: pool must be set. ──
  if (!pool) {
    return noop("no_pool_configured", { requested: amount });
  }

  // ── Gate 4: DRY_RUN → no-op (mirror swap/deploy convention). ──
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      action: "deploy_to_damm_v2",
      would_park_sol: amount,
      pool,
      message: "DRY RUN — no DAMM v2 transaction sent",
    };
  }
  // DRY_RUN must be EXPLICITLY "false" for any live path (anti-pattern #6).
  if (process.env.DRY_RUN !== "false") {
    return noop("dry_run_not_explicit", { requested: amount });
  }

  // ── Gate 5: SDK must be installed. Absent → fail-safe no-op. ──
  const CpAmm = await tryLoadSdk();
  if (!CpAmm) {
    return noop("sdk_not_installed", { requested: amount, pool });
  }

  // ── LIVE PARK — SCAFFOLD. Currently unreachable (SDK absent above). ──
  // When live-gated by Bro + SDK installed, this is where the real on-chain
  // flow lives, mirroring dlmm.js TX-verify discipline (anti-pattern #3):
  //   1. const connection = new Connection(process.env.RPC_URL, "confirmed")
  //   2. const cpAmm = new CpAmm(connection)
  //   3. const poolState = await cpAmm.fetchPoolState(new PublicKey(pool))
  //      → assert one side is wrapped SOL (curated SOL-stable pool ONLY)
  //   4. const quote = cpAmm.getDepositQuote({ ...amount → liquidityDelta })
  //   5. const positionNft = Keypair.generate()
  //   6. const txBuilder = cpAmm.createPositionAndAddLiquidity({
  //        owner, pool, positionNft: positionNft.publicKey, liquidityDelta,
  //        maxAmountTokenA, maxAmountTokenB, tokenA/BAmountThreshold,
  //        tokenA/BMint, tokenA/BProgram })
  //   7. sign with [wallet, positionNft], sendTransaction
  //   8. await connection.confirmTransaction(sig, "confirmed")
  //      → if confirmation.value.err → throw, return {success:false}
  //   9. verify position exists on-chain (cpAmm.fetchPositionState)
  //  10. persist positionNft pubkey to a DAMM-state file (NOT state.js — keep
  //      money paths separate) so withdraw can find it later.
  //   NEVER retry on failure (anti-pattern #4): log, alert, manual review.
  try {
    log("damm_park", `LIVE park path reached but not yet implemented (scaffold). pool=${pool} amount=${amount}`);
    return noop("scaffold_live_path_not_implemented", { requested: amount, pool });
  } catch (e) {
    log("damm_error", `deployToDammV2 fail-safe: ${e.message}`);
    return noop("error_failsafe", { error: e.message });
  }
}

/**
 * Withdraw (un-park) SOL from a DAMM v2 position. Fail-safe + gated. Withdraw
 * is the SAFE direction (recovering our own capital) so it is NOT flag-gated —
 * if we somehow have a parked position we must always be able to pull it back.
 * Still DRY_RUN-aware and SDK-guarded.
 *
 * @param {string} positionId  DAMM v2 position NFT pubkey
 */
export async function withdrawFromDammV2(positionId) {
  if (!positionId || typeof positionId !== "string") {
    return noop("invalid_position_id", { positionId });
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      action: "withdraw_from_damm_v2",
      position: positionId,
      message: "DRY RUN — no DAMM v2 withdraw sent",
    };
  }
  if (process.env.DRY_RUN !== "false") {
    return noop("dry_run_not_explicit", { positionId });
  }

  const CpAmm = await tryLoadSdk();
  if (!CpAmm) {
    return noop("sdk_not_installed", { positionId });
  }

  // ── LIVE WITHDRAW — SCAFFOLD. ──
  //   1. cpAmm.fetchPositionState(new PublicKey(positionId))
  //   2. cpAmm.removeAllLiquidity({ ...thresholds }) → TxBuilder
  //   3. sign + send + confirmTransaction("confirmed"); assert no err
  //   4. cpAmm.claimPositionFee(...) to sweep accrued fees (or claim first)
  //   5. verify liquidity == 0 on-chain before marking withdrawn
  try {
    log("damm_withdraw", `LIVE withdraw path reached but not yet implemented (scaffold). position=${positionId}`);
    return noop("scaffold_live_path_not_implemented", { positionId });
  } catch (e) {
    log("damm_error", `withdrawFromDammV2 fail-safe: ${e.message}`);
    return noop("error_failsafe", { error: e.message });
  }
}

/**
 * Read accrued yield / unclaimed fees for a parked DAMM v2 position. READ-ONLY,
 * no transaction. Fail-safe: any error → { accrued: 0, error } (never throw).
 *
 * @param {string} positionId  DAMM v2 position NFT pubkey
 */
export async function getDammV2Yield(positionId) {
  if (!positionId || typeof positionId !== "string") {
    return { accrued: 0, position: positionId, error: "invalid_position_id" };
  }
  const CpAmm = await tryLoadSdk();
  if (!CpAmm) {
    return { accrued: 0, position: positionId, error: "sdk_not_installed" };
  }
  // ── SCAFFOLD: cpAmm.fetchPositionState → derive unclaimed fee (tokenA/B). ──
  try {
    log("damm_yield", `yield read reached but not yet implemented (scaffold). position=${positionId}`);
    return { accrued: 0, position: positionId, error: "scaffold_not_implemented" };
  } catch (e) {
    return { accrued: 0, position: positionId, error: e.message };
  }
}

// ─── helpers ───────────────────────────────────────────────────
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round(n) {
  return Math.round(n * 1e6) / 1e6;
}
function noop(reason, extra = {}) {
  return { success: false, parked: false, no_op: true, reason, ...extra };
}

export const __internals = { SOL_MINT, tryLoadSdk };
