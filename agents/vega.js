// Vega — Deterministic Deploy (PR 3 of internal multi-agent refactor)
//
// Replaces the fat SCREENER `agentLoop` with deterministic code. After Orion
// emits an ENTER verdict, Vega computes the deploy parameters from existing
// hard-coded formulas (NO LLM call) and dispatches `deploy_position` via the
// SAME `executeTool` entrypoint the agent loop uses — so every safety check
// (account circuit breaker, fresh snapshot guard, position cap, bin range,
// balance, duplicate pool/token) fires exactly as it does today.
//
// Why determinism here:
//   - bins_below already has a deterministic formula (CLAUDE.md L127):
//       round(minBinsBelow + (volatility/5)*(maxBinsBelow-minBinsBelow))
//       clamped to [minBinsBelow, maxBinsBelow]
//   - amount_y already comes from `computeDeployAmount(walletSol)` (config.js)
//   - strategy is a config-level constant (config.strategy.strategy)
//   The SCREENER LLM call was redundant — it just re-derived these same
//   values and occasionally hallucinated. Removing it cuts cost + drift risk.
//
// Feature flag: `config.internalAgents.vegaDeterministicDeploy` (default OFF).
// When OFF, callers MUST fall through to the legacy LLM agentLoop path.
//
// Money invariants (must hold at all times):
//   - No LLM call inside this module.
//   - amount_y never exceeds config.risk.maxDeployAmount.
//   - amount_y is single-side SOL; amount_x stays 0.
//   - bins_above stays 0 (single-side SOL deploys).
//   - bins_below stays in [strategy.minBinsBelow, strategy.maxBinsBelow].
//   - executeTool('deploy_position', ...) is the ONLY deploy entrypoint —
//     never call dlmm.deployPosition directly (bypasses runSafetyChecks).
//   - Vega rejects (returns null) when:
//       * flag is OFF
//       * verdict.decision !== "enter"
//       * verdict.confidence < orionMinConfidence floor (when live)
//       * candidate pool volatility is missing/<=0
//       * candidate pool address missing

import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { executeTool as defaultExecuteTool } from "../tools/executor.js";
import { getWalletBalances as defaultGetWalletBalances } from "../tools/wallet.js";
import { log } from "../logger.js";

// Test-only seams. Production code never calls these. Mirrors the pattern in
// agents/orion.js (__setClientForTests). Local indirection keeps the rest of
// this module pure + production-safe — defaults are bound at import time.
let _executeTool = defaultExecuteTool;
let _getWalletBalances = defaultGetWalletBalances;

