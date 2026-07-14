import { discoverPools, getPoolDetail, getTopCandidates, isBluechipMintPair, poolLegMints, peekDiscoveryDetailByAddress, twoSidedPaperLaneActive, isLstMintFreezeExempt } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  partialClosePosition,
  searchPools,
  MAX_LIVE_POSITION_SOL,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { twoSidedGateDecision, resolveTwoSidedNotionalCapSol } from "./two-sided.js";
import { getRecentDecisions } from "../decision-log.js";
import { recordDeployOutflow } from "../deploy-outflow-ledger.js";
import { recordDeployGas, DEFAULT_DEPLOY_GAS_SOL } from "../deploy-gas-ledger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, notifyDeployFailure } from "../telegram.js";
import { assertCircuitOK, CircuitBreakerError } from "../account-circuit-breaker.js";
import { selectNotifyRealizedSol } from "../realized-sol.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure SOL-coverage gate decision (Vega money-path). Returns a reject reason
 * string, or null if coverage is OK. FAIL-CLOSED: a failed/unknown balance read
 * (now `sol:null` from getWalletBalances, no longer the phantom sentinel 0) must
 * NEVER be assumed sufficient — `null < x` is falsy in JS, so a naive
 * `balance.sol < minRequired` would FAIL OPEN. Anti-pattern #2/#3: balance
 * unknown ⇒ refuse, never assume funds.
 *
 * @param {object} balance  getWalletBalances() result (may carry error:true / sol:null)
 * @param {number} amountY  SOL to deploy
 * @param {number} gasReserve  SOL kept for gas
 * @returns {string|null} reject reason, or null to allow
 */
