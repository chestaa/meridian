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

import { config, computeDeployAmount, computeDynamicDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { executeTool as defaultExecuteTool } from "../tools/executor.js";
import { getWalletBalances as defaultGetWalletBalances } from "../tools/wallet.js";
import { detectMarketRegime as defaultDetectMarketRegime } from "../tools/screening.js";
import { log } from "../logger.js";

// Test-only seams. Production code never calls these. Mirrors the pattern in
// agents/orion.js (__setClientForTests). Local indirection keeps the rest of
// this module pure + production-safe — defaults are bound at import time.
let _executeTool = defaultExecuteTool;
let _getWalletBalances = defaultGetWalletBalances;
let _detectMarketRegime = defaultDetectMarketRegime;

export function __setExecuteToolForTests(fn) {
  _executeTool = typeof fn === "function" ? fn : defaultExecuteTool;
}
export function __setGetWalletBalancesForTests(fn) {
  _getWalletBalances = typeof fn === "function" ? fn : defaultGetWalletBalances;
}
export function __setDetectMarketRegimeForTests(fn) {
  _detectMarketRegime = typeof fn === "function" ? fn : defaultDetectMarketRegime;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// STRICT numeric coercion for TELEMETRY (entry_features) reads ONLY. Distinct from
// numberOrNull above (which the deploy-math path relies on and stays UNCHANGED to
// respect scope). The naive numberOrNull FABRICATES 0 for a genuinely-missing value
// because `Number(null)===0` / `Number('')===0` are finite — that is precisely how a
// null regime/flow/mcap became a fake flat 0 in the 42-record dataset. Mirrors
// screening.js strictNumeric + classifyRegime discipline: only a real finite number
// (or non-empty numeric string) survives; null/undefined/''/boolean/object → null.
function efNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
    // Vega Item 7 — base from wallet, then scale by Orion confidence tier.
    // computeDynamicDeployAmount HARD-CAPS at maxDeployAmount internally (BELT).
    const baseAmount = computeDeployAmount(walletSol);
    amountY = computeDynamicDeployAmount(baseAmount, orionVerdict.confidence);
    if (amountY !== baseAmount) {
      log("agent", `[VEGA_DETERMINISTIC] dynamic sizing conf=${orionVerdict.confidence}% base=${baseAmount} -> ${amountY}`);
    }
  }

  // ─── Hard cap (anti-pattern #7: never let upstream slip an oversize value) ──
  // SUSPENDERS — independent of computeDynamicDeployAmount's internal BELT cap.
  // Even a test-seam deployAmountOverride or a future sizing bug cannot exceed
  // maxDeployAmount past this point. The executor enforces it a THIRD time.
  const maxDeployAmount = Number(config.risk?.maxDeployAmount ?? 0);
  if (!Number.isFinite(amountY) || amountY <= 0) {
    return { deployed: false, txSignature: null, error: `invalid amount_y ${amountY}` };
  }
  if (maxDeployAmount > 0 && amountY > maxDeployAmount) {
    log("agent", `[VEGA_DETERMINISTIC] capped amount ${amountY} -> ${maxDeployAmount} (maxDeployAmount)`);
    amountY = maxDeployAmount;
  }

  // Item (b) — volume-regime strategy spread. The deterministic path is a
  // "no explicit user strategy" caller, so when the regime feature is ON we
  // deliberately leave `strategy` undefined and pass `volume_window` to let
  // deployPosition's pickRegimeStrategy() choose (with its volatility guard).
  // When OFF we keep the legacy config-level constant. This preserves
  // override-wins: an explicit strategy would still win if one were ever
  // passed here in future.
  const volumeWindow = numberOrNull(pool.volume_window ?? pool.volume_24h ?? pool.volume);
  // Item 1 — pool/token age for the fast bid-ask bonus-stage strategy override
  // (deployPosition decides; this just supplies the metric). Optional/fail-safe.
  const tokenAgeHours = numberOrNull(pool.token_age_hours ?? pool.age_hours);
  const strategy = config.strategy?.volumeRegimeEnabled
    ? undefined
    : (config.strategy?.strategy || "bid_ask");

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
    // Vega 2026-06-20 — 429 ride-through fallback. The discovery fetch THIS cycle
    // already pulled + gate-passed this pool's live metrics seconds ago. We carry
    // those verified threshold fields + a timestamp so validateDeployPoolThresholds
    // can REUSE them (no re-fetch → no 429) when its own re-fetch 429-exhausts.
    // This is NOT a guard bypass: the data is a fresh verified live snapshot, only
    // accepted inside a bounded TTL; outside TTL or absent → fail-close as before.
    discovered_at: Date.now(),
    tvl: numberOrNull(pool.tvl ?? pool.liquidity),
    fee_active_tvl_ratio: numberOrNull(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio),
    volatility: numberOrNull(volatility),
    bin_step: numberOrNull(pool.bin_step),
  };

  // ─── entry_features raw inputs (Vega — data-collection mode, 2026-07-10) ──
  // The raw context snapshot for direction-gating (#2). Every value is ALREADY
  // known this cycle — NO new API call is added here:
  //   - SOL 24h regime: detectMarketRegime is 10-min cached and was populated by
  //     this cycle's screening pass, so this reads the warm cache (fail-safe
  //     NEUTRAL / null on any miss, never throws, never fabricates).
  //   - token price change / flow / mcap: taken off the enriched candidate + pool.
  // Absent inputs pass through as null (dlmm.buildEntryFeatures + state.js coerce).
  const ti = candidate?.ti || {};
  // Cassiopeia's in-cycle capture (screening.js buildEntryFeatures) rides on the
  // candidate as `pool.entry_features` — the authoritative snapshot read with the
  // correct condensed field names AT screen time. Prefer it so real values flow
  // through even if the direct pool/ti field paths drift; fall back to the raw
  // fields otherwise. All reads use efNumeric → genuinely-missing stays null, NEVER 0.
  const ef = (pool.entry_features && typeof pool.entry_features === "object") ? pool.entry_features : {};
  let solRegime24hPct = efNumeric(context.solRegime24hPct);
  if (solRegime24hPct == null) solRegime24hPct = efNumeric(ef.sol_24h_change_pct);
  if (solRegime24hPct == null) {
    try {
      const regime = await _detectMarketRegime({ s: config.screening });
      solRegime24hPct = efNumeric(regime?.sol24hChangePct);
    } catch (e) {
      log("agent", `[VEGA_DETERMINISTIC] regime read failed (entry_features): ${e.message}`);
      solRegime24hPct = null;
    }
  }
  const tokenPriceChange1h = efNumeric(
    ti?.stats_1h?.price_change ?? pool.price_change_1h ?? ef.price_change_pct ?? pool.price_change_pct,
  );
  const tokenPriceChange24h = efNumeric(
    ti?.stats_24h?.price_change ?? pool.price_change_24h,
  );
  const buyVol = efNumeric(pool.buy_vol ?? ef.buy_vol ?? pool.buy_vol_usd);
  const sellVol = efNumeric(pool.sell_vol ?? ef.sell_vol ?? pool.sell_vol_usd);
  const mcap = efNumeric(pool.mcap ?? ef.mcap ?? pool.market_cap);

  const args = {
    pool_address: poolAddress,
    pool_name: pool.name || null,
    amount_y: amountY,
    amount_x: 0,
    strategy,
    bins_below: binsBelow,
    bins_above: 0,
    volatility,
    volume_window: volumeWindow,
    token_age_hours: tokenAgeHours,
    base_mint: pool.base?.mint || pool.base_mint || null,
    bin_step: binStep,
    fee_tvl_ratio: numberOrNull(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio),
    organic_score: numberOrNull(pool.organic_score),
    candidate_snapshot: candidateSnapshot,
    // entry_features raw inputs — threaded to deployPosition → buildEntryFeatures.
    sol_regime_24h_pct: solRegime24hPct,
    token_price_change_1h: tokenPriceChange1h,
    token_price_change_24h: tokenPriceChange24h,
    buy_vol: buyVol,
    sell_vol: sellVol,
    mcap,
  };

  log(
    "agent",
    `[VEGA_DETERMINISTIC] deploying pool=${poolAddress.slice(0, 8)} amount=${amountY} bins_below=${binsBelow} strategy=${strategy ?? `regime(vol_window=${volumeWindow})`} volatility=${volatility}`,
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
