// Vega Item 9 — Rebalance-on-OOR live re-center orchestrator.
//
// When a HIGH-ORGANIC position goes out of range past outOfRangeWaitMinutes,
// instead of a hard close (which kills fee earning on a token that may re-enter
// range), we RE-CENTER: pull 100% liquidity and re-deploy the SAME capital
// centered on the CURRENT active bin so the position keeps earning fees.
//
// ─── MONEY INVARIANTS (must hold at all times) ──────────────────────────────
//   1. We NEVER write a new on-chain TX primitive. A re-center is composed of
//      the two EXISTING audited entrypoints: executeTool("close_position") and
//      executeTool("deploy_position"). This means the deploy hardcap
//      (config.risk.maxDeployAmount), circuit breaker, balance check, dup-pool
//      guard, min-bins guard, and fresh-snapshot guard ALL fire unchanged on
//      the re-deploy. We cannot bypass them and we do not try.
//   2. Re-deploy capital is min(tracked capital, SOL actually received on
//      close). It is structurally <= the original position size, never more.
//      The hardcap in runSafetyChecks is the final non-negotiable ceiling.
//   3. FAIL-SAFE: any error path leaves the position in a MANAGED state —
//      either still open + monitored (error before close) or cleanly closed
//      (error after close). It is NEVER left open AND unmanaged. The only
//      irreversible step is close_position; once it succeeds the old position
//      is gone, and a failed re-deploy simply means "capital is now in the
//      wallet as SOL" — fully safe, surfaced to the operator.
//   4. Friction guard: a re-center is 3 tx (remove + deploy + base→SOL swap)
//      plus slippage. If accumulated fees < estimated friction, we DO NOT
//      churn — we hard close instead.
//   5. Idempotency: each cycle handles a given position at most once (the
//      caller dispatches one exit per position per cycle). recordRebalance
//      increments the count AFTER a confirmed re-deploy only.
//
// Feature flag: config.management.rebalanceOnOorEnabled (default FALSE). The
// upstream gate (state.js#updatePnlAndCheckExits) only emits REBALANCE_OOR when
// the flag is on, organic >= threshold, and rebalance_count < maxRebalances.
// This module is therefore only reached on explicit operator opt-in.

import { config as defaultConfig } from "../config.js";
import { executeTool as defaultExecuteTool } from "../tools/executor.js";
import { estimateRebalanceFrictionSol } from "../tools/dlmm.js";
import { getTrackedPosition as defaultGetTracked, recordRebalance as defaultRecordRebalance } from "../state.js";
import { log } from "../logger.js";

// ── Test seams (mirror agents/manager.js + agents/vega.js) ──────────────────
let _executeTool = defaultExecuteTool;
let _getTracked = defaultGetTracked;
let _recordRebalance = defaultRecordRebalance;

export function __setForTests({ executeTool, getTracked, recordRebalance } = {}) {
  if (typeof executeTool === "function") _executeTool = executeTool;
  if (typeof getTracked === "function") _getTracked = getTracked;
  if (typeof recordRebalance === "function") _recordRebalance = recordRebalance;
}
export function __resetTests() {
  _executeTool = defaultExecuteTool;
  _getTracked = defaultGetTracked;
  _recordRebalance = defaultRecordRebalance;
}

/**
 * bins_below from volatility — same continuous formula the SCREENER uses
 * (CLAUDE.md "bins_below Calculation"). Clamped to [minBinsBelow, maxBinsBelow].
 * Volatility <= 0 / non-finite → fall back to defaultBinsBelow (a valid, safe
 * in-range value) rather than refusing; the re-center should keep the position
 * alive even when the volatility feed momentarily degrades.
 */