export function __setExecuteToolForTests(fn) {
  _executeTool = typeof fn === "function" ? fn : defaultExecuteTool;
}
export function __setGetWalletBalancesForTests(fn) {
  _getWalletBalances = typeof fn === "function" ? fn : defaultGetWalletBalances;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic bins_below from volatility.
 * Mirrors the formula the SCREENER LLM was previously instructed to compute
 * (index.js terseReportSteps / legacyReportSteps L674, L737, also CLAUDE.md L127).
 * Pure function — safe to unit test in isolation.
 */
export function computeBinsBelow(volatility, strategy = config.strategy) {
  const minBins = Math.max(
    MIN_SAFE_BINS_BELOW,
    Math.round(Number(strategy?.minBinsBelow ?? MIN_SAFE_BINS_BELOW)),
  );
  const maxBins = Math.max(minBins, Math.round(Number(strategy?.maxBinsBelow ?? minBins)));
  const v = numberOrNull(volatility);
  if (v == null || v <= 0) return null; // volatility feed unusable — refuse
  const span = maxBins - minBins;
  const raw = minBins + (v / 5) * span;
  const clamped = Math.min(maxBins, Math.max(minBins, Math.round(raw)));
  return clamped;
}

/**
 * Whether Vega is enabled. Single source of truth for callers.
 */
export function vegaDeterministicDeployEnabled(cfg = config) {
  return Boolean(cfg?.internalAgents?.vegaDeterministicDeploy);
}

/**
 * Apply Cassiopeia live overlay (orionMinConfidence) — same rule the
 * Orion judge already applies internally, repeated here as a belt-and-
 * suspenders check so a stale ENTER verdict cached upstream cannot bypass
 * the live floor when Vega is the deploy path.
 */
function passesLiveConfidenceFloor(verdict, cfg = config) {
  const liveMinConf = (cfg.dryRun === false && cfg.liveOverrides?.orionMinConfidence) ?? 0;
  if (liveMinConf <= 0) return true;
  return Number(verdict?.confidence ?? 0) >= liveMinConf;
}

/**
 * Deterministic deploy from an Orion ENTER verdict.
 *
 * @param {Object} orionVerdict - Output of agents/orion.js judgeCandidates,
 *   shape: { pool_address, decision, confidence, reason, recommended_bins_below? }
 * @param {Object} candidate - Pre-fetched candidate block from index.js
 *   runScreeningCycle, shape: { pool, sw, n, ti, mem }
 * @param {Object} context - Optional. { walletSol?, deployAmountOverride?, dryRunOverride? }
 * @returns {Promise<{deployed: boolean, txSignature: string|null, error: string|null, result?: Object, args?: Object} | null>}
 *   Returns null when Vega declines to act (flag off, bad verdict, missing volatility).
 *   Returns { deployed: false, error } when executeTool refused or threw.
 *   Returns { deployed: true, txSignature, result } on success (including dry-run paper deploys).
 */
export async function deployFromOrionVerdict(orionVerdict, candidate, context = {}) {
  // ─── Gate 1: feature flag ──
  if (!vegaDeterministicDeployEnabled()) {
    return null;
  }

  // ─── Gate 2: ENTER verdict only ──
  if (!orionVerdict || orionVerdict.decision !== "enter") {
    return null;
  }

  // ─── Gate 3: live confidence floor (belt-and-suspenders) ──
  if (!passesLiveConfidenceFloor(orionVerdict)) {
    log("agent", `[VEGA_DETERMINISTIC] skip — confidence ${orionVerdict.confidence}% below live floor`);
    return null;
  }

  const pool = candidate?.pool || {};
  const poolAddress = orionVerdict.pool_address || pool.pool;
  if (!poolAddress) {
    log("agent", `[VEGA_DETERMINISTIC] skip — missing pool address on verdict/candidate`);
    return null;
  }

  // ─── Gate 4: volatility must be positive for the formula to be meaningful ──
  const volatility = numberOrNull(pool.volatility);
  if (volatility == null || volatility <= 0) {
    log("agent", `[VEGA_DETERMINISTIC] skip ${poolAddress.slice(0, 8)} — volatility ${pool.volatility ?? "null"} unusable`);
    return null;
  }

  // ─── Deterministic param derivation ──
  const binsBelow = computeBinsBelow(volatility);
  if (binsBelow == null) {
    log("agent", `[VEGA_DETERMINISTIC] skip ${poolAddress.slice(0, 8)} — bins_below formula returned null`);
    return null;
  }

  // amount_y from existing config formula. Caller may override (test seam) but
  // production callers (index.js) pass the live wallet balance.
  let amountY;
  if (context.deployAmountOverride != null) {
    amountY = Number(context.deployAmountOverride);
  } else {
    let walletSol = numberOrNull(context.walletSol);
    if (walletSol == null) {
      try {
        const balances = await _getWalletBalances({});
        walletSol = numberOrNull(balances?.sol);
      } catch (e) {
        log("agent", `[VEGA_DETERMINISTIC] balance fetch failed: ${e.message}`);
        return { deployed: false, txSignature: null, error: `balance fetch failed: ${e.message}` };
      }
    }
    if (walletSol == null) {
      log("agent", `[VEGA_DETERMINISTIC] skip ${poolAddress.slice(0, 8)} — wallet balance unknown`);
      return { deployed: false, txSignature: null, error: "wallet balance unknown" };
    }
    amountY = computeDeployAmount(walletSol);
  }

  // ─── Hard cap (anti-pattern #7: never let upstream slip an oversize value) ──
  const maxDeployAmount = Number(config.risk?.maxDeployAmount ?? 0);
  if (!Number.isFinite(amountY) || amountY <= 0) {
    return { deployed: false, txSignature: null, error: `invalid amount_y ${amountY}` };
  }
  if (maxDeployAmount > 0 && amountY > maxDeployAmount) {
    log("agent", `[VEGA_DETERMINISTIC] capped amount ${amountY} -> ${maxDeployAmount} (maxDeployAmount)`);
    amountY = maxDeployAmount;
  }

  const strategy = config.strategy?.strategy || "bid_ask";

  // Pull bin_step from candidate so executor's bin_step gate has the value it needs.
  // Optional — if missing, executor falls back to the on-chain pool object.
  const binStep = numberOrNull(pool.bin_step);

  // Snapshot for the fresh-snapshot guard (Vega X1) — passes whatever metrics
  // the candidate has so computeDrift can compare against a live refresh.
  const candidateSnapshot = {
    volume24h: numberOrNull(pool.volume_window ?? pool.volume_24h ?? pool.volume),
    bot_pct: numberOrNull(candidate?.ti?.audit?.bot_holders_pct ?? pool.bot_pct),
    top10_pct: numberOrNull(candidate?.ti?.audit?.top_holders_pct ?? pool.top10_pct),
    dev_sold_all: Boolean(pool.dev_sold_all),
  };

  const args = {
    pool_address: poolAddress,
    pool_name: pool.name || null,
    amount_y: amountY,
    amount_x: 0,
    strategy,
    bins_below: binsBelow,
    bins_above: 0,
    volatility,
    base_mint: pool.base?.mint || pool.base_mint || null,
    bin_step: binStep,
    fee_tvl_ratio: numberOrNull(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio),
    organic_score: numberOrNull(pool.organic_score),
    candidate_snapshot: candidateSnapshot,
  };

  log(
    "agent",
    `[VEGA_DETERMINISTIC] deploying pool=${poolAddress.slice(0, 8)} amount=${amountY} bins_below=${binsBelow} strategy=${strategy} volatility=${volatility}`,
  );

  let result;
  try {
    result = await _executeTool("deploy_position", args);
  } catch (e) {
    log("agent", `[VEGA_DETERMINISTIC] executeTool threw: ${e.message}`);
    return { deployed: false, txSignature: null, error: e.message, args };
  }

  // executeTool never throws for deploy errors — it returns shaped failure.
  // Handle: { blocked, reason } (safety check refused),
  //         { error } (impl threw),
  //         { success: false, ... },
  //         { dry_run, would_deploy } (paper trade — counts as deployed=true),
  //         live success { position, txs, ... }
  if (result?.blocked) {
    log("agent", `[VEGA_DETERMINISTIC] blocked by safety check: ${result.reason}`);
    return { deployed: false, txSignature: null, error: `blocked: ${result.reason}`, result, args };
  }
  if (result?.error) {
    log("agent", `[VEGA_DETERMINISTIC] tool error: ${result.error}`);
    return { deployed: false, txSignature: null, error: result.error, result, args };
  }
  if (result?.success === false) {
    log("agent", `[VEGA_DETERMINISTIC] deploy_position returned success=false`);
    return { deployed: false, txSignature: null, error: result?.reason || "deploy returned success=false", result, args };
  }

  const txSignature = result?.txs?.[0] ?? result?.tx ?? null;
  log(
    "agent",
    `[VEGA_DETERMINISTIC] deployed pool=${poolAddress.slice(0, 8)} amount=${amountY} bins_below=${binsBelow}${txSignature ? ` tx=${String(txSignature).slice(0, 12)}` : " (paper)"}`,
  );
  return { deployed: true, txSignature, error: null, result, args };
}