export function solCoverageRejectReason(balance, amountY, gasReserve) {
  const sol = Number(balance?.sol);
  if (balance?.error || balance?.sol == null || !Number.isFinite(sol)) {
    return `Balance read failed/unknown (${balance?.error_message || "no sol value"}) — refusing deploy. Cannot confirm SOL coverage; will not assume sufficient funds.`;
  }
  const minRequired = Number(amountY) + Number(gasReserve);
  if (sol < minRequired) {
    return `Insufficient SOL: have ${sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`;
  }
  return null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

// ── Bluechip deploy-side binStep exemption (Vega — Opsi B, money-path) ──────────
// ROOT BLOCKER (Lyra): bluechip never deployed — SOL-USDC bin_step=1 is far below the
// memecoin minBinStep (80), so the executor binStep gate refused EVERY bluechip deploy.
// A deep stable pool legitimately uses a tiny bin step (fine price grid). This helper
// decides whether the memecoin [minBinStep,maxBinStep] floor/ceiling should be EXEMPTED.
//
// Exemption fires ONLY when ALL hold:
//   1. config.screening.bluechipModeEnabled === true   (master flag, default OFF)
//   2. isBluechipMintPair(base, quote) === true        (WHITELIST — NON-NEGOTIABLE)
// Mints resolved from args metadata (base_mint + quote_mint/quote_address) and, when a
// leg is missing there, from the LIVE on-chain pool `detail` via poolLegMints — the deploy
// tool schema only carries base_mint, so quote is normally resolved from detail. This is
// the SAME curated whitelist the executor bluechip cap uses; dlmm.deployPosition then
// re-classifies from the on-chain mints as the AUTHORITATIVE belt. FAIL-CLOSED: missing/
// empty leg or flag OFF → NOT exempt → memecoin [80,…] floor applies (anti-pattern #2).
//
// IMPORTANT: exemption is NOT "no binStep check." When exempt, the caller still enforces
// a sane absolute bound: bin_step must be a positive finite integer in (0, bluechipMaxBinStep].
// A garbage bin_step (0 / negative / non-finite / absurd) is REFUSED regardless.
function isBluechipBinStepExempt(args, detail = null) {
  if (config.screening?.bluechipModeEnabled !== true) return false;
  const legs = detail ? poolLegMints(detail) : { base: null, quote: null };
  const baseMint = args?.base_mint ?? args?.base_address ?? legs.base ?? null;
  const quoteMint = args?.quote_mint ?? args?.quote_address ?? legs.quote ?? null;
  if (!baseMint || !quoteMint) return false; // fail-closed: cannot classify → not exempt
  return isBluechipMintPair(baseMint, quoteMint);
}

// Sane absolute bound that still applies to an EXEMPT bluechip bin_step. Returns a reject
// reason string when the bin_step is unusable, else null (acceptable). Keeps the gate
// fail-closed even inside the exemption lane: a tiny bin_step (1,2,4,10…) passes, but
// 0/negative/non-integer/non-finite/over-ceiling is refused.
function bluechipBinStepSanityReject(binStep) {
  const ceil = numberOrNull(config.screening?.bluechipMaxBinStep) ?? 200;
  if (binStep == null) return null; // unknown bin_step is handled by the caller's null-guard
  if (!Number.isFinite(binStep) || !Number.isInteger(binStep) || binStep <= 0) {
    return `bluechip bin_step ${binStep} is not a positive integer. Refusing deploy.`;
  }
  if (binStep > ceil) {
    return `bluechip bin_step ${binStep} exceeds bluechip ceiling ${ceil}. Refusing deploy.`;
  }
  return null;
}

// ── Two-sided PAPER-lane curated-LST deploy exemption (Vega — money-path, paper-isolated) ──
// The FINAL Track-A paper blocker: a deep-TVL curated LST-SOL income pair (JitoSOL/mSOL/
// jupSOL-SOL) surfaces → passes the strict screening gate (via twoSidedPaperBluechipGateReason,
// which DROPS the fee/TVL yield floor and NEVER checks binStep for the paper lane) → reaches
// deploy_position — then the executor's MEMECOIN gates bite: maxTvl $150k (deep TVL is the POINT
// of a two-sided LST income pair, not a risk), the fee/TVL yield floor (low fee/TVL is EXPECTED
// at ~1% APR for a symmetric SOL-tracking pair), the vol>0 floor (a stable pair legitimately
// reads ~0 vol), and the memecoin binStep [80,125] range (LST-SOL pools use a fine bin_step).
// This predicate makes the executor MIRROR the screening paper-lane treatment so those gates are
// re-targeted for the paper LST pair, exactly as they already are for the bluechip income lane.
//
// Fires ONLY when BOTH hold (HARD ISOLATION — task point 2):
//   1. twoSidedPaperLaneActive(config, DRY_RUN) === true   → twoSidedEnabled && DRY_RUN==="true".
//      This is NEVER true in live (DRY_RUN=false) or flag-off — the whole isolation guarantee.
//   2. isLstMintFreezeExempt(base) === true                → a curated, on-chain-probe-confirmed
//      stake-pool LST base leg (JitoSOL/mSOL/jupSOL). Stables / memecoins / bSOL are NOT exempt.
// Base mint resolves from args metadata, else from the LIVE on-chain `detail` legs (poolLegMints).
// FAIL-CLOSED (anti-pattern #2): lane inactive, non-curated base, or unresolvable base → NOT exempt
// → the memecoin gates apply byte-for-byte. Live two-sided is still hard-refused upstream (the
// twoSidedGateDecision belts) — this changes NOTHING about live behavior and never fires in live.
function isTwoSidedPaperLstExempt(args, detail = null) {
  if (!twoSidedPaperLaneActive(config, process.env.DRY_RUN)) return false;
  const legs = detail ? poolLegMints(detail) : { base: null, quote: null };
  const argBase = args?.base_mint ?? args?.base_address ?? null;
  // The curated LST is ALWAYS the pool's BASE (token_x) leg (wSOL is the quote/token_y
  // per isTwoSidedPaperCandidate). Accept the exemption if EITHER the args-supplied base
  // OR the AUTHORITATIVE on-chain base leg is a curated LST, so no arg-shape variation can
  // silently fail-close the flagship (the vega-bluechip-maxtvl-paper-stale lesson). Mirrors
  // screening's twoSidedBaseLegGateReason, which keys the mint/freeze exemption purely on
  // isLstMintFreezeExempt(base). FAIL-CLOSED: neither base resolvable / curated → not exempt.
  if (argBase && isLstMintFreezeExempt(argBase)) return true;
  if (legs.base && isLstMintFreezeExempt(legs.base)) return true;
  return false;
}

// Test seams — exercise the pure binStep-exemption decision + sanity bound in isolation.
export function __isBluechipBinStepExemptForTests(args, detail = null) {
  return isBluechipBinStepExempt(args, detail);
}
export function __bluechipBinStepSanityRejectForTests(binStep) {
  return bluechipBinStepSanityReject(binStep);
}
export function __isTwoSidedPaperLstExemptForTests(args, detail = null) {
  return isTwoSidedPaperLstExempt(args, detail);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailFeeTvlRatio(pool) {
  return numberOrNull(pool?.fee_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

/**
 * Vega — transient-error classifier for the pre-deploy snapshot READ fetch.
 * Transient = worth a bounded retry (Draco restart-3 thundering-herd 429 burst,
 * upstream 5xx, network timeout/abort). Everything else (other 4xx, bad payload)
 * is permanent → fail-close immediately, never retry something that won't succeed.
 *
 * IMPORTANT (anti-pattern #4): this governs ONLY the read-only snapshot fetch.
 * It must NEVER be applied to deploy_position itself — the deploy TX stays
 * single-attempt. State after a failed deploy is unknown; retrying is forbidden.
 */
// Vega 2026-06-20 — raised 3→5 (total 6 attempts) to ride through LONGER 429
// bursts (Lyra: 06-20 AM 7 cycles, 0 deploy, pools ENTER'd by Orion but
// snapshot-verify 429-exhausted at the old 4-attempt budget). Backoff lengthened
// to 1/2/4/8/16s so the full ride-through spans ~31s of burst before fail-close.
// This governs ONLY the read-only snapshot fetch — deploy_position TX is untouched.
const SNAPSHOT_FETCH_MAX_RETRIES = 5; // total attempts = 1 + 5 retries
const SNAPSHOT_FETCH_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]; // ride-through transient burst

// Vega 2026-06-20 — reuse-discovery-data fallback TTL. When the pre-deploy
// re-fetch 429-EXHAUSTS, we may verify against the discovery snapshot captured
// THIS cycle (carried in args.candidate_snapshot) — but ONLY if it is fresher
// than this TTL. The discovery→judge→deploy path is synchronous within one cycle
// (seconds), so 5min is a generous-but-bounded staleness ceiling. Outside TTL,
// or if any threshold field is missing → NO fallback → fail-close (preserved).
const DISCOVERY_REUSE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Vega — build a `detail`-shaped object from the discovery snapshot so the
 * SAME threshold checks (TVL / fee-TVL / volatility / bin_step) can run against
 * it WITHOUT a re-fetch. Pure + exported for unit tests.
 *
 * Returns null (→ caller fail-closes) unless ALL of:
 *   - snapshot present with a numeric `discovered_at`
 *   - snapshot age <= DISCOVERY_REUSE_TTL_MS (not stale)
 *   - the threshold fields it needs (tvl, fee_active_tvl_ratio, volatility) are
 *     present finite numbers — fail-closed on any missing field (anti-pattern #2)
 *
 * This is NOT a guard bypass: the data is itself a verified live snapshot from
 * the discovery fetch seconds earlier, accepted only inside a tight TTL.
 */
export function buildReuseDetailFromSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const discoveredAt = numberOrNull(snapshot.discovered_at);
  if (discoveredAt == null || discoveredAt <= 0) return null;
  const age = now - discoveredAt;
  if (!Number.isFinite(age) || age < 0 || age > DISCOVERY_REUSE_TTL_MS) return null;

  const tvl = numberOrNull(snapshot.tvl);
  const feeActiveTvlRatio = numberOrNull(snapshot.fee_active_tvl_ratio);
  const volatility = numberOrNull(snapshot.volatility);
  // Fail-closed: require the gate-bearing metrics to be POSITIVE finite numbers.
  // numberOrNull(null) === 0 (Number(null)===0), so a `> 0` check (not just
  // `!= null`) is required to reject missing/zero metrics — a deployable pool
  // can never legitimately have 0 TVL / 0 fee-TVL / 0 volatility (anti-pattern #2).
  // bin_step is optional (executor falls back to the on-chain pool object);
  // volume/bot/top10 are the fresh-snapshot drift guard's job, not this gate.
  if (!(tvl > 0) || !(feeActiveTvlRatio > 0) || !(volatility > 0)) return null;

  return {
    tvl,
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility,
    dlmm_params: { bin_step: numberOrNull(snapshot.bin_step) },
    _reused_from_discovery: true,
    _snapshot_age_ms: age,
  };
}

export function isTransientFetchError(err) {
  if (!err) return false;
  // HTTP status carried on the error (set below for !res.ok)
  if (Number.isFinite(err.status)) {
    return err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
  }
  // Network-level: AbortError (timeout) or fetch TypeError ("fetch failed", ECONNRESET, etc.)
  const name = String(err.name || "");
  const msg = String(err.message || "").toLowerCase();
  if (name === "AbortError") return true;
  if (name === "TypeError" && msg.includes("fetch")) return true;
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("network")) return true;
  return false;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test seam: allow tests to inject a fake fetch + zero-out backoff sleeps.
 * Production code passes nothing → real global fetch, real backoff.
 */
let _snapshotFetchImpl = (...args) => fetch(...args);
let _snapshotBackoffMs = SNAPSHOT_FETCH_BACKOFF_MS;
export function __setSnapshotFetchForTests(fetchFn, backoffMs) {
  _snapshotFetchImpl = fetchFn || ((...a) => fetch(...a));
  _snapshotBackoffMs = backoffMs || SNAPSHOT_FETCH_BACKOFF_MS;
}
export function __resetSnapshotFetchForTests() {
  _snapshotFetchImpl = (...args) => fetch(...args);
  _snapshotBackoffMs = SNAPSHOT_FETCH_BACKOFF_MS;
}
// Test seam: exercise the retry-aware snapshot fetch directly.
export function __fetchFreshPoolDetailForTests(poolAddress, timeframe) {
  return fetchFreshPoolDetail(poolAddress, timeframe);
}

/**
 * Vega 2026-07-07 — 429-dedup peek seam. `validateDeployPoolThresholds` prefers
 * the already-fetched live discovery detail (Cassiopeia's peekDiscoveryDetailByAddress
 * in screening.js) over a redundant fetchFreshPoolDetail on every deploy. That
 * redundant fetch re-hit Meteora Pool-Discovery seconds after discovery already
 * pulled the same pool → 429 → snapshot_verify_failed on GOOD candidates. Reuse
 * removes ONLY the network fetch on a cache-hit; ALL threshold checks below still
 * run on the reused detail, and a null/miss falls through to fetchFreshPoolDetail
 * (fail-closed preserved). ESM namespace bindings can't be redefined for tests,
 * so route the peek through a settable impl.
 */
let _peekDiscoveryDetailImpl = (poolAddress, timeframe) => peekDiscoveryDetailByAddress(poolAddress, timeframe);
export function __setPeekDiscoveryDetailForTests(peekFn) {
  _peekDiscoveryDetailImpl = peekFn || ((p, t) => peekDiscoveryDetailByAddress(p, t));
}
export function __resetPeekDiscoveryDetailForTests() {
  _peekDiscoveryDetailImpl = (p, t) => peekDiscoveryDetailByAddress(p, t);
}

/**
 * Vega — bounded retry-with-backoff for the pre-deploy snapshot READ fetch.
 * Retries ONLY transient errors (429/502/503/504/timeout) up to
 * SNAPSHOT_FETCH_MAX_RETRIES with exponential backoff (~1s/2s/4s/8s/16s). Non-transient
 * errors throw immediately (no retry). When ALL retries are exhausted the last
 * error propagates → caller fail-closes (snapshot_verify_failed). This is
 * ride-through for transient bursts, NOT a guard bypass.
 */
async function fetchPoolDetailWithRetry(url) {
  let attempt = 0;
  // total attempts = 1 + SNAPSHOT_FETCH_MAX_RETRIES
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let res;
      try {
        res = await _snapshotFetchImpl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const err = new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (err) {
      const transient = isTransientFetchError(err);
      if (!transient || attempt >= SNAPSHOT_FETCH_MAX_RETRIES) {
        // Permanent error, OR transient but retries exhausted → propagate.
        // Caller (validateDeployPoolThresholds) fail-closes the deploy.
        throw err;
      }
      const wait = _snapshotBackoffMs[attempt] ?? _snapshotBackoffMs[_snapshotBackoffMs.length - 1];
      log("snapshot_fetch_retry", `transient ${err.status ?? err.name ?? "error"} on pre-deploy snapshot fetch, retry ${attempt + 1}/${SNAPSHOT_FETCH_MAX_RETRIES} in ${wait}ms`);
      await _sleep(wait);
      attempt += 1;
    }
  }
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetchPoolDetailWithRetry(url);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

/**
 * Vega X1 — Fresh snapshot guard for deploy_position.
 * Re-fetches live pool metrics right before deploy and compares vs the
 * original candidate snapshot the LLM saw. Aborts when material drift
 * indicates the opportunity has degraded since screening.
 *
 * Returns null on fetch failure (caller decides fail-open vs fail-closed).
 * Timeout: 5s hard cap via AbortController.
 */
export async function refreshPoolMetrics(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const detail = (data?.data || [])[0] ?? null;
    if (!detail) return null;
    return {
      volume24h: numberOrNull(detail.volume24h ?? detail.volume_24h ?? detail.volume),
      volatility: numberOrNull(detail.volatility),
      bot_pct: numberOrNull(detail.bot_holders_pct ?? detail.botHoldersPercentage ?? detail.bot_pct),
      top10_pct: numberOrNull(detail.top10_pct ?? detail.top_10_pct ?? detail.top10HoldersPct),
      dev_sold_all: Boolean(detail.dev_sold_all ?? detail.devSoldAll ?? false),
      raw: detail,
    };
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vega X1 — Compute material drift between original candidate and fresh snapshot.
 * Returns { materialDrift: bool, reasons: [] }. Each reason describes which
 * gate tripped so the safety layer can log a specific abort message.
 *
 * Drift gates:
 *   - volume24h drop >50%
 *   - volatility <= 0 or null
 *   - bot_pct rose >30% relative OR absolute >+5pp
 *   - top10_pct > 60%
 *   - dev_sold_all flipped false -> true
 */
export function computeDrift(original, fresh) {
  const reasons = [];
  if (!fresh) return { materialDrift: false, reasons };

  const origVol = numberOrNull(original?.volume24h);
  const freshVol = numberOrNull(fresh.volume24h);
  if (origVol != null && origVol > 0 && freshVol != null) {
    const dropPct = (origVol - freshVol) / origVol;
    if (dropPct > 0.5) {
      reasons.push(`volume24h dropped ${(dropPct * 100).toFixed(1)}% (${origVol} → ${freshVol})`);
    }
  }

  if (fresh.volatility == null || fresh.volatility <= 0) {
    reasons.push(`volatility ${fresh.volatility ?? "null"} unusable`);
  }

  const origBot = numberOrNull(original?.bot_pct);
  const freshBot = numberOrNull(fresh.bot_pct);
  if (freshBot != null && origBot != null) {
    const absRise = freshBot - origBot;
    const relRise = origBot > 0 ? (freshBot - origBot) / origBot : 0;
    if (relRise > 0.3 || absRise > 5) {
      reasons.push(`bot_pct rose ${origBot}% → ${freshBot}% (rel +${(relRise * 100).toFixed(1)}%, abs +${absRise.toFixed(1)}pp)`);
    }
  }

  if (freshBot != null && origBot == null && freshBot > 5) {
    reasons.push(`bot_pct now ${freshBot}% (original snapshot lacked baseline)`);
  }

  const freshTop10 = numberOrNull(fresh.top10_pct);
  if (freshTop10 != null && freshTop10 > 60) {
    reasons.push(`top10_pct ${freshTop10}% above 60% concentration cap`);
  }

  const origDev = Boolean(original?.dev_sold_all);
  const freshDev = Boolean(fresh.dev_sold_all);
  if (!origDev && freshDev) {
    reasons.push(`dev_sold_all flipped false → true since screening`);
  }

  return { materialDrift: reasons.length > 0, reasons };
}

async function validateDeployPoolThresholds(args) {
  let detail;
  // 429-DEDUP (Vega 2026-07-07): discovery just fetched this pool's live detail
  // seconds ago. Prefer that already-in-hand snapshot over a redundant network
  // fetch that trips Meteora 429. Deep clone from Cassiopeia's peek — non-null =>
  // use it as `detail` (skip the fetch entirely); ALL threshold checks below STILL
  // run on it. null (miss/stale/TTL-0/malformed) => fall through to the fetch path
  // exactly as before (fail-closed preserved). This is a proactive de-dup that
  // sits ABOVE the reactive buildReuseDetailFromSnapshot 429-exhaust ride-through.
  const peeked = _peekDiscoveryDetailImpl(args.pool_address);
  if (peeked) {
    detail = peeked;
    log(
      "snapshot_verify_peek",
      `pre-deploy detail reused from live discovery cache for ${args.pool_address} (no re-fetch → no 429); all threshold checks still run`,
    );
  }
  try {
    if (!detail) {
      detail = await fetchFreshPoolDetail(args.pool_address);
      if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
    }
  } catch (error) {
    // Vega 2026-06-20 — 429 ride-through fallback. The bounded retry-with-backoff
    // already ran inside fetchFreshPoolDetail (6 attempts, ~31s) for transient
    // 429/5xx/timeout. If we land here on a TRANSIENT error AND the discovery
    // snapshot from THIS cycle is fresh enough, verify against THAT (no re-fetch
    // → no 429) instead of fail-closing on a valid ENTER'd deploy. This is a
    // ride-through, NOT a bypass: the reused data is itself a verified live
    // snapshot inside a tight TTL, and the SAME threshold checks run on it below.
    if (isTransientFetchError(error)) {
      const reused = buildReuseDetailFromSnapshot(args.candidate_snapshot);
      if (reused) {
        log(
          "snapshot_verify_reuse",
          `pre-deploy re-fetch 429-exhausted for ${args.pool_address}; verifying against discovery snapshot age=${reused._snapshot_age_ms}ms (no re-fetch)`,
        );
        detail = reused;
      }
    }
    if (!detail) {
      // FAIL-CLOSED (anti-pattern #2/#3): non-transient error, retries exhausted
      // with NO reusable fresh discovery snapshot, or snapshot stale/incomplete.
      // We REFUSE to deploy on stale/unverified data. snapshot_verify_failed
      // marker lets monitoring tell a transient-exhaustion reject from a breach.
      return {
        pass: false,
        reason: `snapshot_verify_failed: could not verify pool screening thresholds before deploy: ${error.message}`,
      };
    }
  }

  // Bluechip deploy-side exemption (Vega money-path, mirrors screening carve-out):
  // a WHITELIST bluechip pair (flag ON) is a DEEP STABLE pool — the memecoin gates
  // maxTvl ($150k), minFeeActiveTvlRatio floor (0.10) and the vol>0 floor are all
  // mis-targeted for it (deep TVL = GOOD, bluechip fee/TVL is lower, vol is a CEILING
  // not a floor). When exempt, those three gates are replaced by bluechip semantics
  // (no maxTvl ceiling; bluechip fee/TVL floor; vol ceiling). Non-whitelist or flag
  // OFF → memecoin path below, byte-for-byte unchanged. FAIL-CLOSED throughout.
  const isBluechipExempt = isBluechipBinStepExempt(args, detail);
  // Two-sided PAPER-lane curated-LST exemption (paper-isolated). See isTwoSidedPaperLstExempt:
  // NEVER true in live / flag-off / non-LST. When true, the maxTvl ceiling (GATE 1), vol floor
  // (GATE 3) and binStep range are re-targeted exactly like the bluechip lane; the fee/TVL floor
  // (GATE 2) is DROPPED to mirror screening's twoSidedPaperBluechipGateReason (low fee/TVL is the
  // EXPECTED profile of a ~1% APR symmetric LST-SOL pair — applying even bluechipMinFeeTvlRatio
  // 0.03 would RE-BLOCK the exact pool this lane exists to paper-validate).
  const isPaperLstExempt = isTwoSidedPaperLstExempt(args, detail);
  // Deep-pool exemption drives the maxTvl ceiling skip, the vol floor→ceiling inversion and the
  // binStep floor skip for EITHER the bluechip income lane OR the two-sided paper LST lane.
  const isDeepExempt = isBluechipExempt || isPaperLstExempt;

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  // GATE 1 — maxTvl ceiling: EXEMPT for bluechip (a deep $245k SOL-USDC pool is the
  // ideal income target, not a risk) AND for the two-sided paper LST lane (a deep
  // JitoSOL-SOL income pair is the POINT). Memecoin path keeps the ceiling unchanged.
  if (!isDeepExempt && maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const feeTvlRatio = poolDetailFeeTvlRatio(detail);
  const requestedFeeTvlRatio = numberOrNull(args.fee_tvl_ratio);
  const effectiveFeeTvlRatio = [feeActiveTvlRatio, feeTvlRatio, requestedFeeTvlRatio]
    .filter((value) => value != null)
    .reduce((best, value) => Math.max(best, value), -Infinity);
  // GATE 2 — fee/TVL floor, per-lane:
  //   - two-sided paper LST lane → DROPPED (null, no floor). Mirrors screening's
  //     twoSidedPaperBluechipGateReason: low fee/TVL is the EXPECTED profile of a ~1% APR
  //     symmetric SOL-tracking pair with near-zero IL; the yield bar is the exact inversion
  //     trap that would RE-BLOCK the pool. Paper lane is DRY_RUN-only → dropping a yield
  //     bar carries ZERO money risk (base-leg rug/safety enforced upstream by Cassiopeia).
  //   - bluechip income lane → LOWER bluechipMinFeeTvlRatio (0.03, ~11% APR).
  //   - memecoin → full minFeeActiveTvlRatio (0.10).
  // Still FAIL-CLOSED for the memecoin + bluechip lanes: a missing fee/TVL reading is rejected
  // (never default to passing). The paper LST lane intentionally has no floor to reject against.
  const effectiveFeeFloor = isPaperLstExempt
    ? null
    : isBluechipExempt
      ? numberOrNull(config.screening.bluechipMinFeeTvlRatio)
      : numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    effectiveFeeFloor != null &&
    effectiveFeeFloor > 0 &&
    (!Number.isFinite(effectiveFeeTvlRatio) || effectiveFeeTvlRatio < effectiveFeeFloor)
  ) {
    return {
      pass: false,
      reason: isBluechipExempt
        ? `Bluechip pool fee/TVL ratio ${Number.isFinite(effectiveFeeTvlRatio) ? effectiveFeeTvlRatio : "unknown"} is below bluechipMinFeeTvlRatio ${effectiveFeeFloor}.`
        : `Pool fee/TVL ratio ${Number.isFinite(effectiveFeeTvlRatio) ? effectiveFeeTvlRatio : "unknown"} is below configured minFeeActiveTvlRatio ${effectiveFeeFloor}.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    // 429-DEDUP (Vega 2026-07-07): same proactive reuse for the secondary
    // volatility-timeframe read. Prefer the already-fetched discovery detail for
    // THIS timeframe over a redundant fetch. non-null => use it (skip fetch, vol
    // floor/ceiling check below still runs on it); null => fetch as before, and
    // the existing transient-exhaust ride-through / fail-close is untouched.
    const peekedVol = _peekDiscoveryDetailImpl(args.pool_address, volatilityTimeframe);
    if (peekedVol) {
      volatilityDetail = peekedVol;
    } else {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      // Vega 2026-06-20 — same 429 ride-through: if this secondary volatility
      // re-fetch transient-exhausts but `detail` already came from the reused
      // discovery snapshot, fall back to it (its volatility is the deploy-tf
      // value, sufficient for the floor check). Else fail-close (preserved).
      if (isTransientFetchError(error) && detail?._reused_from_discovery) {
        volatilityDetail = detail;
      } else {
        return {
          pass: false,
          reason: `snapshot_verify_failed: could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
        };
      }
    }
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  // GATE 3 — volatility: for MEMECOIN this is a FLOOR (vol>0 required; a stable/dead
  // reading = refuse). For BLUECHIP it INVERTS to a CEILING — a stable pool legitimately
  // reads ~0 vol and that is GOOD (SOL-USDC vola ~0.1); a WILD reading means it isn't
  // behaving as a stable bluechip (de-peg / thin book) and IS rejected. Low/zero vol is
  // tolerated for bluechip AND the two-sided paper LST lane (both mirror screening's
  // bluechip / twoSidedPaperBluechipGateReason vol-ceiling semantics — low/zero vol is the
  // GOOD stable state, only a WILD reading = de-peg/thin book is rejected).
  if (isDeepExempt) {
    const maxVola = numberOrNull(config.screening.bluechipMaxVolatility);
    if (maxVola != null && maxVola > 0 && volatility != null && volatility > maxVola) {
      return {
        pass: false,
        reason: `Bluechip pool ${volatilityTimeframe} volatility ${volatility} is above bluechipMaxVolatility ${maxVola}. Not behaving as a stable bluechip — refusing deploy.`,
      };
    }
  } else if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  // Bluechip / two-sided-paper-LST deploy-side binStep exemption: a WHITELIST bluechip
  // pair (flag ON) OR a paper-lane curated LST-SOL pair is exempt from the memecoin
  // [minBinStep,maxBinStep] floor (SOL-USDC bin_step=1 and LST-SOL fine bin_steps are
  // legitimate — screening's paper lane never checks binStep either). A sane absolute
  // bound still applies (fail-closed). Non-exempt → memecoin floor below, byte-unchanged.
  if (isDeepExempt) {
    const sanity = bluechipBinStepSanityReject(actualBinStep);
    if (sanity) {
      return { pass: false, reason: sanity };
    }
  } else {
    if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
      return {
        pass: false,
        reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
      };
    }
    if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
      return {
        pass: false,
        reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
      };
    }
  }

  return { pass: true };
}

// Test seam: exercise the full pre-deploy threshold verify (incl. 429 ride-through
// + reuse-discovery fallback) against an injected snapshot fetch.
export function __validateDeployPoolThresholdsForTests(args) {
  return validateDeployPoolThresholds(args);
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  partial_close_position: partialClosePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // swap-path slippage ceiling (Vega money-path hardening)
      swapMaxSlippageBps: ["jupiter", "swapMaxSlippageBps"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "partial_close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Vega 2026-07-11 — pre-close wallet snapshot REMOVED ──────
  // The wallet-delta method it fed was Lyra-forensic-confirmed to lie under
  // maxPositions>1 (a concurrent position's returned modal corrupts the wallet
  // snapshot → this trade's realized figure inflates, the fake "+55%"). The
  // notify now surfaces the per-trade-attributed LEDGER figure (see the close
  // handler below), so no pre-close wallet read is needed.

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    // Vega fix #2 — structured Telegram alert when deploy_position returns failure.
    // No retry, no state mutation; operator-only signal so manual on-chain verify can happen.
    if (!success && name === "deploy_position") {
      try {
        const balances = await getWalletBalances({}).catch(() => null);
        const walletSol = balances?.sol != null ? Number(balances.sol).toFixed(4) : null;
        notifyDeployFailure({
          pool: {
            symbol: result?.pool_name || args.pool_name || null,
            address: args.pool_address || result?.pool || null,
          },
          error: { message: result?.error || result?.reason || "deploy_position returned failure" },
          walletBalance: walletSol,
        }).catch(() => {});
      } catch (_e) { /* alert must never escalate */ }
    }

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        // Bro wants live pulse for DRY_RUN paper deploys too. DRY result shape:
        // { dry_run: true, would_deploy: { pool_address, amount_y, bins_below, ... } }
        const isDry = result?.dry_run === true || process.env.DRY_RUN === "true";
        const wd = result?.would_deploy || {};
        // Vega honesty-audit 2026-06-21 FIX #2 — record the modal as a KNOWN,
        // EXPECTED outflow so the burner drain monitor does NOT false-flag the
        // wallet drop caused by SOL moving into the LP. LIVE only — a paper deploy
        // moves no real SOL, so there is no real wallet drop to explain.
        if (!isDry) {
          const modalSol = Number(args.amount_y ?? args.amount_sol ?? wd.amount_y ?? wd.amount_sol ?? 0);
          if (Number.isFinite(modalSol) && modalSol > 0) {
            try { recordDeployOutflow(modalSol); } catch (_e) { /* never block deploy notify */ }
          }
          // Vega 2026-07-11 FIX #2 — deploy-gas visibility. The per-trade realized
          // formula (realized-sol.js) captures IL + exit slippage + CLOSE gas but
          // NOT the DEPLOY-leg gas (~0.003 SOL/tx; ~0.042 SOL/day at 14 deploys —
          // ~half the daily tuition, previously invisible). Record an ESTIMATE
          // (DEFAULT_DEPLOY_GAS_SOL × observed tx-count) into a rolling daily
          // aggregate the audit (Lyra) reads via getDeployGasDailySol(). Estimate-
          // only, additive, does NOT touch the per-trade close formula (no double-
          // count risk). Reporting-only — never blocks the deploy notify.
          const deployTxCount = Array.isArray(result.txs) && result.txs.length > 0
            ? result.txs.length
            : (result.tx ? 1 : 1);
          try { recordDeployGas(DEFAULT_DEPLOY_GAS_SOL * deployTxCount); } catch (_e) { /* never block deploy notify */ }
        }
        notifyDeploy({
          pair: result.pool_name || args.pool_name || wd.pool_address?.slice(0, 8) || args.pool_address?.slice(0, 8),
          // Report the AUTHORITATIVE deployed amount (post-cap finalAmountY = chain
          // truth) first; result.* is undefined on the DRY path so the paper fallback
          // is preserved. Never print the pre-cap request again. (Vega reporting-bug fix)
          amountSol: result.amount_y ?? result.amount_sol ?? args.amount_y ?? args.amount_sol ?? wd.amount_y ?? wd.amount_sol ?? 0,
          position: result.position,
          tx: result.txs?.[0] ?? result.tx,
          priceRange: result.price_range,
          rangeCoverage: result.range_coverage,
          binStep: result.bin_step,
          baseFee: result.base_fee,
          dryRun: isDry,
        }).catch(() => {});
      } else if (name === "close_position") {
        const isDry = result?.dry_run === true || process.env.DRY_RUN === "true";
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold.
        // Vega 2026-07-14 — TWO-SIDED close SKIPS this single-side dust-swap:
        // dlmm.closePosition already liquidated the FULL token-X bag → SOL and
        // booked the honest two-asset realized-SOL (result.two_sided). Re-swapping
        // here would double-swap / mis-account. Single-side (result.two_sided
        // falsy) is byte-for-byte unchanged.
        if (!args.skip_swap && result.base_mint && !result.two_sided) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              if (swapResult?.skipped) {
                // Vega slippage guard skipped the optional dust swap — the CLOSE
                // already succeeded on-chain; the token stays in the wallet. Be
                // HONEST to the model: do NOT claim it was swapped.
                result.auto_swapped = false;
                result.auto_swap_skipped = true;
                result.auto_swap_note = `Post-close swap of ${token.symbol || result.base_mint.slice(0, 8)} → SOL SKIPPED by slippage guard (${swapResult.detail}). Token remains in wallet; retry manually when the pool is less thin. Position is already closed.`;
                log("executor_warn", `Post-close dust swap skipped (slippage guard): ${swapResult.detail}`);
              } else {
                // Tell the model the swap already happened so it doesn't call swap_token again
                result.auto_swapped = true;
                result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
                if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
              }
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }

        // Vega 2026-07-11 — realized SOL delta, SINGLE SOURCE OF TRUTH = the LEDGER.
        //
        // The notify now surfaces the EXACT per-trade-attributed figure dlmm.js
        // already wrote into lessons.json (`received + fees - deployed - close_gas`,
        // threaded here as result.ledger_realized_sol_*). Telegram + the LLM result
        // therefore report the IDENTICAL number the learning loop books.
        //
        // The old wallet-delta method (wallet_after - wallet_before - deployed) is
        // GONE: Lyra forensic-confirmed it lies under maxPositions>1, because a
        // CONCURRENT position's returned modal lands in the same wallet snapshot and
        // is miscounted as this trade's profit (the fake "+55%"). Wallet-delta is
        // unfixable without per-trade wallet attribution — which the formula path
        // already does correctly — so we use the ledger figure everywhere.
        //
        // Anti-pattern #2: if the ledger figure is missing, honest null — NEVER a
        // wallet-inflated fallback. Additive only — lp_pnl_pct is left untouched.
        if (!isDry && config.internalAgents?.realizedSolAccounting !== false) {
          const notifRsd = selectNotifyRealizedSol(result);
          result.realized_sol_delta = notifRsd.realized_sol_delta;
          result.realized_sol_delta_pct = notifRsd.realized_sol_delta_pct;
          result.realized_sol_method = notifRsd.realized_sol_method;
          result.realized_sol_estimate = notifRsd.realized_sol_estimate;
          result.lp_pnl_pct = result.pnl_pct ?? null; // explicit label: price-only LP-PnL
        }

        // Fire close notification AFTER auto-swap + realized-delta so the message
        // carries the TRUE economic outcome next to the price-only LP-PnL.
        notifyClose({
          pair: result.pool_name || args.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          pnlSol: result.pnl_sol,
          feesSol: result.fees_claimed_sol ?? result.fees_sol,
          durationMin: result.duration_min,
          feeInclusivePnlPct: result.fee_inclusive_pnl_pct,
          lpPnlPct: result.lp_pnl_pct ?? result.pnl_pct ?? null,
          realizedSolDelta: result.realized_sol_delta,
          realizedSolDeltaPct: result.realized_sol_delta_pct,
          realizedSolEstimate: result.realized_sol_estimate,
          positionAddress: args.position_address,
          dryRun: isDry,
        }).catch(() => {});
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Vega fix #2 — structured Telegram alert when deploy_position throws.
    // Anti-Pattern #4: no retry, just notify so operator can verify on-chain.
    if (name === "deploy_position") {
      try {
        const balances = await getWalletBalances({}).catch(() => null);
        const walletSol = balances?.sol != null ? Number(balances.sol).toFixed(4) : null;
        notifyDeployFailure({
          pool: {
            symbol: args.pool_name || null,
            address: args.pool_address || null,
          },
          error,
          walletBalance: walletSol,
        }).catch(() => {});
      } catch (_e) { /* alert must never escalate */ }
    }

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Account-level daily loss guard — must be first, before any other validation.
      //
      // INVARIANT (Vega 2026-07-14, false-"daily loss reached" incident): the daily-loss
      // BLOCK decision is derived SOLELY from the authoritative realized-loss ledger inside
      // account-circuit-breaker.js (`state.realized_loss_sol` / `state.halted`, set only by
      // recordRealizedLoss on a CLOSED position). It is NEVER a wallet-delta
      // (day-start balance − current liquid balance). The live SOL balance read below is
      // passed to assertCircuitOK for ONE purpose only: seeding `starting_balance_sol` on
      // the first deploy-check of a new UTC day. On an already-seeded day the balance is
      // ignored entirely (getOrInitState returns the existing state untouched).
      //
      // WHY this matters: when capital is DEPLOYED in an open position, the liquid balance
      // dips (recoverable capital, not loss). A wallet-delta check would misread that dip as
      // a "daily loss" and falsely block deploys — the exact false-positive class already
      // killed in the notify path (f7abb852). This guard cannot do that: it reads realized
      // loss, not liquid balance. DO NOT reintroduce a wallet-delta comparison here.
      // Regression lock: scripts/test-circuit-deployed-capital-dip.js.
      try {
        const balForCircuit = process.env.DRY_RUN !== "true"
          ? (await getWalletBalances().catch(() => null))?.sol ?? null
          : null;
        await assertCircuitOK(Number.isFinite(balForCircuit) ? balForCircuit : null);
      } catch (e) {
        if (e instanceof CircuitBreakerError) {
          return { pass: false, reason: e.message };
        }
        throw e;
      }

      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;

      // Vega X1 — Fresh snapshot guard. Re-fetch live metrics and compare to
      // the candidate snapshot the LLM saw. Aborts on material drift.
      // Single boolean flip (config.internalAgents.freshSnapshotGuardEnabled)
      // for emergency reversibility. Fetch failure fails open (refreshPoolMetrics
      // returns null → computeDrift returns no drift) so we never deadlock on
      // upstream API hiccups; the prior validateDeployPoolThresholds already
      // hard-fails closed on volatility/TVL fetch failure.
      if (config.internalAgents?.freshSnapshotGuardEnabled !== false) {
        const original = args.candidate_snapshot ?? args.original_snapshot ?? {
          volume24h: numberOrNull(args.volume24h ?? args.volume_24h),
          bot_pct: numberOrNull(args.bot_pct ?? args.bot_holders_pct),
          top10_pct: numberOrNull(args.top10_pct ?? args.top_10_pct),
          dev_sold_all: Boolean(args.dev_sold_all),
        };
        const fresh = await refreshPoolMetrics(args.pool_address);
        const drift = computeDrift(original, fresh);
        if (drift.materialDrift) {
          return {
            pass: false,
            reason: `Fresh snapshot guard aborted deploy: ${drift.reasons.join("; ")}`,
          };
        }
      }

      // Reject pools with bin_step out of configured range.
      // Bluechip deploy-side exemption (Vega — Opsi B, money-path): a WHITELIST
      // bluechip pair (flag ON) is exempt from the memecoin [minBinStep,maxBinStep]
      // range (SOL-USDC bin_step=1). A sane absolute bound still applies (fail-closed:
      // 0/negative/non-integer/over-ceiling refused). Non-whitelist or flag OFF →
      // memecoin range below, byte-for-byte unchanged. Whitelist is NON-NEGOTIABLE.
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (isBluechipBinStepExempt(args) || isTwoSidedPaperLstExempt(args)) {
        const sanity = bluechipBinStepSanityReject(
          args.bin_step != null ? Number(args.bin_step) : null,
        );
        if (sanity) {
          return { pass: false, reason: sanity };
        }
      } else if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      // ── Two-sided pre-deploy gate (Vega — PAPER-ONLY, flag-gated) ──
      // Mirrors the money-path gate in dlmm.deployPosition so amount_x>0 is
      // refused at the earliest point unless two-sided is ON *and* DRY_RUN.
      // Flag OFF ⇒ identical refusal string as before (byte-unchanged). Flag ON
      // + LIVE ⇒ paper-only-belt refusal (two independent belts).
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        const twoSidedGate = twoSidedGateDecision(config, process.env.DRY_RUN);
        if (!twoSidedGate.allowed) {
          return { pass: false, reason: twoSidedGate.refuseReason };
        }
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      // Dust floor only. Phase-1 sizing (Bro-approved 0.03/0.05) must clear, so the
      // hard floor is 0.02 (dust guard, not a sizing floor). config.deployAmountSol can
      // still raise it. The Phase-1 0.05 per-position CAP below + dlmm.js cap are the
      // money-side belts and are UNCHANGED. (Vega — go-live floor drop 0.1→0.02)
      const minDeploy = Math.max(0.02, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // ── Phase-1 live per-position HARD CAP suspenders (Vega — go-live) ──
      // dlmm.deployPosition is the AUTHORITATIVE belt (code-pinned MAX_LIVE_POSITION_SOL).
      // This refuses earlier, at the executor, so a config maxDeployAmount mis-set above
      // 0.05 can never let an oversized LIVE memecoin deploy through. Bluechip pairs use
      // their own bluechipCap above; DRY_RUN exempt (paper soak sizes freely).
      if (process.env.DRY_RUN !== "true" && !(config.screening?.bluechipModeEnabled === true && args.base_mint && (args.quote_mint ?? args.quote_address) && isBluechipMintPair(args.base_mint, args.quote_mint ?? args.quote_address))) {
        const liveCap = Math.min(MAX_LIVE_POSITION_SOL, Number(config.risk?.maxDeployAmount ?? MAX_LIVE_POSITION_SOL));
        if (amountY > liveCap) {
          return {
            pass: false,
            reason: `SOL amount ${amountY} exceeds the Phase-1 live per-position cap ${liveCap} SOL (hard belt ${MAX_LIVE_POSITION_SOL}).`,
          };
        }
      }

      // ── Bluechip per-position SOL cap (Vega — Opsi B, executor suspenders) ──
      // dlmm.deployPosition is the AUTHORITATIVE belt (it classifies from the live
      // on-chain pool mints). This is best-effort suspenders using the args metadata:
      // it fires only when bluechip mode is ON AND both legs are present and classify
      // as a whitelisted bluechip pair. When the engine is OFF, or the pair can't be
      // classified here, we fall through to the memecoin maxDeployAmount above and let
      // dlmm.js make the final call. Memecoin path: untouched when flag OFF.
      if (config.screening?.bluechipModeEnabled === true) {
        const quoteMint = args.quote_mint ?? args.quote_address ?? null;
        if (args.base_mint && quoteMint && isBluechipMintPair(args.base_mint, quoteMint)) {
          const bluechipCap = Math.min(
            0.45, // mirrors dlmm.js MAX_BLUECHIP_POSITION_SOL hard belt
            Number(config.risk?.maxBluechipPositionSol ?? 0.45),
          );
          if (amountY > bluechipCap) {
            return {
              pass: false,
              reason: `Bluechip SOL amount ${amountY} exceeds the bluechip cap (${bluechipCap}).`,
            };
          }
        }
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        // ── Two-sided coverage (Vega — go-live seam fix) ──
        // A single-side deploy spends only amountY (the Y-leg SOL). A TWO-SIDED
        // deploy ALSO spends the X-leg: ~half the notional is swapped SOL→token-X
        // before the deposit, so the true SOL leaving the wallet is the FULL
        // two-leg notional, NOT just amountY. The executor has no price here to
        // value the token leg, so we reserve the CONSERVATIVE upper bound = the
        // effective total-notional cap (actual notional can only be ≤ this — the
        // dlmm assertTwoSidedNotionalCap belt binds it). Without this, the coverage
        // gate under-reserves two-sided by the X-leg and can eat into gasReserve.
        // Single-side (deployAmountX<=0) → coverageAmount === amountY, byte-unchanged.
        const coverageAmount =
          Number.isFinite(deployAmountX) && deployAmountX > 0
            ? resolveTwoSidedNotionalCapSol(config)
            : amountY;
        const reject = solCoverageRejectReason(balance, coverageAmount, gasReserve);
        if (reject) return { pass: false, reason: reject };
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "partial_close_position": {
      // Vega Item 2B — refuse a partial that is not strictly fractional.
      // Belt-and-suspenders: dlmm.partialClosePosition rejects too, but a
      // malformed pct must NEVER reach the SDK as a full (100%) pull, which
      // would close the account behind the manager's back.
      const pct = Number(args?.pct);
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
        return {
          pass: false,
          reason: `partial_close_position pct ${args?.pct} invalid — must be in (0,100). Use close_position for a full close.`,
        };
      }
      if (!args?.position_address) {
        return { pass: false, reason: "partial_close_position requires position_address." };
      }
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