export function computeBinsBelow(volatility, strategyCfg) {
  const minB = Number(strategyCfg?.minBinsBelow ?? 35);
  const maxB = Number(strategyCfg?.maxBinsBelow ?? 69);
  const def = Number(strategyCfg?.defaultBinsBelow ?? maxB);
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) {
    return Math.max(minB, Math.min(maxB, Math.round(def)));
  }
  const raw = minB + (v / 5) * (maxB - minB);
  return Math.max(minB, Math.min(maxB, Math.round(raw)));
}

/**
 * Estimate accumulated fees (in SOL) earned by a position, for the friction
 * guard. Prefers the live unclaimed-fees figure on the position snapshot;
 * falls back to the tracked total_fees_claimed (USD → SOL via solUsd). Returns
 * a non-negative SOL number; null inputs collapse to 0 (which fails the guard
 * → hard close, the safe default).
 */
export function estimateAccumulatedFeesSol(positionData, tracked, solUsd) {
  // Live unclaimed fees are reported in SOL on the position snapshot when
  // solMode is on (unclaimed_fees_sol); otherwise USD.
  const unclaimedSol = Number(positionData?.unclaimed_fees_sol);
  if (Number.isFinite(unclaimedSol) && unclaimedSol >= 0) {
    // Also fold in any fees already claimed this lifetime (tracked, USD→SOL).
    const claimedUsd = Number(tracked?.total_fees_claimed_usd ?? 0);
    const px = Number(solUsd);
    const claimedSol = Number.isFinite(claimedUsd) && Number.isFinite(px) && px > 0 ? claimedUsd / px : 0;
    return Number((unclaimedSol + claimedSol).toFixed(9));
  }
  // Fall back: USD figures → SOL.
  const unclaimedUsd = Number(positionData?.unclaimed_fees_usd ?? 0);
  const claimedUsd = Number(tracked?.total_fees_claimed_usd ?? 0);
  const px = Number(solUsd);
  if (Number.isFinite(px) && px > 0) {
    const totalUsd = (Number.isFinite(unclaimedUsd) ? unclaimedUsd : 0) + (Number.isFinite(claimedUsd) ? claimedUsd : 0);
    return Number((totalUsd / px).toFixed(9));
  }
  return 0;
}

/**
 * Live re-center for one OOR high-organic position.
 *
 * @param {object} ctx
 * @param {object} ctx.position    - position snapshot from getMyPositions (has
 *                                    .position, .pool, .unclaimed_fees_*, etc.)
 * @param {object} ctx.exit        - the REBALANCE_OOR exit from updatePnlAndCheckExits
 * @param {object} [ctx.mgmtConfig]
 * @param {object} [ctx.strategyConfig]
 * @param {number} [ctx.solUsd]    - SOL/USD price for fee→SOL conversion
 * @returns {Promise<{ outcome, ... }>}
 *   outcome ∈ "rebalanced" | "closed_friction" | "closed_fallback" | "closed_error"
 *   In every non-rebalanced outcome the position is CLOSED (managed). Caller
 *   should surface the result; it never needs to take further action to make
 *   the position safe.
 */
export async function rebalanceOnOor(ctx = {}) {
  const cfg = ctx.mgmtConfig || defaultConfig.management;
  const strategyCfg = ctx.strategyConfig || defaultConfig.strategy;
  const p = ctx.position || {};
  const posAddr = p.position;
  const poolAddr = p.pool;
  const reason = ctx.exit?.reason || "OOR re-center";

  if (!posAddr) {
    return { outcome: "skipped", reason: "missing position address" };
  }

  const tracked = _getTracked(posAddr) || {};

  // ── Step 0: friction guard ──────────────────────────────────────────────
  // If accumulated fees can't even cover the cost of re-centering, churning is
  // a guaranteed net loss. Hard close instead. Use tracked capital (the real
  // deploy size) for the slippage component, not a guess.
  const capitalSol = Number(tracked.amount_sol ?? cfg.deployAmountSol ?? 0);
  const friction = estimateRebalanceFrictionSol({ amountSol: capitalSol });
  const feesSol = estimateAccumulatedFeesSol(p, tracked, ctx.solUsd ?? defaultConfig.tokens?.solUsd);
  if (feesSol < friction) {
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} fees ${feesSol} SOL < friction ${friction} SOL — NOT worth re-centering, hard closing.`);
    return await hardClose(posAddr, p, `OOR (fees ${feesSol} < friction ${friction}, not worth re-center): ${reason}`, "closed_friction");
  }

  // ── Step 1: fetch CURRENT active bin + fresh pool metrics ─────────────────
  // Needed to center the re-deploy and to compute bins_below from live
  // volatility. Failure here is BEFORE any irreversible step → safe fallback
  // to hard close.
  let activeBin = null;
  let volatility = tracked.volatility ?? null;
  let binStep = tracked.bin_step ?? null;
  try {
    const ab = await _executeTool("get_active_bin", { pool_address: poolAddr });
    activeBin = ab?.active_bin ?? ab?.activeBin ?? ab?.bin_id ?? null;
    const detail = await _executeTool("get_pool_detail", { pool_address: poolAddr, timeframe: "5m" }).catch(() => null);
    if (detail) {
      const v = Number(detail.volatility);
      if (Number.isFinite(v) && v > 0) volatility = v;
      const bs = Number(detail.bin_step ?? detail.binStep);
      if (Number.isFinite(bs) && bs > 0) binStep = bs;
    }
  } catch (e) {
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} pre-close metric fetch failed (${e.message}) — failing safe to hard close.`);
    return await hardClose(posAddr, p, `OOR (re-center metric fetch failed, hard close fallback): ${reason}`, "closed_fallback");
  }

  const binsBelow = computeBinsBelow(volatility, strategyCfg);

  // ── Step 2: CLOSE (claims fees + removes 100% + auto-swaps base→SOL) ──────
  // This is the only irreversible step. After it succeeds the old position no
  // longer exists; the capital is back in the wallet as SOL.
  let closeResult;
  try {
    closeResult = await _executeTool("close_position", {
      position_address: posAddr,
      reason: `re-center (rebalance #${Number(tracked.rebalance_count ?? 0) + 1}): ${reason}`,
    });
  } catch (e) {
    // Close threw — position state is UNKNOWN. Anti-pattern #3/#4: do NOT
    // retry, do NOT re-deploy. Surface; operator verifies on-chain. The
    // close_position path itself already fired a failure alert. Position is
    // still (probably) open and monitored — never unmanaged.
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} close threw: ${e.message} — NO re-deploy, manual verify required.`);
    return { outcome: "closed_error", error: e.message, position: posAddr, redeployed: false };
  }
  if (closeResult?.blocked || closeResult?.error || closeResult?.success === false) {
    const err = closeResult?.reason || closeResult?.error || "close returned failure";
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} close did not execute (${err}) — position stays open + monitored, no re-deploy.`);
    return { outcome: "closed_error", error: err, position: posAddr, redeployed: false };
  }

  // ── Step 3: RE-DEPLOY same/less capital centered on CURRENT active bin ────
  // Capital = min(tracked capital, SOL actually received). The deploy hardcap
  // (maxDeployAmount) is enforced inside runSafetyChecks — we additionally
  // floor at <= tracked capital here so a noisy sol_received can never inflate
  // the size. If the re-deploy fails for ANY reason, the position is already
  // closed (capital safe in wallet as SOL) — we surface it; never unmanaged.
  const solReceived = Number(closeResult?.sol_received);
  let redeployAmount = capitalSol;
  if (Number.isFinite(solReceived) && solReceived > 0) {
    redeployAmount = Math.min(capitalSol, solReceived);
  }
  // Belt-and-suspenders: never exceed the hardcap even if tracked capital is
  // stale/corrupt. runSafetyChecks would block it anyway; we pre-clamp so the
  // intent (re-center uses same/less, never more) is explicit in this module.
  const hardCap = Number(defaultConfig.risk?.maxDeployAmount);
  if (Number.isFinite(hardCap) && hardCap > 0) {
    redeployAmount = Math.min(redeployAmount, hardCap);
  }
  redeployAmount = Number(redeployAmount.toFixed(9));

  if (!Number.isFinite(redeployAmount) || redeployAmount <= 0) {
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} closed but re-deploy amount ${redeployAmount} invalid — leaving capital as SOL (safe), no re-deploy.`);
    return { outcome: "closed_fallback", position: posAddr, redeployed: false, reason: "invalid re-deploy amount post-close" };
  }

  let deployResult;
  try {
    deployResult = await _executeTool("deploy_position", {
      pool_address: poolAddr,
      amount_y: redeployAmount,
      amount_x: 0,
      bins_below: binsBelow,
      bins_above: 0,
      active_bin: activeBin,
      bin_step: binStep,
      volatility: Number.isFinite(Number(volatility)) && Number(volatility) > 0 ? Number(volatility) : undefined,
      organic_score: tracked.organic_score ?? p.organic_score,
      pool_name: tracked.pool_name || p.pair,
      base_mint: tracked.base_mint ?? p.base_mint,
      strategy: tracked.strategy,
    });
  } catch (e) {
    // Re-deploy threw AFTER close succeeded. Position is closed; capital is
    // safe SOL in wallet. NOT unmanaged. Surface for operator/next screener.
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} re-deploy threw after close: ${e.message} — capital safe as SOL, position closed.`);
    return { outcome: "closed_fallback", position: posAddr, redeployed: false, error: e.message, reason: "re-deploy threw post-close (capital safe as SOL)" };
  }

  if (deployResult?.blocked || deployResult?.error || deployResult?.success === false) {
    const err = deployResult?.reason || deployResult?.error || "deploy returned failure";
    log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} re-deploy did not execute (${err}) — capital safe as SOL, position closed.`);
    return { outcome: "closed_fallback", position: posAddr, redeployed: false, error: err, reason: "re-deploy failed post-close (capital safe as SOL)" };
  }

  // ── Step 4: record the re-center ──────────────────────────────────────────
  const newPosition = deployResult?.position ?? null;
  const newCount = _recordRebalance(posAddr, {
    new_active_bin: activeBin,
    amount_sol: redeployAmount,
    new_position: newPosition,
  });
  log("rebalance", `[REBALANCE_OOR] ${p.pair || posAddr} re-centered → bin ${activeBin}, ${redeployAmount} SOL, bins_below ${binsBelow}, rebalance_count ${newCount ?? "?"}.`);

  return {
    outcome: "rebalanced",
    position: posAddr,
    new_position: newPosition,
    amount_sol: redeployAmount,
    active_bin: activeBin,
    bins_below: binsBelow,
    rebalance_count: newCount,
    redeployed: true,
  };
}

/**
 * Fail-safe hard close. Used when re-center is not worth it (friction) or a
 * pre-close error makes re-center impossible. Routes through the audited
 * close_position entrypoint (claims fees, removes 100%, auto-swap, records
 * performance). Returns the given outcome label. Never throws.
 */
async function hardClose(posAddr, p, reason, outcomeLabel) {
  try {
    const res = await _executeTool("close_position", { position_address: posAddr, reason });
    if (res?.blocked || res?.error || res?.success === false) {
      const err = res?.reason || res?.error || "close returned failure";
      log("rebalance", `[REBALANCE_OOR] ${p?.pair || posAddr} fallback hard close did not execute: ${err}`);
      return { outcome: "closed_error", position: posAddr, error: err, redeployed: false };
    }
    return { outcome: outcomeLabel, position: posAddr, redeployed: false, result: res };
  } catch (e) {
    log("rebalance", `[REBALANCE_OOR] ${p?.pair || posAddr} fallback hard close threw: ${e.message}`);
    return { outcome: "closed_error", position: posAddr, error: e.message, redeployed: false };
  }
}
