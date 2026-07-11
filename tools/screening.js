import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown, recordSignalSighting } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { fetchSolscanTrending } from "./sources/solscan-trending.js";
import { fetchPumpfunGraduated } from "./sources/pumpfun-graduated.js";
import { fetchDiscordMeteoraIdnRanked } from "./sources/discord-meteoraidn.js";
import { getTokenHolderCount } from "./token.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

// Holder-count enrich cache (Cassiopeia — enrich-before-gate for signal pools).
// Signal sources (discord/solscan/pumpfun) often arrive WITHOUT base_token_holders
// because the upstream cross-ref didn't carry it. Rather than killing them at the
// holder floor on a DATA-MISSING (not a real low count), we fetch the real count
// once per mint and let the floor judge the real number. Cached by mint with TTL
// so the same mint isn't re-fetched every screening cycle.
const HOLDER_COUNT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — count moves slowly
const _holderCountCache = new Map(); // mint -> { count: number|null, ts: number }

// Native-detail enrich cache (Cassiopeia — enrich-before-gate for cross-ref pools).
// Cross-ref signal pools (discord/solscan/pumpfun via dlmm.datapi.meteora.ag) arrive
// WITHOUT volatility + organic_score: those fields are a STRUCTURAL GAP on the
// cross-ref endpoint (confirmed by Sirius's exhaustive shape audit — see
// meteora-crossref.js header). They are NOT real zeros; the cross-ref index simply
// never carried them, so the pools died at the volatility/organic gates on
// DATA-MISSING. The NATIVE Pool-Discovery detail endpoint
// (pool-discovery-api.datapi.meteora.ag, queried by pool_address) DOES expose them
// as proper scalars (verified live: volatility/organic_score/fee_active_tvl_ratio/
// created_at/market_cap all present). One native detail fetch per surviving pool
// fills every gap at once. Cached by pool_address with TTL so the same pool isn't
// re-fetched every cycle. Vol moves on the 5-30m feed → keep this TTL short.
const NATIVE_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — volatility is time-sensitive
const _nativeDetailCache = new Map(); // pool_address -> { detail: object|null, ts: number }

// Wrapped SOL mint. We deploy single-side SOL ONLY (executor.js refuses
// amount_x>0), so any pool quoted in something else (USDC, etc.) is
// undeployable. Used by solQuoteRejectReason() to cut undeployable waste
// pre-LLM. Exact 32-byte wSOL mint — do not abbreviate.
const WSOL_MINT = "So11111111111111111111111111111111111111112";
// USDC mint. Together with wSOL these are the inherently-liquid blue-chip quote
// tokens. They have no meaningful "organic score" (organic measures base-token
// holder authenticity, which is nonsensical for a stablecoin / wrapped SOL), so
// the quote-organic gate must EXEMPT them — gating quote-organic on a blue-chip
// quote rejects 100% of otherwise-valid SOL/USDC-quoted pools (misconfig, not
// protection). See QUOTE_ORGANIC_EXEMPT_MINTS / quoteOrganicGateRejectReason.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Blue-chip quote mints exempt from the quote-organic gate. Note: this bot
// deploys single-side SOL only, so solQuoteRejectReason() further restricts the
// DEPLOYABLE set to wSOL alone; USDC is kept here so the gate stays correct even
// if the SOL-quote pre-filter is ever disabled (defense in depth).
const QUOTE_ORGANIC_EXEMPT_MINTS = new Set([WSOL_MINT, USDC_MINT]);

// Blue-chip BASE mints exempt from the market-regime downtrend pause (Cassiopeia —
// STOP BLEED T3). A blue-chip base token (wSOL, USDC, USDT, major bridged BTC/ETH)
// has a SYMMETRIC LP payoff and keeps paying fees both ways in a downtrend, so it
// must NOT be paused like a memecoin narrow-range pool. For now (no bluechip mode)
// the deployable funnel is all memecoins, so this set just future-proofs the gate —
// adding the Phase 1 bluechip allow-list later is a one-line edit here.
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BLUECHIP_BASE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// ─── Bluechip income-engine mint set (Cassiopeia — Wave 2 / Phase 1) ──────────
//
// The income engine LPs DEEP, STABLE pools (SOL-USDC, JLP, JitoSOL, mSOL, major
// LSTs) for steady fees with a (near-)SYMMETRIC payoff — the opposite profile from
// the memecoin narrow-range path. A pool is "bluechip-eligible" only when BOTH legs
// are in this curated set: a pool with one bluechip leg and one random memecoin leg
// is NOT a stable LP (it carries the memecoin's directional risk). These are the
// inherently-liquid, rug-immune, audited assets where the question is "is the fee
// yield worth the IL" rather than "is this a scam."
//
// Live-verified (2026-06-20 probe): at TVL>=200k, BOTH-leg bluechip pools = 23, of
// which ~8 carry real volume (>50k/24h). SOL-USDC alone has 4 deep deployable pools
// (bs 4/10/20/80) running 32-75% APR on full TVL. So the funnel is FEW-but-DEEP —
// exactly the income-engine thesis (cf. memecoin path which is many-but-shallow).
//
// NOTE: mSOL/bSOL/JLP mints are the canonical Solana addresses. JLP base mcap is
// huge (~$770M pool token) so the memecoin mcap band would reject it — bluechip
// mode uses its OWN band (see bluechipPoolGateRejectReason). Extend this set as new
// blue-chip LSTs/stables qualify (one-line add per mint).
const JLP_MINT  = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL_MINT = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1";
const JUPSOL_MINT = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const CBBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"; // Coinbase wrapped BTC
export const BLUECHIP_INCOME_MINTS = new Set([
  WSOL_MINT, USDC_MINT, USDT_MINT,
  JLP_MINT, JITOSOL_MINT, MSOL_MINT, BSOL_MINT, JUPSOL_MINT, CBBTC_MINT,
]);

/**
 * Pure whitelist predicate on a RAW mint pair (NOT a pool object). This is the
 * deploy-side authoritative guard used by dlmm.deployPosition / executor — a pool
 * is bluechip-deployable ONLY when BOTH legs are in BLUECHIP_INCOME_MINTS. Single
 * source of truth shared with classifyPoolMode (which derives legs from a pool obj).
 * FAIL-CLOSED: any missing/empty leg → false (never let an unknown mint into the
 * laxer bluechip lane). Exported so the money path imports the SAME curated set —
 * no second mint list to drift.
 *
 * @param {string} baseMint  - token X mint (base58)
 * @param {string} quoteMint - token Y mint (base58)
 * @returns {boolean} true iff BOTH legs are whitelisted bluechip income mints
 */
export function isBluechipMintPair(baseMint, quoteMint) {
  if (!baseMint || !quoteMint) return false;
  return BLUECHIP_INCOME_MINTS.has(baseMint) && BLUECHIP_INCOME_MINTS.has(quoteMint);
}

// Broad-discovery page cache (Cassiopeia — 429 ROOT-CAUSE FIX, 2026-06-20).
// Lyra: `fetchPoolDiscoveryPage` pulls page_size=1000 EVERY screening cycle
// (~every 15-30 min) and 3 separate services (meridian + signal-runner +
// auto-screener) hammer the same Meteora Pool-Discovery endpoint → chronic 429,
// trending up 5→13/hr → deploys blocked. The pool universe does NOT shift
// meaningfully over a few minutes, so a short-TTL cache of the RAW 1000-pool
// page lets repeated cycles (and the snapshot-verify reuse path) reuse the same
// fetch instead of re-hitting the API. Keyed by the EXACT request params
// (page_size + filters + timeframe + category + sort_by) so a different filter
// set / timeframe / sort never serves a stale or wrong page.
//
// CONSTRAINTS held:
//  - Breadth UNTOUCHED: we cache the full 1000-pool raw page; the strict client
//    gate runs normally on top of it every cycle.
//  - Quality UNTOUCHED: only the RAW fetch is cached, not the gate result. Gate,
//    enrichment, vol-refetch all run fresh on the cached raw set each cycle.
//  - FAIL-SAFE (anti-pattern #2): cache miss / expired → fresh fetch. A failed
//    fetch is NEVER cached (error propagates, no poisoning). An empty result is
//    only cached if the API genuinely returned an empty page — never deploy on a
//    fabricated empty cache (the gate downstream already refuses an empty funnel).
//  - We serve a DEEP CLONE: downstream stamps mutate pool objects (volatility
//    refetch, source tags); handing out the cached reference would corrupt the
//    cache across cycles. Clone isolates each cycle.
// TTL is configurable (broadDiscoveryCacheTtlMin, default 7 min — mid 5-10 band:
// long enough to collapse same-cycle thundering-herd, short enough that no deploy
// rides a >7-min-stale universe). Set 0 → cache OFF (fully reversible).
const _discoveryPageCache = new Map(); // key -> { data: object, ts: number }

function _discoveryCacheKey({ page_size, filters, timeframe, category, sort_by }) {
  return JSON.stringify({ page_size, filters, timeframe, category, sort_by: sort_by || null });
}

function _discoveryCacheTtlMs() {
  const min = numeric(config.screening?.broadDiscoveryCacheTtlMin);
  // default 7 min; <=0 disables the cache (always-fresh fetch).
  if (min == null) return 7 * 60 * 1000;
  return Math.max(0, min) * 60 * 1000;
}

/**
 * Read-only cache peek for the Vega snapshot-verify reuse path: returns the
 * cached raw discovery page (deep-cloned) if a fresh (within-TTL) entry exists
 * for the given request key, else null. Lets snapshot-verify reuse the
 * discovery fetch instead of re-hitting the API (its own 429 source). Never
 * triggers a fetch — pure read. Exported.
 */
export function peekDiscoveryCache(reqParams) {
  const ttl = _discoveryCacheTtlMs();
  if (ttl <= 0) return null;
  const key = _discoveryCacheKey(reqParams);
  const hit = _discoveryPageCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) return null;
  return JSON.parse(JSON.stringify(hit.data));
}

/**
 * By-address reuse primitive for the Vega pre-deploy snapshot-verify path (429
 * ROOT-CAUSE, Cassiopeia). Returns a within-TTL cached RAW pool-detail object for
 * `poolAddress` (DEEP-CLONED), or null when nothing fresh is cached. **Read-only —
 * never triggers a fetch.** Checks the per-pool detail cache first (freshest
 * single-pool detail), then scans the broad page cache for a matching
 * `pool_address`. This lets `validateDeployPoolThresholds` (executor.js, Vega's
 * money-path) reuse the pool data the discovery fetch ALREADY pulled this cycle
 * instead of re-hitting the Pool-Discovery endpoint — the redundant re-fetch is
 * itself the 429 source (Draco 2026-07-07).
 *
 * FAIL-CLOSED PRESERVED (anti-pattern #2): any miss, stale entry, disabled cache,
 * empty page, or absent address → null. The caller MUST treat null as "no reuse"
 * and fall through to its own fetch + existing fail-closed guard — this primitive
 * NEVER fabricates a detail and NEVER lets a deploy proceed on unverified data.
 * The reused object is a real live snapshot from the discovery fetch seconds
 * earlier, bounded by the SAME cache TTLs that govern discovery reuse. Exported.
 */
export function peekDiscoveryDetailByAddress(poolAddress, timeframe = config.screening?.timeframe || "5m") {
  if (!poolAddress) return null;
  const now = Date.now();

  // 1. Per-pool detail cache — exact (address|timeframe) key, freshest source.
  const detailTtl = _discoveryDetailCacheTtlMs();
  if (detailTtl > 0) {
    const hit = _discoveryDetailCache.get(`${poolAddress}|${timeframe}`);
    if (hit && hit.detail != null && now - hit.ts <= detailTtl) {
      return JSON.parse(JSON.stringify(hit.detail));
    }
  }

  // 2. Broad page cache — scan within-TTL pages for the pool by pool_address.
  const pageTtl = _discoveryCacheTtlMs();
  if (pageTtl > 0) {
    for (const hit of _discoveryPageCache.values()) {
      if (!hit || now - hit.ts > pageTtl) continue;
      const pools = hit.data?.data;
      if (!Array.isArray(pools)) continue;
      const match = pools.find((p) => p?.pool_address === poolAddress);
      if (match) return JSON.parse(JSON.stringify(match));
    }
  }
  return null;
}

/** Test/ops hook — clear both discovery caches (page + per-pool detail). Exported. */
export function clearDiscoveryCache() {
  _discoveryPageCache.clear();
  _discoveryDetailCache.clear();
}

/**
 * Test seam — prime the discovery caches so the by-address reuse primitive can be
 * exercised without a live fetch. `page` seeds the broad page cache under an
 * arbitrary key; `detail` seeds the per-pool detail cache. `ageMs` back-dates the
 * entry timestamp to test staleness. Production code never calls this.
 */
export function __primeDiscoveryCachesForTests({ pageKey, pageData, detailKey, detail, ageMs = 0 } = {}) {
  const ts = Date.now() - ageMs;
  if (pageKey != null) _discoveryPageCache.set(pageKey, { data: pageData, ts });
  if (detailKey != null) _discoveryDetailCache.set(detailKey, { detail, ts });
}

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
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * Cassiopeia Option C overlay — apply liveOverrides on top of base screening
 * thresholds when dryRun === false. In paper/dry-run, returns base thresholds
 * unchanged. Reversibility: `liveOverrides: null` → legacy behavior.
 *
 * Recognized overlay keys (subset of base + extras):
 *   minOrganic, maxBotHoldersPct, minFeeActiveTvlRatio, maxTop10Pct
 *   orionMinConfidence  (consumed by agents/orion.js, not screening)
 *   requireDevNotSoldAll, requireSmartWalletOrHighOrganic (consumed below)
 */
export function effectiveScreeningThresholds() {
  const base = config.screening;
  const overlay = (config.dryRun === false && config.liveOverrides) ? config.liveOverrides : {};
  return { ...base, ...overlay };
}

/**
 * Returns the overlay block ONLY when live; otherwise null. For consumers that
 * need to distinguish "live-only rule" vs base behavior (e.g., dev_sold_all
 * rejection, smart-wallet-or-high-organic rule).
 */
export function liveOverlay() {
  return (config.dryRun === false && config.liveOverrides) ? config.liveOverrides : null;
}

/**
 * Phase G — append a signal source tag to a raw pool's signal_sources array
 * WITHOUT overwriting existing tags. Idempotent per source. Maintains the
 * cross_source_confirmed flag (>=2 distinct sources). Returns the pool.
 */
export function tagSignalSource(pool, source) {
  if (!pool || !source) return pool;
  if (!Array.isArray(pool.signal_sources)) pool.signal_sources = [];
  if (!pool.signal_sources.includes(source)) pool.signal_sources.push(source);
  pool.cross_source_confirmed = pool.signal_sources.length >= 2;
  return pool;
}

export function scoreCandidate(pool, cfg) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  const sourceCount = Array.isArray(pool.signal_sources) ? pool.signal_sources.length : 1;
  const multiSourceBonus = Math.max(0, sourceCount - 1) * 500;
  const symmetryBonus = feeGenSymmetryBonus(pool, cfg);
  const feeTvlBonus = feeTvlHighBonus(pool, cfg);
  const ageBonus = tokenAgeSweetSpotBonus(pool, cfg);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100
    + multiSourceBonus + symmetryBonus + feeTvlBonus + ageBonus;
}

/**
 * Item (a) Fee-Gen-Token — balanced two-sided flow SCORE BONUS (NEVER a gate).
 *
 * DATA VERDICT: the Pool Discovery API exposes NO per-side fee field (verified by
 * live raw fetch — only aggregate fee/avg_fee/fee_pct/dynamic_fee_pct). So this is a
 * PROXY built on buy/sell volume symmetry: a pool whose buy share buy/(buy+sell) sits
 * in the balanced band [0.4, 0.6] churns price across the active bin in BOTH directions,
 * generating swap fees each crossing — vs a one-sided drift that parks price at an edge
 * and stops paying. pool.buy_vol / pool.sell_vol are aggregated from OKX cluster flow
 * during getTopCandidates enrichment (no extra fetch).
 *
 * SCORING: award full feeGenSymmetryWeight at perfect 0.5 balance, decaying linearly to
 * 0 at the band edges (0.4 / 0.6). Outside the band → 0. This is a soft nudge, not a cliff.
 *
 * FAIL-SAFE (anti-pattern #2): missing/non-finite/zero side volume → 0 bonus (NEUTRAL).
 * We never penalize a pool for missing flow data — a pool we cannot rank on symmetry
 * simply gets no symmetry credit. NEVER a gate: a one-sided pump can still be a fine LP,
 * so gating on symmetry would risk dormancy (rejecting deployable pools).
 *
 * @param {object} pool - condensed pool; reads pool.buy_vol + pool.sell_vol (USD).
 * @param {object} cfg  - config.screening overlay (feeGenSymmetryBonusEnabled, feeGenSymmetryWeight).
 * @returns {number} bonus points (>= 0). 0 when disabled, missing data, or outside band.
 */
export function feeGenSymmetryBonus(pool, cfg) {
  if (!cfg || cfg.feeGenSymmetryBonusEnabled !== true) return 0;
  const weight = numeric(cfg.feeGenSymmetryWeight);
  if (weight == null || weight <= 0) return 0;

  const buy = numeric(pool?.buy_vol);
  const sell = numeric(pool?.sell_vol);
  // Fail-safe neutral: need both sides positive to compute a flow ratio.
  if (buy == null || sell == null) return 0;
  if (buy < 0 || sell < 0) return 0;
  const total = buy + sell;
  if (total <= 0) return 0;

  const buyShare = buy / total;          // 0..1; 0.5 = perfectly balanced
  const LOW = 0.4, HIGH = 0.6, MID = 0.5;
  if (buyShare < LOW || buyShare > HIGH) return 0; // outside balanced band → no credit
  // Triangular falloff: 1.0 at 0.5, 0.0 at band edges.
  const proximity = 1 - Math.abs(buyShare - MID) / (MID - LOW);
  return weight * proximity;
}

/**
 * Intel adoption — fee/TVL HIGH-PREFERENCE SCORE BONUS (NEVER a gate).
 *
 * THESIS (community/yunus): "24h fee/TVL is KING — below ~20% it doesn't cover IL."
 * The literal advice was a HARD floor at 0.20. We REFUSE to hard-gate at 0.20:
 *   - We already saw 0-deploy days at a 0.08 floor (live overlay). A 0.20 floor
 *     would near-certainly starve the funnel → permanent dormancy.
 *   - yunus runs more sources / higher candidate volume; we cannot copy his floor
 *     without his throughput. We adopt the INSIGHT (prefer high fee/TVL) as a
 *     RANKING preference, while the actual reject floor stays modest
 *     (minFeeActiveTvlRatio — base 0.06, live overlay recommends 0.10).
 *
 * SCORING: linear ramp from the floor (feeTvlHighBonusFloor, default 0.10) up to
 * the "king" target (feeTvlHighBonusTarget, default 0.20). 0 bonus at/below floor,
 * full feeTvlHighBonusWeight at/above target, proportional between. Pools ABOVE the
 * king target keep full weight (capped) — no penalty for being extra-productive.
 *
 * FAIL-SAFE (anti-pattern #2): missing/non-finite/negative fee/TVL → 0 bonus
 * (NEUTRAL — the hard floor in getRawPoolScreeningRejectReason already rejects
 * pools with unknown fee/TVL; this bonus never penalizes, never rejects).
 *
 * @param {object} pool - reads pool.fee_active_tvl_ratio (present raw AND condensed).
 * @param {object} cfg  - config.screening overlay.
 * @returns {number} bonus points (>= 0). 0 when disabled / missing / at-or-below floor.
 */
export function feeTvlHighBonus(pool, cfg) {
  if (!cfg || cfg.feeTvlHighBonusEnabled !== true) return 0;
  const weight = numeric(cfg.feeTvlHighBonusWeight);
  if (weight == null || weight <= 0) return 0;
  const floor  = numeric(cfg.feeTvlHighBonusFloor);
  const target = numeric(cfg.feeTvlHighBonusTarget);
  if (floor == null || target == null || target <= floor) return 0;

  const feeTvl = numeric(pool?.fee_active_tvl_ratio);
  // Fail-safe neutral: no usable fee/TVL → no symmetry credit (never penalize).
  if (feeTvl == null || feeTvl < 0) return 0;
  if (feeTvl <= floor) return 0;                 // at/below floor → no preference credit
  if (feeTvl >= target) return weight;           // king tier → full weight (capped)
  // Linear ramp between floor and target.
  return weight * ((feeTvl - floor) / (target - floor));
}

/**
 * Intel adoption — token-age SWEET-SPOT SCORE BONUS (NEVER a gate).
 *
 * THESIS (community): the token-age sweet spot is ~12-48h. The literal advice was
 * to REPLACE our 24-720h band with 12-48h. We REFUSE to slash maxTokenAgeHours to
 * 48: that would reject EVERY mature pool (anything >2 days old) → mass dormancy.
 * Instead we adopt the insight two ways:
 *   1. Lower the hard floor minTokenAgeHours 24 → 12 (catch the sweet-spot START —
 *      genuinely fresher pools that the 24h floor was rejecting).
 *   2. This bonus soft-PREFERS pools inside the [12,48]h band without rejecting the
 *      mature tail. Mature pools simply get no age credit; they still deploy.
 *
 * SCORING: full tokenAgeSweetSpotWeight inside the [low,high] band (default 12-48h),
 * 0 outside. A flat plateau (not triangular) — every hour in the sweet spot is
 * equally good; we do not micro-rank within the window.
 *
 * FAIL-SAFE (anti-pattern #2): missing/non-finite age → 0 bonus (NEUTRAL). Reads
 * pool.token_age_hours (condensed) OR derives from pool.token_x.created_at (raw).
 *
 * @param {object} pool - reads pool.token_age_hours OR pool.token_x.created_at.
 * @param {object} cfg  - config.screening overlay.
 * @returns {number} bonus points (>= 0). 0 when disabled / missing / outside band.
 */
export function tokenAgeSweetSpotBonus(pool, cfg) {
  if (!cfg || cfg.tokenAgeSweetSpotBonusEnabled !== true) return 0;
  const weight = numeric(cfg.tokenAgeSweetSpotWeight);
  if (weight == null || weight <= 0) return 0;
  const low  = numeric(cfg.tokenAgeSweetSpotLowHours);
  const high = numeric(cfg.tokenAgeSweetSpotHighHours);
  if (low == null || high == null || high <= low) return 0;

  let ageHours = numeric(pool?.token_age_hours);
  if (ageHours == null) {
    // Raw-pool path: derive from base token created_at (ms epoch).
    const createdAt = numeric(pool?.token_x?.created_at);
    if (createdAt != null && createdAt > 0) {
      ageHours = (Date.now() - createdAt) / 3_600_000;
    }
  }
  // Fail-safe neutral: no usable age → no credit (never penalize).
  if (ageHours == null || ageHours < 0) return 0;
  if (ageHours < low || ageHours > high) return 0;  // outside sweet spot → no credit
  return weight;                                    // inside band → flat full weight
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * STRICT numeric coercion — distinguishes DATA-MISSING (null/undefined/empty) from
 * a genuine zero. numeric() alone is unsafe for fail-closed gates because
 * Number(null) === 0 and Number("") === 0 would silently FABRICATE a zero from
 * missing data — exactly anti-pattern #2. Use this wherever "field absent" must be
 * told apart from "field genuinely 0" (e.g. organic_unknown vs a real low organic,
 * volatility_unknown vs a real dead-flat 0). Mirrors windowScalar's strictNum in
 * meteora-crossref.js.
 */
function strictNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null; // null / undefined / empty / object → data-missing
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Cassiopeia rug-protection base gates (fail-closed, anti-pattern #2).
 * Returns a reject reason string, or null if the pool clears every active gate.
 * Always-on (fire in BOTH paper and live) — rug protection is universal.
 *
 * Each gate is independently toggle-able via config.screening:
 *   - requireMintRenounced   → mint_authority_not_renounced
 *   - requireFreezeRenounced → freeze_authority_not_renounced
 *   - rejectRugpullFlag      → liquidity_removal_rugpull
 *
 * FAIL-CLOSED: missing authority data (null/undefined) = REJECT. We do NOT
 * default to a safe value. `mint_disabled !== true` rejects both `false`
 * (authority still live = risk) and `null/undefined` (unknown = reject).
 *
 * @param {object} pool - condensed pool; expects pool.audit.{mint_disabled,
 *   freeze_disabled} and pool.is_rugpull (set during OKX enrichment).
 * @param {object} s - effective screening thresholds (config.screening overlay).
 */
export function rugGateRejectReason(pool, s) {
  const audit = pool?.audit || null;

  if (s?.requireMintRenounced) {
    const mintDisabled = audit ? audit.mint_disabled : undefined;
    if (mintDisabled !== true) return "mint_authority_not_renounced";
  }
  if (s?.requireFreezeRenounced) {
    const freezeDisabled = audit ? audit.freeze_disabled : undefined;
    if (freezeDisabled !== true) return "freeze_authority_not_renounced";
  }
  if (s?.rejectRugpullFlag) {
    if (pool?.is_rugpull === true) return "liquidity_removal_rugpull";
  }
  return null;
}

/**
 * Item 4 — dev_sold_all gate, demoted from hard live-reject to compound.
 * Returns true if the pool should be rejected for dev_sold_all.
 *
 * When devSoldAllRequiresHighConcentration === true (default):
 *   reject ONLY if dev_sold_all === true AND top10 concentration > maxTop10Pct.
 *   Keeps rug protection when concentration is also high, but stops the
 *   false-positive that blocked SQUIRE (+8%) on dev_sold_all alone.
 * When false: legacy hard-reject on dev_sold_all alone.
 *
 * @param {object} pool - condensed pool with pool.dev_sold_all + pool.audit.top_holders_pct
 * @param {object} s - effective screening thresholds (carries devSoldAllRequiresHighConcentration, maxTop10Pct)
 */
export function devSoldAllShouldReject(pool, s) {
  if (pool?.dev_sold_all !== true) return false;
  if (s?.devSoldAllRequiresHighConcentration === false) return true; // legacy hard-reject
  const maxTop10 = numeric(s?.maxTop10Pct);
  const top10 = numeric(pool?.audit?.top_holders_pct);
  if (maxTop10 == null) return false;        // no concentration cap → compound can't trigger
  if (top10 == null) return false;           // no top10 data → don't reject on dev_sold_all alone
  return top10 > maxTop10;
}

/**
 * Item 2 (yunus screen) — TVL/MC ratio gate. LIVE-ONLY (fires only when the
 * caller passes the live overlay; paper/backtest are unaffected by design).
 *
 * Thesis (@0xyunss + community, 71% win backtest): a SMALLER TVL/MC ratio means
 * liquidity is thin relative to market cap → the active range is tighter → fees
 * concentrate where price actually trades → better fee capture. Pools with a
 * BLOATED TVL/MC (lots of parked liquidity vs cap) spread fees too thin.
 *
 * Reject when tvl/mcap > maxTvlMcapRatio (default 0.2).
 *
 * FAIL-SAFE (anti-pattern #2): if mcap or tvl is missing/non-positive we CANNOT
 * compute the ratio — REJECT with tvl_mcap_ratio_unknown rather than default to
 * a passing value. A pool we cannot risk-rank does not deploy in live.
 *
 * Returns a reject reason string, or null if the gate passes / is disabled.
 *
 * @param {object} pool - condensed pool (expects pool.tvl|active_tvl + pool.mcap)
 * @param {object} s - effective screening thresholds (carries tvlMcapGateEnabled, maxTvlMcapRatio)
 */
export function tvlMcapGateRejectReason(pool, s) {
  if (s?.tvlMcapGateEnabled !== true) return null;
  const maxRatio = numeric(s?.maxTvlMcapRatio);
  if (maxRatio == null || maxRatio <= 0) return null; // no usable cap → gate inert
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const mcap = numeric(pool?.mcap ?? pool?.market_cap);
  // Fail-safe: cannot compute ratio without both positive operands.
  if (mcap == null || mcap <= 0) return "tvl_mcap_ratio_unknown";
  if (tvl == null || tvl < 0) return "tvl_mcap_ratio_unknown";
  const ratio = tvl / mcap;
  if (ratio > maxRatio) return "tvl_mcap_ratio_too_high";
  return null;
}

/**
 * H3 edge filter (Cassiopeia, 2026-06-28) — the safety paid for by re-opening the
 * memecoin DEPLOY lane. NOT a loosening: this ADDS a reject on top of every existing
 * gate. From the 59-real-trade brain analysis, the only losing mechanism in the
 * −$1.74 book was the stop-out tail. The clean 2x2 intersection that flipped it
 * +$9.36 (stop-losses 14→3) was: fee_active_tvl_ratio ∈ [min,max) AND volatility ≥ floor.
 *
 *   - ftvl ≥ edgeFilterFtvlMax (1.0): a transient fee spike on a thin/just-launched
 *     pool — NEGATIVE signal (EV −0.50). Rejected.
 *   - ftvl < edgeFilterFtvlMin (0.2): too little fee generation to cover IL. Rejected.
 *   - volatility < edgeFilterMinVolatility (2.5): slow-bleed band (EV −0.41) — the
 *     position never realizes a win, it drifts into the stop. Rejected.
 *
 * FAIL-CLOSED (anti-pattern #2): a missing/non-finite ftvl OR volatility means we
 * CANNOT confirm the candidate is in the positive-EV cell → reject (never default to
 * "assume in-band"). Uses strictNumeric so Number(null)===0 cannot fabricate a reading.
 *
 * Default OFF (edgeFilterEnabled=false) → byte-for-byte no-op; Bro enables it together
 * with the lane. Returns a reject reason string, or null if it passes / disabled.
 *
 * @param {object} pool - reads pool.fee_active_tvl_ratio + pool.volatility
 * @param {object} s - effective screening thresholds
 */
export function edgeFilterRejectReason(pool, s) {
  if (s?.edgeFilterEnabled !== true) return null; // opt-in → inert by default
  const ftvl = strictNumeric(pool?.fee_active_tvl_ratio);
  const vol = strictNumeric(pool?.volatility);
  // Fail-closed: cannot place the pool in the positive cell without both readings.
  if (ftvl == null || !Number.isFinite(ftvl)) return "edge_filter_data_unknown";
  if (vol == null || !Number.isFinite(vol)) return "edge_filter_data_unknown";
  const ftvlMin = numeric(s?.edgeFilterFtvlMin);
  const ftvlMax = numeric(s?.edgeFilterFtvlMax);
  const volFloor = numeric(s?.edgeFilterMinVolatility);
  // Fail-closed: a mis-configured (missing) bound → reject rather than pass everything.
  if (ftvlMin == null || ftvlMax == null || volFloor == null) return "edge_filter_data_unknown";
  if (ftvl < ftvlMin) return "edge_filter_ftvl_below_band";
  if (ftvl >= ftvlMax) return "edge_filter_ftvl_above_band";
  if (vol < volFloor) return "edge_filter_volatility_below_floor";
  return null;
}

/**
 * Deployability pre-filter (Cassiopeia, Lyra cost-cut) — NOT a risk gate.
 *
 * This bot deploys single-side SOL ONLY (executor.js rejects amount_x>0). A pool
 * quoted in anything other than wSOL (e.g. USDC) is UNDEPLOYABLE — it would be
 * judged by the LLM, then REFUSED at deploy. Pure SCREENER-cost + clutter waste
 * (Lyra: ~17% of surfaced candidates, e.g. GACHA-USDC 33x, AVICI-USDC 28x).
 *
 * We reject such pools BEFORE the LLM judge to save cost. Lives in screening
 * (not executor) purely so the spend is never incurred; deployability, not risk.
 *
 * FAIL-SAFE (anti-pattern #2): if the quote mint is missing we CANNOT confirm
 * the pool is SOL-quoted → reject (non_sol_quote_undeployable). Never default to
 * "assume SOL" — an unknown quote is undeployable by definition.
 *
 * Returns a reject reason string, or null if the pool passes / filter disabled.
 *
 * @param {object} pool - condensed pool (expects pool.quote.mint)
 * @param {object} s - effective screening thresholds (carries requireSolQuote)
 */
export function solQuoteRejectReason(pool, s) {
  if (s?.requireSolQuote !== true) return null; // filter disabled → no-op
  const quoteMint = pool?.quote?.mint;
  // Fail-safe: missing quote mint → cannot confirm deployability → reject.
  if (quoteMint == null || quoteMint === "") return "non_sol_quote_undeployable";
  if (quoteMint !== WSOL_MINT) return "non_sol_quote_undeployable";
  return null;
}

// ─── Market-regime detection (Cassiopeia — STOP BLEED T3) ──────────────────────
//
// ROOT CAUSE of T3 bleed (-$4.67): memecoin narrow-range pools deployed into a
// FALLING market keep getting stopped out — price drifts down out of the active
// bin, we cut at the stop, repeat. A DLMM single-side-SOL narrow position has an
// ASYMMETRIC payoff in a downtrend (limited upside if it bounces, full bleed if it
// keeps falling), so the rational move is: pause MEMECOIN deploys while the broad
// market is trending down. (A blue-chip/symmetric-payoff pool is fine in a
// downtrend — fees keep paying both ways — so this gate is built to EXEMPT
// blue-chip profiles when that mode exists. For now every deploy is a memecoin.)
//
// DETECTION: simplest reliable broad-market signal = SOL 24h price change. SOL is
// the beta of the whole Solana memecoin complex; when SOL bleeds, memecoins bleed
// harder. We REUSE the boss-report price source (Jupiter v3 + CoinGecko fallback)
// — CoinGecko's simple/price already returns 24h change with one extra query flag
// (include_24hr_change=true), so we get trend with NO history store, NO new infra.
const MARKET_REGIME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — regime is market-wide, not per-pool; one fetch per cycle
let _marketRegimeCache = null; // { regime, sol24hChangePct, reasoning, source, ts }

/**
 * Classify a SOL 24h % change into a market regime. PURE + unit-tested.
 *
 * FAIL-SAFE (anti-pattern #2): a null / non-finite change (fetch failed, source
 * down) returns NEUTRAL with a `data_missing` reason — we do NOT freeze the bot
 * blind, but we also do NOT pretend the market is fine. NEUTRAL = deploy normally
 * (we never had regime data before this gate, so missing-data behavior == legacy).
 *
 * @param {number|null} sol24hChangePct - SOL 24h price change in PERCENT (e.g. -7.2)
 * @param {object} s - thresholds; reads regimeDowntrendThresholdPct (e.g. -5),
 *   optional regimeUptrendThresholdPct (e.g. +5) for the UPTREND label.
 * @returns {{regime:string, reasoning:string}} regime ∈ UPTREND|NEUTRAL|DOWNTREND
 */
export function classifyRegime(sol24hChangePct, s) {
  // strictNumeric (not numeric): Number(null)===0 would FABRICATE a 0% change from
  // missing data (anti-pattern #2) and mislabel a dead feed as NEUTRAL-band. We must
  // tell "no data" (→ fail-safe NEUTRAL with a data_missing reason) apart from a
  // genuine 0% move (→ NEUTRAL because the market really is flat).
  const pct = strictNumeric(sol24hChangePct);
  if (pct == null) {
    return { regime: "NEUTRAL", reasoning: "regime data missing — fail-safe NEUTRAL (deploy as legacy)" };
  }
  // Downtrend threshold is a NEGATIVE percent (default -5). A more-negative move
  // (pct <= threshold) = downtrend. Be defensive: accept it written as -5 or 5.
  const downRaw = numeric(s?.regimeDowntrendThresholdPct);
  const downThresh = downRaw == null ? -5 : -Math.abs(downRaw);
  const upRaw = numeric(s?.regimeUptrendThresholdPct);
  const upThresh = upRaw == null ? 5 : Math.abs(upRaw);
  if (pct <= downThresh) {
    return { regime: "DOWNTREND", reasoning: `SOL 24h ${pct.toFixed(2)}% <= ${downThresh}% downtrend threshold` };
  }
  if (pct >= upThresh) {
    return { regime: "UPTREND", reasoning: `SOL 24h ${pct.toFixed(2)}% >= +${upThresh}% uptrend threshold` };
  }
  return { regime: "NEUTRAL", reasoning: `SOL 24h ${pct.toFixed(2)}% within [${downThresh}%, +${upThresh}%] neutral band` };
}

/**
 * Fetch SOL 24h % change from the multi-source chain reused from boss-report.
 * CoinGecko simple/price with include_24hr_change=true carries the trend directly.
 * Jupiter v3 has no 24h-change field, so CoinGecko is the trend source; we keep a
 * spot-price source as a liveness probe only. Returns null on total failure.
 *
 * @returns {Promise<{changePct:number|null, source:string|null}>}
 */
async function fetchSol24hChangePct() {
  const SOL = WSOL_MINT;
  // CoinGecko gives 24h change for free with one flag — primary trend source.
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const d = await res.json();
      const chg = Number(d?.solana?.usd_24h_change);
      if (Number.isFinite(chg)) return { changePct: chg, source: "coingecko" };
    }
  } catch { /* fall through */ }
  // Birdeye-free fallback: Jupiter v3 carries priceChange24h on some payloads.
  for (const url of [
    `https://lite-api.jup.ag/price/v3?ids=${SOL}`,
    `https://api.jup.ag/price/v3?ids=${SOL}`,
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const d = await res.json();
      const entry = d?.[SOL];
      // v3 exposes priceChange24h as a percent on some responses; absent on others.
      const chg = Number(entry?.priceChange24h);
      if (Number.isFinite(chg)) return { changePct: chg, source: "jupiter-v3" };
    } catch { /* try next */ }
  }
  return { changePct: null, source: null };
}

/**
 * Detect the current market regime (UPTREND / NEUTRAL / DOWNTREND). Cached for
 * MARKET_REGIME_CACHE_TTL_MS so a screening cycle fetches at most once (regime is
 * market-wide, not per-pool — never fetch per candidate). Returns the classified
 * regime plus the raw 24h change, source, and human reasoning for logs/Telegram.
 *
 * FAIL-SAFE (anti-pattern #2): on total fetch failure we return NEUTRAL (deploy as
 * legacy) and log a warning — we do NOT freeze the bot blind, and we do NOT pretend
 * the market is fine. The gate only PAUSES on a CONFIRMED downtrend.
 *
 * @param {object} [opts]
 * @param {object} [opts.s] - effective screening thresholds (classification knobs)
 * @param {boolean} [opts.force] - bypass cache (tests / manual probe)
 * @returns {Promise<{regime:string, sol24hChangePct:number|null, reasoning:string, source:string|null}>}
 */
export async function detectMarketRegime({ s = null, force = false } = {}) {
  const thresholds = s || (typeof config !== "undefined" ? config.screening : {});
  const now = Date.now();
  if (!force && _marketRegimeCache && (now - _marketRegimeCache.ts) < MARKET_REGIME_CACHE_TTL_MS) {
    return _marketRegimeCache;
  }
  const { changePct, source } = await fetchSol24hChangePct();
  const { regime, reasoning } = classifyRegime(changePct, thresholds);
  const result = { regime, sol24hChangePct: changePct, reasoning, source, ts: now };
  if (changePct == null) {
    log("screening", `Market regime: data unavailable (all price sources failed) — fail-safe NEUTRAL, deploy as legacy`);
  } else {
    log("screening", `Market regime: ${regime} (SOL 24h ${changePct.toFixed(2)}% via ${source}) — ${reasoning}`);
  }
  _marketRegimeCache = result;
  return result;
}

/** Test/seam helper: clear the regime cache so detectMarketRegime refetches. */
export function _resetMarketRegimeCache() { _marketRegimeCache = null; }

/**
 * Is this pool a MEMECOIN / narrow-range / high-vol profile (the bleed-prone kind
 * the downtrend pause targets)? Built to EXEMPT blue-chip profiles for the future
 * Phase 1 bluechip mode — a blue-chip base token has a SYMMETRIC payoff and is
 * fine in a downtrend (fees pay both ways), so it must NOT be paused.
 *
 * For NOW (no bluechip mode), every deployable pool is single-side-SOL memecoin /
 * narrow → returns true unless the BASE mint is a recognized blue-chip. The
 * structure is here so wiring a bluechip allow-list later is a one-line change.
 *
 * @param {object} pool - condensed pool (reads pool.base.mint)
 * @returns {boolean} true = memecoin/narrow (pausable); false = blue-chip (exempt)
 */
export function isMemecoinNarrowProfile(pool) {
  const baseMint = pool?.base?.mint || null;
  // Blue-chip BASE token (wSOL/USDC and major bridged assets) → symmetric payoff,
  // exempt from the downtrend pause. (Quote is already always wSOL for this bot.)
  if (baseMint && BLUECHIP_BASE_MINTS.has(baseMint)) return false;
  // Everything else is a memecoin / narrow-range profile → pausable in downtrend.
  return true;
}

/**
 * Market-regime gate (Cassiopeia — STOP BLEED T3). PURE decision fn.
 *
 * PAUSE deploy when (regime === DOWNTREND) AND (pool is a memecoin/narrow profile).
 * This is a STRICTER condition — it never loosens any other gate; it only ADDS a
 * downtrend pause for the bleed-prone pool class. Blue-chip profiles are EXEMPT
 * (symmetric payoff is fine in a downtrend) — ready for the Phase 1 bluechip mode.
 *
 * ANTI-DORMANCY: this fires ONLY on a CONFIRMED downtrend (SOL <= threshold). In
 * NEUTRAL / UPTREND it returns null → deploy normally. The 10-min cache TTL +
 * threshold (-5% default) mean we are not stuck "downtrend forever" — the moment
 * SOL recovers above the threshold the gate releases on the next cycle.
 *
 * FAIL-SAFE (anti-pattern #2): detectMarketRegime already maps missing data →
 * NEUTRAL (never DOWNTREND), so a fetch failure NEVER pauses deploys here. The
 * gate only ever pauses on a regime we positively measured as DOWNTREND.
 *
 * @param {object} pool - condensed pool (reads pool.base.mint for profile)
 * @param {{regime:string}} regimeResult - output of detectMarketRegime()
 * @param {object} s - effective screening thresholds (reads marketRegimeGateEnabled)
 * @returns {string|null} reject reason or null (deploy allowed / gate off / exempt)
 */
export function marketRegimeGateRejectReason(pool, regimeResult, s) {
  if (s?.marketRegimeGateEnabled !== true) return null;   // gate off → no-op
  if (!regimeResult || regimeResult.regime !== "DOWNTREND") return null; // only pause on confirmed downtrend
  // Bluechip dual-mode exempt (Cassiopeia — Wave 2). isMemecoinNarrowProfile only
  // recognizes wSOL/USDC/USDT BASE mints as bluechip, so a both-leg bluechip with a
  // NON-stable base (JitoSOL-SOL, mSOL-SOL) would slip through as "memecoin" and get
  // paused. When bluechipModeEnabled is ON, a classified bluechip pool has a SYMMETRIC
  // payoff (fees pay both ways in a downtrend) → EXEMPT. Flag OFF → isBluechipPool
  // false → falls through to the legacy isMemecoinNarrowProfile check unchanged.
  if (isBluechipPool(pool, s)) return null;
  if (!isMemecoinNarrowProfile(pool)) return null;        // blue-chip BASE exempt (legacy)
  return "market_regime_downtrend_memecoin_paused";
}

/**
 * Direction gate (Cassiopeia — Track-B B2). PURE + unit-tested + exported.
 *
 * Per-POOL directional guard, the pool-level complement of marketRegimeGate (which
 * pauses on the MARKET-WIDE SOL beta). A single-side-SOL narrow position deployed
 * into a token that is ALREADY falling at entry has an ASYMMETRIC payoff — limited
 * bounce upside, full bleed if it keeps dropping (the same stop-out mechanism that
 * drove the T3 bleed, but observed on the individual pool's price action). This
 * PAUSES the deploy when the pool's own price is measurably down at entry.
 *
 * Reject when:
 *   price_change_pct <= directionMaxNegPriceChangePct   (measured downtrend at entry)
 *   AND ( directionRequireFlowConfirm === false          (price-only mode), OR
 *         buy_share < directionMinBuyShare )             (OKX flow confirms bearish)
 *   where buy_share = buy_vol / (buy_vol + sell_vol).
 *
 * FAIL-OPEN (anti-pattern #2 nuance): this is a DIRECTIONAL / QUALITY gate, NOT a
 * rug/safety gate, so it follows the marketRegimeGate precedent of failing OPEN, not
 * closed — a data gap must never FREEZE deploys (that would be a blind dormancy).
 *   - missing/non-finite price_change_pct → NEUTRAL → deploy as legacy (never pause).
 *   - flow-confirm ON but buy/sell flow absent/zero → cannot CONFIRM bearish → deploy.
 * Uses strictNumeric so Number(null)===0 cannot fabricate a flat 0% reading. The gate
 * only ever pauses on a positively-MEASURED downtrend (with confirming flow when required).
 *
 * NOTE on the call slot: this fires in getTopCandidates in the SAME pre-enrichment
 * slot as marketRegimeGate (before PVP/Jupiter/OKX + judge, so a paused pool costs
 * nothing). price_change_pct is present pre-enrichment (condensed from the discovery
 * API's pool_price_change_pct); buy_vol/sell_vol are OKX-enriched LATER, so at this
 * slot the flow branch fails OPEN — with directionRequireFlowConfirm=true the gate is
 * effectively price-measured-but-flow-lenient. Set directionRequireFlowConfirm=false
 * (user-config) for a pure price-down reject.
 *
 * @param {object} candidate - condensed candidate (price_change_pct, buy_vol, sell_vol)
 * @param {object} s - effective screening thresholds
 * @returns {string|null} reject reason or null (deploy allowed / gate off / fail-open)
 */
export function directionGateRejectReason(candidate, s) {
  if (s?.directionGateEnabled !== true) return null;      // gate off → no-op
  // FAIL-OPEN: no measured price change → cannot assert a downtrend → deploy as legacy.
  const pct = strictNumeric(candidate?.price_change_pct);
  if (pct == null) return null;
  const maxNeg = numeric(s?.directionMaxNegPriceChangePct);
  if (maxNeg == null) return null;                        // misconfigured threshold → no-op (fail-open)
  if (pct > maxNeg) return null;                          // not a downtrend at entry → allow
  // Price is measured down at/below the threshold.
  if (s?.directionRequireFlowConfirm === false) {
    return "direction_downtrend_at_entry";                // price-only mode → pause
  }
  // Flow confirmation required: pause only when flow is PRESENT and bearish.
  const buy = strictNumeric(candidate?.buy_vol);
  const sell = strictNumeric(candidate?.sell_vol);
  if (buy == null || sell == null) return null;           // FAIL-OPEN: flow unknown → cannot confirm → allow
  const total = buy + sell;
  if (total <= 0) return null;                            // no flow → cannot confirm → allow
  const minBuyShare = numeric(s?.directionMinBuyShare);
  if (minBuyShare == null) return null;                   // misconfigured → fail-open
  const buyShare = buy / total;
  if (buyShare < minBuyShare) return "direction_downtrend_at_entry"; // sellers dominant → pause
  return null;                                            // buyers still stepping in → allow
}

/**
 * entry_features handoff builder (Cassiopeia ↔ Vega, DATA-COLLECTION MODE). PURE fn.
 *
 * Packages the ALREADY-FETCHED in-cycle entry conditions (market regime, SOL 24h
 * change, base-token price change, OKX buy/sell flow, mcap) into a stable shape so
 * Vega's deploy path (trackPosition — Vega owns it) can PERSIST them onto the
 * position for later loss-attribution / calibration.
 *
 * STRICTLY telemetry — this is NOT a gate and NEVER rejects. It makes NO API calls;
 * every input is a value already computed this cycle (regime from the gate block,
 * the rest condensed/enriched onto the candidate). Because this is data collection
 * and not a safety decision, a missing/non-finite field is recorded as `null`
 * (honest gap) — the fail-closed-reject rule applies to GATES, not to telemetry we
 * are merely persisting.
 *
 * @param {object} candidate - condensed+enriched candidate (price_change_pct, buy_vol, sell_vol, mcap)
 * @param {object|null} regime - detectMarketRegime() result for this cycle (or null if not run)
 * @param {number} [capturedAt=Date.now()] - capture timestamp (ms)
 * @returns {object} entry_features payload
 */
export function buildEntryFeatures(candidate, regime, capturedAt = Date.now()) {
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const c = candidate || {};
  return {
    regime: regime?.regime ?? null,
    sol_24h_change_pct: numOrNull(regime?.sol24hChangePct),
    regime_source: regime?.source ?? null,
    price_change_pct: numOrNull(c.price_change_pct),
    buy_vol: numOrNull(c.buy_vol),
    sell_vol: numOrNull(c.sell_vol),
    mcap: numOrNull(c.mcap),
    captured_at: capturedAt,
  };
}

/**
 * Cassiopeia — quote-organic gate (pure decision fn, raw-pool shape).
 *
 * THE 7TH FUNNEL WALL (Draco empirical 2026-06-11): `minQuoteOrganic 60` rejected
 * nearly every pool. This bot deploys single-side SOL, so the quote token is
 * ALWAYS wSOL (or USDC pre-SOL-quote-filter) — inherently-liquid blue-chips with
 * no meaningful organic score. `organic_score` measures BASE-token holder
 * authenticity; demanding it of a stablecoin / wrapped-SOL quote is nonsense, not
 * protection. So we EXEMPT blue-chip quote mints (wSOL + USDC) from this gate.
 *
 * This is NOT base-organic loosening — the BASE organic gate
 * (getRawPoolScreeningRejectReason, baseOrganic < minOrganic, live overlay 72) is
 * untouched and still fail-closed (organic_unknown). Only the QUOTE side is fixed.
 *
 * A non-blue-chip quote (some weird token) is STILL gated on quote-organic
 * fail-closed (null/below floor → reject) — defense in depth for the rare exotic
 * quote. But the deployable funnel (wSOL-quoted) now passes this gate cleanly.
 *
 * @param {object} pool - raw pool (token_y.address = quote mint, token_y.organic_score)
 * @param {object} s - effective screening thresholds (minQuoteOrganic)
 * @returns {string|null} reject reason or null (passes / exempt / floor disabled).
 */
// ─── Bluechip dual-mode (Cassiopeia — Wave 2 / Phase 1) ───────────────────────
//
// DESIGN GUARANTEE: bluechip mode is a SEPARATE, PARALLEL path gated behind
// `bluechipModeEnabled` (default FALSE). When off, every function below is inert
// and the memecoin path is byte-for-byte unchanged. Turning the flag on requires
// Bro + Vega (deploy structure) sign-off — see the memory note. This file only
// owns DISCOVERY + GATE (which pools are bluechip-LP-worthy), never the deploy.

/**
 * Read both leg mints from a pool regardless of shape (raw token_x/token_y OR
 * condensed base/quote). Returns { base, quote } mints (may be null).
 */
export function poolLegMints(pool) {
  const base = pool?.token_x?.address ?? pool?.base?.mint ?? pool?.base_mint ?? null;
  const quote = pool?.token_y?.address ?? pool?.quote?.mint ?? null;
  return { base, quote };
}

/**
 * Classify a pool as "bluechip" vs "memecoin" by mint set. PURE + unit-tested.
 *
 * A pool is BLUECHIP only when BOTH legs are in BLUECHIP_INCOME_MINTS. The both-leg
 * rule is deliberate and conservative: SOL-USDC / JLP-USDC / JitoSOL-SOL are stable
 * symmetric LPs; a bluechip-QUOTED memecoin (e.g. PEPE-USDC) is NOT bluechip — it
 * inherits the memecoin's directional/rug risk and belongs in the memecoin gate.
 *
 * FAIL-SAFE (anti-pattern #2): if either leg mint is missing we CANNOT confirm both
 * legs are bluechip → classify as "memecoin" (the stricter path). We never default
 * an unknown pool into the laxer-rug bluechip lane.
 *
 * @param {object} pool - raw or condensed pool
 * @returns {"bluechip"|"memecoin"} classification
 */
export function classifyPoolMode(pool) {
  const { base, quote } = poolLegMints(pool);
  if (!base || !quote) return "memecoin"; // unknown legs → stricter path (fail-safe)
  if (BLUECHIP_INCOME_MINTS.has(base) && BLUECHIP_INCOME_MINTS.has(quote)) return "bluechip";
  return "memecoin";
}

/**
 * Is bluechip mode active for THIS pool? True only when the flag is on AND the pool
 * classifies as bluechip. Centralizes the branch so callers never re-derive it.
 *
 * @param {object} pool - raw or condensed pool
 * @param {object} s - effective screening thresholds (reads bluechipModeEnabled)
 * @returns {boolean}
 */
export function isBluechipPool(pool, s) {
  if (s?.bluechipModeEnabled !== true) return false;
  return classifyPoolMode(pool) === "bluechip";
}

/**
 * Bluechip income-engine GATE (Cassiopeia — Wave 2 / Phase 1). PURE + fail-closed.
 *
 * A DIFFERENT gate from the memecoin path because the risk profile is inverted:
 *   - Bluechip assets are audited/rug-immune → the rug/mint/freeze/bot/top10/
 *     dev_sold_all gates are IRRELEVANT (a stablecoin has no "dev", LST mint
 *     authorities are protocol-controlled by design). We do NOT run them here.
 *   - The memecoin mcap band (50k-2M signal / 150k-10M native) WRONGLY rejects
 *     bluechips: SOL mcap is ~$40B, JLP ~$770M. Bluechip uses its OWN band
 *     (bluechipMinMcap default $50M — these ARE large caps; that's the point).
 *   - The volatility FLOOR (minVolatility 3.0, built for memecoins) MUST NOT apply:
 *     bluechips are LOW-vol BY DESIGN (SOL-USDC vola ~0.1) and low vol is GOOD here
 *     (stable = less IL). Applying a 3.0 floor would reject 100% of bluechips —
 *     the exact inversion trap. Instead bluechip has a vol CEILING (too-wild =
 *     not actually stable) and NO floor.
 *   - The market-regime downtrend pause already EXEMPTS bluechips (symmetric payoff
 *     pays both ways in a downtrend) via isMemecoinNarrowProfile — verified: a
 *     bluechip base mint returns false there, so the pause never fires on them.
 *
 * What bluechip DOES gate (the income-engine risk surface):
 *   - DEEP liquidity floor — bluechipMinTvl (default $200k). Thin "bluechip" pools
 *     have no real depth; the whole point is deploying into deep stable pools.
 *   - CONSISTENT volume floor — bluechipMinVolume (default $50k/24h). A deep pool
 *     with no flow pays no fees (e.g. the live bonk-SOL bs25 $634k TVL / $2k vol /
 *     near-0 fee/TVL — deep but DEAD). Volume is what generates the income.
 *   - FEE-YIELD floor — bluechipMinFeeTvlRatio (default 0.03, ~11% APR on full TVL
 *     at 24h). The income engine must clear a yield bar or it's not worth the IL.
 *     LOWER than the memecoin fee/TVL floor (0.13) because bluechip IL is far
 *     smaller — a 11-15% steady stable yield is the target, not memecoin churn.
 *   - VOLATILITY CEILING — bluechipMaxVolatility (default 1.5). A "bluechip" pool
 *     reading wild vol isn't behaving stably (de-peg / thin book); cap it out.
 *   - Mcap floor — bluechipMinMcap (default $50M). Confirms genuinely large-cap.
 *
 * FAIL-CLOSED (anti-pattern #2): every numeric input is strictNumeric-checked;
 * missing TVL/volume/fee-yield/mcap → reject with a *_unknown reason, NEVER default
 * to a passing value. A bluechip pool we cannot risk-rank does not deploy.
 *
 * Returns a reject reason string, or null if the pool clears every bluechip gate.
 * Caller is responsible for only invoking this on isBluechipPool() === true pools.
 *
 * @param {object} pool - raw or condensed pool
 * @param {object} s - effective screening thresholds (bluechip* keys)
 * @returns {string|null}
 */
export function bluechipPoolGateRejectReason(pool, s) {
  const tvl = strictNumeric(pool?.tvl ?? pool?.active_tvl);
  const volume = strictNumeric(pool?.volume ?? pool?.volume_window);
  const feeTvl = strictNumeric(pool?.fee_active_tvl_ratio);
  const mcap = strictNumeric(pool?.token_x?.market_cap ?? pool?.mcap ?? pool?.market_cap);
  const volatility = strictNumeric(pool?.volatility);

  const minTvl = numeric(s?.bluechipMinTvl);
  const minVol = numeric(s?.bluechipMinVolume);
  const minFeeTvl = numeric(s?.bluechipMinFeeTvlRatio);
  const minMcap = numeric(s?.bluechipMinMcap);
  const maxVola = numeric(s?.bluechipMaxVolatility);

  // DEEP-liquidity floor.
  if (minTvl != null && minTvl > 0) {
    if (tvl == null) return "bluechip_tvl_unknown";
    if (tvl < minTvl) return `bluechip tvl ${tvl} below bluechipMinTvl ${minTvl}`;
  }
  // CONSISTENT-volume floor (deep-but-dead protection).
  if (minVol != null && minVol > 0) {
    if (volume == null) return "bluechip_volume_unknown";
    if (volume < minVol) return `bluechip volume ${volume} below bluechipMinVolume ${minVol}`;
  }
  // FEE-YIELD floor (the income bar).
  if (minFeeTvl != null && minFeeTvl > 0) {
    if (feeTvl == null) return "bluechip_fee_tvl_unknown";
    if (feeTvl < minFeeTvl) return `bluechip fee/TVL ${feeTvl} below bluechipMinFeeTvlRatio ${minFeeTvl}`;
  }
  // Large-cap confirmation.
  if (minMcap != null && minMcap > 0) {
    if (mcap == null) return "bluechip_mcap_unknown";
    if (mcap < minMcap) return `bluechip mcap ${mcap} below bluechipMinMcap ${minMcap}`;
  }
  // VOLATILITY CEILING (NOT a floor — inverse of the memecoin gate). A wild reading
  // means it isn't behaving as a stable bluechip (de-peg / thin book). We do NOT
  // reject low/zero vol here — low vol is the EXPECTED, GOOD state for a bluechip.
  if (maxVola != null && maxVola > 0) {
    // Missing vol is tolerated for bluechip (a stable pool legitimately reads ~0
    // vol; unlike the memecoin floor we do not need a positive vol to deploy).
    if (volatility != null && volatility > maxVola) {
      return `bluechip volatility ${volatility} above bluechipMaxVolatility ${maxVola}`;
    }
  }
  return null;
}

/**
 * Does a bluechip pool have a wSOL leg? PURE + unit-tested. (Cassiopeia ↔ Vega coord.)
 *
 * Vega's deploy path (Opsi B) is SINGLE-SIDE SOL — the executor refuses amount_x>0,
 * so the bot can only seed a position with SOL. That means a bluechip pool is
 * DEPLOYABLE under Opsi B only if one of its legs is wSOL (SOL-USDC, SOL-USDT,
 * JitoSOL-SOL, ...). A bluechip pool with NO wSOL leg (e.g. JLP-USDC, USDC-USDT)
 * is still DISCOVERABLE/rankable for income intel, but cannot be single-side-SOL
 * deployed — it would need Vega's Opsi A (two-sided) which does not exist yet.
 *
 * We mark (not silently drop) such pools so the funnel stays honest: discovery
 * surfaces them, but getTopCandidates filters them from the deployable set while
 * `requireBluechipWsolLeg` is on (default true, the Opsi-B-only guarantee). Flip it
 * off once Vega ships two-sided deploy and JLP-USDC-style pools become deployable.
 *
 * Reads both shapes via poolLegMints (raw token_x/token_y OR condensed base/quote).
 *
 * @param {object} pool
 * @returns {boolean} true iff either leg mint === wSOL
 */
export function bluechipHasWsolLeg(pool) {
  const { base, quote } = poolLegMints(pool);
  return base === WSOL_MINT || quote === WSOL_MINT;
}

/**
 * STRICT bluechip single-side-SOL deployability guard (Cassiopeia ↔ Vega, Opsi 1 LST-SOL
 * pivot). PURE + unit-tested. Returns `null` if deployable, else the reject reason string.
 *
 * Vega diagnosis: Opsi B seeds a position with SOL ONLY (executor refuses amount_x>0).
 * On-chain, SOL can only be the deposited side if wSOL is the pool's tokenY (QUOTE) leg.
 * This holds for memecoin pools (quote=SOL) and for genuine LST-SOL pools (mint sort →
 * LST=tokenX, wSOL=tokenY: verified JitoSOL-SOL / mSOL-SOL / JupSOL-SOL on-chain). It is
 * FALSE for SOL-USDC (SOL=tokenX/base, USDC=quote) → deposit fails with on-chain 0x1.
 *
 * The previous guard `bluechipHasWsolLeg` ("either leg is wSOL") was TOO LOOSE: SOL-USDC
 * and SOL-mSOL (wSOL on the base side) both have a wSOL leg, so they slipped through to
 * enrich → judge → deploy and only died at the chain. We now require wSOL === tokenY
 * (the quote leg) — the SAME deployability invariant solQuoteRejectReason enforces for
 * memecoins, applied to the bluechip lane for consistency.
 *
 * FAIL-CLOSED (anti-pattern #2): a missing/null/empty tokenY mint cannot confirm
 * deployability → REJECT. We never default an unverifiable pool into the deploy set.
 *
 * Reads both pool shapes via poolLegMints (raw token_x/token_y OR condensed base/quote);
 * the quote leg = token_y = tokenYMint.
 *
 * @param {object} pool
 * @returns {string|null} null = deployable (wSOL=tokenY); else "bluechip_wsol_not_quote_side"
 */
export function bluechipWsolQuoteRejectReason(pool) {
  const { quote } = poolLegMints(pool); // quote === tokenY === tokenYMint
  // Fail-closed: missing/empty quote (tokenY) mint → cannot confirm wSOL is the deposit
  // side → reject. Never default-pass an unverifiable pool into single-side-SOL deploy.
  if (quote == null || quote === "") return "bluechip_wsol_not_quote_side";
  // Deployable ONLY when wSOL is the QUOTE (tokenY) leg. wSOL-as-base (SOL-USDC) → reject.
  if (quote !== WSOL_MINT) return "bluechip_wsol_not_quote_side";
  return null;
}

export function quoteOrganicGateRejectReason(pool, s) {
  const minQuoteOrganic = numeric(s?.minQuoteOrganic);
  // Floor disabled / unset / non-positive → quote-organic not gated at all.
  if (minQuoteOrganic == null || minQuoteOrganic <= 0) return null;
  const quoteMint = pool?.token_y?.address || null;
  // Blue-chip quote (wSOL/USDC) → inherently liquid/legit, no organic score by
  // nature → EXEMPT. Gating these = rejecting 100% of valid pools (misconfig).
  if (quoteMint && QUOTE_ORGANIC_EXEMPT_MINTS.has(quoteMint)) return null;
  // Non-blue-chip quote → STILL gated fail-closed (anti-pattern #2): missing
  // organic = reject, never default to a safe value.
  const quoteOrganic = numeric(pool?.token_y?.organic_score);
  if (quoteOrganic == null || quoteOrganic < minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${minQuoteOrganic}`;
  }
  return null;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

export function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  // strictNumeric for volatility + organic: a missing field (null/undefined) must
  // stay null (→ *_unknown fail-closed) and NOT coerce to 0 (Number(null)===0),
  // which would masquerade as a genuine dead/zero reading. The two cases get
  // distinct reject reasons so enrich-before-gate can tell "no data yet" apart
  // from "real low value" (anti-pattern #2).
  const volatility = strictNumeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = strictNumeric(base?.organic_score);
  // NOTE: quote-organic is handled by quoteOrganicGateRejectReason() below, which
  // EXEMPTS blue-chip quote mints (wSOL/USDC). The quote side is always a
  // blue-chip for this single-side-SOL bot, so it has no meaningful organic score
  // by nature — gating it rejected 100% of valid pools (the 7th funnel wall). A
  // non-blue-chip quote is still gated fail-closed inside that fn.
  const launchpad = base?.launchpad || pool?.base_token_launchpad || null;
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  // Fail-closed (anti-pattern #2): null/0 holder count = DATA-MISSING, reject as
  // "holders_unknown" so it's distinguishable from a genuine sub-floor count.
  // After enrichHolderCountsBeforeGate has run, a still-null count means enrich
  // failed (API down/no count) — we reject, never default to a safe value.
  if (holders == null || holders === 0) return "holders_unknown";
  if (holders < s.minHolders) return `holders ${holders} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  // Fail-closed (anti-pattern #2): null volatility = DATA-MISSING (e.g. a
  // cross-ref signal pool whose endpoint never carried it). Distinguish it from a
  // genuine vol<=0 (dead/flat) reading so enrich-before-gate can tell the two
  // apart. After enrichNativeDetailBeforeGate has run, a still-null volatility
  // means enrich failed → reject, never default to a usable value.
  if (volatility == null) return "volatility_unknown";
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility} is unusable`;
  }
  // Volatility FLOOR (Cassiopeia 2026-06-16, Lyra 39-trade finding). LOW-vol pools
  // slow-bleed into the stop without realizing a win — bucket [0,2.5) was EV -$0.41,
  // [2.5,3.5) EV -$0.21, vs [3.5,4.5) EV +$0.34. NO ceiling (high-vol stays EV+).
  // Fires only when minVolatility > 0 (base default 0 = off; user-config sets 3.0).
  // The two fail-closed checks above already rejected null/0/non-finite vol, so a
  // pool reaching here has a genuine usable reading; this gate cuts the bleed band.
  if (s.minVolatility > 0 && volatility < s.minVolatility) {
    return `volatility ${volatility} below minVolatility ${s.minVolatility}`;
  }
  // H3 edge filter (Cassiopeia 2026-06-28) — the safety for the re-opened memecoin
  // DEPLOY lane. Keeps only the positive-EV 2x2 cell ftvl∈[0.2,1.0) AND vol≥2.5
  // (brain analysis: flips −$1.74 → +$9.36, stop-losses 14→3). STRICTER, not looser.
  // Inert when edgeFilterEnabled=false. Fail-closed inside the fn (anti-pattern #2).
  const edgeReason = edgeFilterRejectReason(pool, s);
  if (edgeReason) return edgeReason;
  // Fail-closed (anti-pattern #2): null organic = DATA-MISSING (structural gap on
  // the cross-ref endpoint, NOT a genuine low score). organic_unknown is
  // distinguishable from a genuine sub-floor score so enrich-before-gate (which
  // back-fills organic via a native detail fetch) is not confused with a real
  // low-organic reject. After enrich, a still-null organic means the fetch failed.
  if (baseOrganic == null) return "organic_unknown";
  if (baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic} below minOrganic ${s.minOrganic}`;
  }
  // Quote-organic gate — EXEMPTS blue-chip quote mints (wSOL/USDC). This bot
  // deploys single-side SOL so the quote is always a blue-chip; demanding an
  // organic score of a stablecoin/wSOL quote is nonsense and rejected 100% of
  // valid pools (the 7th funnel wall, Draco 2026-06-11). A non-blue-chip quote is
  // still gated fail-closed. BASE organic gate above is untouched.
  {
    const quoteOrganicReject = quoteOrganicGateRejectReason(pool, s);
    if (quoteOrganicReject) return quoteOrganicReject;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad || "unknown"} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category, sort_by = null }) {
  // sort_by is a FREE server-side pre-sort (Sirius verified: fee_active_tvl_ratio:desc,
  // volume:desc, tvl:desc supported). When the broad page_size still clips the
  // universe, the highest-ranked pools by this key are pulled FIRST — so the cream
  // survives even at the page ceiling. Never narrows the result set, only orders it.

  // 429 ROOT-CAUSE CACHE (Cassiopeia, 2026-06-20): serve a within-TTL cached raw
  // page for an IDENTICAL request key before hitting the API. Collapses the
  // same-cycle / multi-service thundering-herd that drives the chronic 429.
  // Returns a DEEP CLONE so downstream pool-object stamps never corrupt the cache.
  const reqParams = { page_size, filters, timeframe, category, sort_by };
  const ttl = _discoveryCacheTtlMs();
  const cacheKey = ttl > 0 ? _discoveryCacheKey(reqParams) : null;
  if (cacheKey) {
    const hit = _discoveryPageCache.get(cacheKey);
    if (hit && Date.now() - hit.ts <= ttl) {
      const ageSec = Math.round((Date.now() - hit.ts) / 1000);
      log("screening", `Discovery cache HIT (age ${ageSec}s, TTL ${Math.round(ttl / 1000)}s) — reusing raw page, no API call`);
      return JSON.parse(JSON.stringify(hit.data));
    }
  }

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}` +
    (sort_by ? `&sort_by=${encodeURIComponent(sort_by)}` : "");

  const res = await fetch(url);

  if (!res.ok) {
    // FAIL-SAFE: never cache an error. A 429/5xx propagates so the caller's
    // existing .catch(() => null) handles it — we do NOT serve a poisoned entry
    // and we do NOT overwrite a still-fresh prior cache hit with a failure.
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  // Cache only a successful fetch (any shape the API returns, incl. genuinely
  // empty). Store the freshly-parsed object; we clone on READ, not on write, so
  // the stored object is never the one downstream mutates.
  if (cacheKey) {
    _discoveryPageCache.set(cacheKey, { data, ts: Date.now() });
  }
  return JSON.parse(JSON.stringify(data));
}

// Per-pool detail cache (Cassiopeia — 429 ROOT-CAUSE FIX, 2026-06-20). The detail
// endpoint is hit per-pool by applyVolatilityTimeframe (a LATENT up-to-1000-fetch
// fan-out whenever timeframe<30m — currently dormant at live timeframe=1h but a
// 429 bomb if the timeframe is lowered), refetchVolatilityForUnusable, the native-
// detail enrich pass, AND the snapshot-verify reuse path. They all converge on the
// SAME endpoint, so a short-TTL cache keyed by (poolAddress+timeframe) collapses
// duplicate hits within and across those passes in one cycle. Detail volatility is
// the most time-sensitive field, so the TTL is short (detail-specific, default 5
// min) — tied to broadDiscoveryDetailCacheTtlMin. FAIL-SAFE identical to the page
// cache: miss/expired → fresh fetch; a failed fetch is never cached; cloned on read.
const _discoveryDetailCache = new Map(); // `${poolAddress}|${timeframe}` -> { detail, ts }

function _discoveryDetailCacheTtlMs() {
  const min = numeric(config.screening?.broadDiscoveryDetailCacheTtlMin);
  if (min == null) return 5 * 60 * 1000; // 5 min — vol is time-sensitive
  return Math.max(0, min) * 60 * 1000;
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const ttl = _discoveryDetailCacheTtlMs();
  const cacheKey = ttl > 0 && poolAddress ? `${poolAddress}|${timeframe}` : null;
  if (cacheKey) {
    const hit = _discoveryDetailCache.get(cacheKey);
    if (hit && Date.now() - hit.ts <= ttl) {
      return hit.detail == null ? null : JSON.parse(JSON.stringify(hit.detail));
    }
  }

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    // FAIL-SAFE: never cache an error — propagate so the targeted vol-rescue /
    // enrich passes treat it as "unavailable" (leave field unusable → gate decides).
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const detail = (data.data || [])[0] ?? null;
  if (cacheKey) {
    _discoveryDetailCache.set(cacheKey, { detail, ts: Date.now() });
  }
  return detail == null ? null : JSON.parse(JSON.stringify(detail));
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  if (sourceTimeframe === volatilityTimeframe) {
    for (const pool of rawPools) {
      if (pool) pool.volatility_timeframe = volatilityTimeframe;
    }
    return rawPools;
  }

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const volatilityResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({ poolAddress, volatility: numeric(pool?.volatility) }))
    )
  );

  const volatilityByPool = new Map();
  for (const result of volatilityResults) {
    if (result.status !== "fulfilled") continue;
    if (result.value.volatility == null) continue;
    volatilityByPool.set(result.value.poolAddress, result.value.volatility);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address || !volatilityByPool.has(pool.pool_address)) continue;
    pool.volatility = volatilityByPool.get(pool.pool_address);
    pool.volatility_timeframe = volatilityTimeframe;
  }

  return rawPools;
}

/**
 * Item 3 — refetch-before-reject for vol≤0 false-positives.
 * Lyra: volatility 0/null on a 5m feed is frequently a STALE window, not a dead
 * pool (this cost us the RICH-SOL win). Before letting the volatility gate
 * reject a pool, re-fetch its volatility at the 30m timeframe. Only the pools
 * that STILL report vol≤0 at 30m get rejected by the downstream gate.
 *
 * Targeted: only re-fetches pools whose current volatility is unusable, so this
 * costs at most one extra detail call per borderline pool (not the whole page).
 * Idempotent + graceful: a failed/empty 30m fetch leaves volatility untouched
 * (still unusable → still rejected). Reversible by removing the call site.
 */
async function refetchVolatilityForUnusable(rawPools, fetchDetail = fetchPoolDiscoveryDetail) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const stale = rawPools.filter(
    (pool) => pool?.pool_address && !isUsableVolatility(pool.volatility)
  );
  if (stale.length === 0) return rawPools;

  const uniquePoolAddresses = [...new Set(stale.map((pool) => pool.pool_address))];
  const results = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchDetail({ poolAddress, timeframe: MIN_VOLATILITY_TIMEFRAME })
        .then((pool) => ({ poolAddress, volatility: numeric(pool?.volatility) }))
    )
  );

  const rescued = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    if (!isUsableVolatility(result.value.volatility)) continue; // 30m ALSO ≤0 → leave unusable
    rescued.set(result.value.poolAddress, result.value.volatility);
  }

  for (const pool of stale) {
    if (!rescued.has(pool.pool_address)) continue;
    pool.volatility = rescued.get(pool.pool_address);
    pool.volatility_timeframe = MIN_VOLATILITY_TIMEFRAME;
    log("screening", `Volatility rescue: ${pool.name || pool.pool_address} vol≤0 on feed → ${pool.volatility} at 30m`);
  }

  return rawPools;
}

// Testable seam — exposes the volatility-rescue pass with an injectable fetcher
// so scripts/test-gate-batch.js can verify refetch-before-reject without hitting
// the live Pool Discovery API. Not used in production code paths.
export function __refetchVolatilityForUnusableForTests(rawPools, fetchDetail) {
  return refetchVolatilityForUnusable(rawPools, fetchDetail);
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
/**
 * Cassiopeia — enrich-before-gate for the holder floor.
 *
 * Signal pools (discord/solscan/pumpfun) frequently arrive with
 * base_token_holders null/0 because the upstream source didn't carry the field
 * — that is DATA-MISSING, not a genuine low holder count. Killing them at the
 * holder floor (getRawPoolScreeningRejectReason) before any other gate runs was
 * the dominant choke point (69 reject "holders 0" / 4 dry deploy days). This
 * pass gives such pools a CHANCE to be judged on a REAL number — it does NOT
 * lower the floor and does NOT bypass the gate.
 *
 * Order (Lyra cost-aware): we only fetch for a pool when it would clear EVERY
 * OTHER gate with the holder floor temporarily set to 0. If a pool would die on
 * mcap / volume / tvl / age / etc (all no-API checks), we never spend a holder
 * fetch on it. Survivors get one cheap assets/search holderCount fetch (cached
 * per mint, 30-min TTL).
 *
 * FAIL-CLOSED (anti-pattern #2): if enrichment fails or returns no usable count,
 * base_token_holders stays null and the real holder gate rejects it as
 * "holders unknown". Enrich = a chance to GET data, never a pass without it.
 *
 * Mutates pools in place (sets base_token_holders + _holders_enriched marker).
 * The injectable fetchCount lets tests run without hitting the live API.
 */
async function enrichHolderCountsBeforeGate(rawPools, s, fetchCount = getTokenHolderCount) {
  const needsEnrich = rawPools.filter((pool) => {
    const holders = numeric(pool?.base_token_holders);
    if (holders != null && holders > 0) return false; // already have a real count
    const mint = pool?.token_x?.address || pool?.base_mint || null;
    if (!mint) return false; // no mint → nothing to fetch → gate rejects as unknown
    // Lyra cost-aware: only spend a fetch on pools that clear every OTHER gate.
    // Probe with a passing-sentinel holder count so the holder gate itself is
    // neutralized for the probe (every gate EXCEPT the holder floor still
    // applies). A pool that dies on mcap/volume/tvl/age (all no-API) is dropped
    // here for free — no fetch wasted on a pool that can't deploy anyway.
    const probe = { ...pool, base_token_holders: Math.max(1, numeric(s.minHolders) || 1) };
    return getRawPoolScreeningRejectReason(probe, s) === null;
  });

  if (needsEnrich.length === 0) return;

  const now = Date.now();
  await Promise.all(
    needsEnrich.map(async (pool) => {
      const mint = pool.token_x?.address || pool.base_mint;
      let count = null;
      const cached = _holderCountCache.get(mint);
      if (cached && now - cached.ts < HOLDER_COUNT_CACHE_TTL_MS) {
        count = cached.count;
      } else {
        try {
          count = await fetchCount({ mint });
        } catch (error) {
          count = null; // fail-closed — null flows through to the gate as unknown
          log("screening", `Holder enrich failed for ${pool.name || mint}: ${error.message}`);
        }
        _holderCountCache.set(mint, { count, ts: now });
      }
      pool._holders_enriched = true;
      if (Number.isFinite(count) && count > 0) {
        pool.base_token_holders = count;
        log("screening", `Holder enrich: ${pool.name || mint} → ${count} holders (gate evaluates real number)`);
      }
      // count null/0 → leave base_token_holders as-is (null) → gate rejects unknown.
    })
  );
}

// Testable seam — exposes the holder enrich pass with an injectable fetcher so
// scripts can verify enrich-before-gate without hitting the live API.
export function __enrichHolderCountsBeforeGateForTests(rawPools, s, fetchCount) {
  return enrichHolderCountsBeforeGate(rawPools, s, fetchCount);
}

/**
 * Cassiopeia — enrich-before-gate for the volatility + organic structural gaps.
 *
 * THE LAST FUNNEL WALL (Draco empirical 2026-06-11): cross-ref signal pools died
 * at `base organic 0 < minOrganic` because `organic_score` and `volatility` are a
 * STRUCTURAL GAP on the cross-ref endpoint (dlmm.datapi.meteora.ag) — Sirius's
 * field-mapping fix (commit 2b4be22) resolved volume/fee_tvl/bin_step/holders, but
 * those two fields simply do not exist on that index. A 0 there = MISSING, not a
 * genuine low organic. The fix is NOT to lower minOrganic — it is to GIVE the pool
 * its real data: the NATIVE Pool-Discovery detail endpoint
 * (pool-discovery-api.datapi.meteora.ag, queried by pool_address) carries
 * volatility + organic_score (+ fee/age/mcap/tvl) as proper scalars. One fetch per
 * surviving pool fills every gap at once — more efficient than per-field fetches.
 *
 * This extends the enrich-before-gate framework ([[holder-enrich-before-gate]],
 * commit 0b7332f). It runs AFTER enrichHolderCountsBeforeGate (so holders is
 * already filled and the cheap-gate probe below is accurate).
 *
 * Order (Lyra cost-aware): we only fetch a native detail for a pool that is
 * MISSING volatility or base organic AND would clear EVERY OTHER gate once those
 * two gaps are filled (probe with passing sentinels for ONLY the two gap fields).
 * A pool that dies on mcap/volume/tvl/holders/bin_step/age (all already-available,
 * no extra API) gets NO native fetch — we never spend a detail call on the 41
 * discord pools if most die on mcap.
 *
 * FAIL-CLOSED (anti-pattern #2): if the native fetch fails OR the field is still
 * null after enrich, we leave it null and the gate rejects volatility_unknown /
 * organic_unknown. Enrich = a CHANCE to get data, never a pass without it. We back
 * only the structurally-missing scalars from the native detail; we never overwrite
 * a value the pool already has, and never default a missing field to a safe number.
 *
 * Mutates pools in place. Injectable fetchDetail lets tests run without the live API.
 */
// SINGLE SOURCE OF TRUTH for the enrich-before-gate probe (Cassiopeia 2026-06-11,
// catch-22 close). enrichNativeDetailBeforeGate back-fills NINE fields from the
// native detail fetch (see the fill block below). The cost-probe that decides
// whether the fetch is WORTH spending must therefore treat ALL nine as
// "will-be-filled" — i.e. sentinel every field the fetch can plug, NOT just the
// structural-gap pair (volatility/organic). The original probe only sentinelled
// vol+organic, so a signal pool genuinely missing created_at (no `created_at` on
// the cross-ref endpoint) was rejected by the AGE gate INSIDE the probe → fetch
// skipped → created_at never back-filled → pool never reached the judge. A
// chicken-and-egg: the probe gated a field the fetch was about to fill.
//
// `buildEnrichProbe` is co-located with the fill block on purpose — if a tenth
// field is ever added to the back-fill, it MUST also be sentinelled here (a probe
// field that the fill writes but the probe gates = a brand-new catch-22). Each
// sentinel is OPTIMISTIC (a value that clears the gate), applied ONLY where the
// real field is genuinely missing — a present real value is used as-is so a pool
// that truly dies on a cheap, already-available field (e.g. real mcap below floor)
// is still dropped for free, no fetch wasted (Lyra cost order preserved).
//
// FAIL-CLOSED is NOT weakened: the sentinel lives ONLY in the probe (the
// worth-fetching decision). After the fetch RUNS, the real gate re-evaluates the
// ACTUAL data — a field the native detail genuinely lacks (or a failed fetch)
// stays null and the gate rejects it (created_at→age reject / volatility_unknown /
// organic_unknown / holders_unknown / fee/tvl-unknown / …). Probe optimistic,
// real-eval fail-closed (anti-pattern #2).
function buildEnrichProbe(pool, s) {
  const tx = pool?.token_x || {};
  // An optimistic created_at = "old enough AND young enough" — squarely inside any
  // [minTokenAgeHours, maxTokenAgeHours] band so the probe never gates on an age
  // the fetch is about to supply. Midpoint of the band when both bounds exist;
  // otherwise just clear whichever single bound is set.
  const ageProbeCreatedAt = (() => {
    const minH = numeric(s?.minTokenAgeHours);
    const maxH = numeric(s?.maxTokenAgeHours);
    const now = Date.now();
    if (minH != null && maxH != null) return now - ((minH + maxH) / 2) * 3_600_000;
    if (minH != null) return now - (minH + 1) * 3_600_000; // just past the min-age floor
    if (maxH != null) return now - 1 * 3_600_000;          // recent, but a real ts
    return now - 100 * 3_600_000;                          // no band → any plausible ts
  })();

  // CRITICAL: use strictNumeric (NOT numeric) for the missing-test. numeric(null)
  // === 0 (Number(null) coerces to 0), so `numeric(x) == null` is ALWAYS false and
  // would skip the sentinel for a genuinely-absent field — the exact coercion bug
  // that hid the created_at catch-22. strictNumeric returns null for null/undefined
  // and tells a real 0 apart from "absent". A real 0 is NOT sentinelled on purpose:
  // the real gate rejects it (e.g. tvl 0 < minTvl), so the probe rejects it too →
  // no fetch wasted on a genuinely-doomed pool (Lyra cost order preserved).
  const probe = {
    ...pool,
    // Structural-gap pair (the primary target of the fetch).
    volatility: strictNumeric(pool?.volatility) == null ? 1 : pool.volatility,
    // Opportunistic back-fill fields — all gated by getRawPoolScreeningRejectReason,
    // so all must be sentinelled here when genuinely missing.
    tvl: strictNumeric(pool?.tvl ?? pool?.active_tvl) == null
      ? Math.max(numeric(s?.minTvl) || 0, 1)
      : pool.tvl,
    volume: strictNumeric(pool?.volume) == null
      ? Math.max(numeric(s?.minVolume) || 0, 1)
      : pool.volume,
    fee_active_tvl_ratio: strictNumeric(pool?.fee_active_tvl_ratio) == null
      ? Math.max(numeric(s?.minFeeActiveTvlRatio) || 0, 0.0001)
      : pool.fee_active_tvl_ratio,
    base_token_holders:
      strictNumeric(pool?.base_token_holders) == null || strictNumeric(pool?.base_token_holders) === 0
        ? Math.max(numeric(s?.minHolders) || 0, 1)
        : pool.base_token_holders,
    dlmm_params: {
      ...(pool?.dlmm_params || {}),
      bin_step: strictNumeric(pool?.dlmm_params?.bin_step) == null
        ? Math.max(numeric(s?.minBinStep) || 0, 1)
        : pool.dlmm_params.bin_step,
    },
    token_x: {
      ...tx,
      organic_score: strictNumeric(tx?.organic_score) == null
        ? Math.max(0, numeric(s?.minOrganic) || 0)
        : tx.organic_score,
      market_cap: strictNumeric(tx?.market_cap) == null
        ? Math.max(numeric(s?.minMcap) || 0, 1)
        : tx.market_cap,
      created_at: strictNumeric(tx?.created_at) == null ? ageProbeCreatedAt : tx.created_at,
    },
  };
  return probe;
}

// Testable seam — lets the test suite assert the probe sentinels every back-fill
// field (catch-22 regression guard) without invoking the live fetch path.
export function __buildEnrichProbeForTests(pool, s) {
  return buildEnrichProbe(pool, s);
}

async function enrichNativeDetailBeforeGate(rawPools, s, fetchDetail = fetchPoolDiscoveryDetail) {
  // A pool needs native enrich only if a STRUCTURAL-GAP field is missing. Native
  // discovery pools (Meteora-origin) already carry both → never re-fetched.
  // strictNumeric: a missing field is null/undefined (NOT a coerced 0). A genuine
  // 0 volatility is NOT a structural gap — it's a real dead reading the gate should
  // reject as unusable, not something a native fetch can "rescue" to a fake number.
  const isMissingGapField = (pool) => {
    const vol = strictNumeric(pool?.volatility);
    const organic = strictNumeric(pool?.token_x?.organic_score);
    return vol == null || organic == null;
  };

  const needsEnrich = rawPools.filter((pool) => {
    if (!pool?.pool_address) return false;     // no address → can't fetch detail → gate rejects unknown
    if (!isMissingGapField(pool)) return false; // already has both → nothing to fetch
    // Lyra cost-aware: only spend a native detail fetch on a pool that would clear
    // every gate ONCE THE FETCH HAS FILLED EVERY FIELD IT CAN. buildEnrichProbe
    // sentinels ALL nine back-fill fields (optimistic, only where genuinely
    // missing). Gates on fields the fetch CANNOT fill — and on real present values
    // (e.g. a real mcap below floor) — still fire here, dropping doomed pools for
    // free, no native fetch wasted. This is the catch-22 close: previously only
    // vol+organic were sentinelled, so a missing created_at (which the fetch fills)
    // was age-rejected in the probe and the fetch was wrongly skipped.
    return getRawPoolScreeningRejectReason(buildEnrichProbe(pool, s), s) === null;
  });

  if (needsEnrich.length === 0) return;

  const now = Date.now();
  await Promise.all(
    needsEnrich.map(async (pool) => {
      const addr = pool.pool_address;
      let detail = null;
      const cached = _nativeDetailCache.get(addr);
      if (cached && now - cached.ts < NATIVE_DETAIL_CACHE_TTL_MS) {
        detail = cached.detail;
      } else {
        try {
          // 30m timeframe matches the conservative window the cross-ref mapper
          // uses (anti-hype) and the volatility-rescue pass — keeps volatility
          // comparable across enrich paths.
          detail = await fetchDetail({ poolAddress: addr, timeframe: MIN_VOLATILITY_TIMEFRAME });
        } catch (error) {
          detail = null; // fail-closed — gaps stay null → gate rejects unknown
          log("screening", `Native-detail enrich failed for ${pool.name || addr}: ${error.message}`);
        }
        _nativeDetailCache.set(addr, { detail, ts: now });
      }
      pool._native_detail_enriched = true;
      if (!detail) return; // fail-closed: no detail → leave gaps null → gate rejects

      const filled = [];
      // ── Structural-gap fields (the whole point of this pass) ──
      // strictNumeric: only treat genuinely-missing (null/undefined) as a gap to
      // fill, and write the detail value HONESTLY (a real 0 vol is written as 0 →
      // the gate then rejects it as genuinely unusable, never rescued to a fake>0).
      if (strictNumeric(pool.volatility) == null) {
        const v = strictNumeric(detail.volatility);
        if (v != null) { pool.volatility = v; pool.volatility_timeframe = MIN_VOLATILITY_TIMEFRAME; filled.push(`vol=${v}`); }
      }
      if (strictNumeric(pool.token_x?.organic_score) == null) {
        const o = strictNumeric(detail.token_x?.organic_score);
        if (o != null) {
          if (!pool.token_x) pool.token_x = {};
          pool.token_x.organic_score = o;
          filled.push(`organic=${Math.round(o)}`);
        }
      }
      // ── Opportunistic back-fill (same fetch, zero extra cost) — only when the
      // pool is STILL missing the field. Never overwrite an existing value. These
      // are not the primary target but plugging them costs nothing and keeps a
      // cross-ref pool from dying on a different gap on the next iteration.
      //
      // strictNumeric for the missing-test (CATCH-22 fix, Cassiopeia 2026-06-11):
      // numeric(null) === 0, so `numeric(pool.X) == null` is ALWAYS false for a
      // genuinely-absent field — created_at/mcap/fee/tvl/volume/bin_step were
      // therefore NEVER back-filled when truly null (e.g. a signal pool with no
      // created_at), and real-eval then age-rejected the pool. strictNumeric tells a
      // genuine 0 (don't overwrite — honest reading) apart from absent (fill it).
      // The WRITTEN value still uses numeric() (honest read of the detail scalar).
      if (strictNumeric(pool.fee_active_tvl_ratio) == null) {
        const f = numeric(detail.fee_active_tvl_ratio);
        if (f != null) { pool.fee_active_tvl_ratio = f; filled.push(`fee/tvl=${f.toFixed(4)}`); }
      }
      if (strictNumeric(pool.token_x?.market_cap) == null && numeric(detail.token_x?.market_cap) != null) {
        if (!pool.token_x) pool.token_x = {};
        pool.token_x.market_cap = numeric(detail.token_x.market_cap);
        filled.push("mcap");
      }
      if (strictNumeric(pool.token_x?.created_at) == null && numeric(detail.token_x?.created_at) != null) {
        if (!pool.token_x) pool.token_x = {};
        pool.token_x.created_at = numeric(detail.token_x.created_at);
        pool.base_token_created_at = pool.token_x.created_at;
        filled.push("created_at");
      }
      if (strictNumeric(pool.base_token_holders) == null || strictNumeric(pool.base_token_holders) === 0) {
        const h = numeric(detail.base_token_holders);
        if (h != null && h > 0) { pool.base_token_holders = h; filled.push(`holders=${h}`); }
      }
      if (strictNumeric(pool.tvl) == null) {
        const t = numeric(detail.tvl ?? detail.active_tvl);
        if (t != null) { pool.tvl = t; filled.push("tvl"); }
      }
      if (strictNumeric(pool.volume) == null) {
        const vol = numeric(detail.volume);
        if (vol != null) { pool.volume = vol; filled.push("volume"); }
      }
      if (strictNumeric(pool.dlmm_params?.bin_step) == null) {
        const b = numeric(detail.dlmm_params?.bin_step);
        if (b != null) { pool.dlmm_params = { ...(pool.dlmm_params || {}), bin_step: b }; filled.push("bin_step"); }
      }
      if (filled.length) {
        log("screening", `Native-detail enrich: ${pool.name || addr} → ${filled.join(", ")} (gate evaluates real data)`);
      }
    })
  );
}

// Testable seam — exposes the native-detail enrich pass with an injectable
// fetcher so scripts can verify enrich-before-gate without hitting the live API.
export function __enrichNativeDetailBeforeGateForTests(rawPools, s, fetchDetail) {
  return enrichNativeDetailBeforeGate(rawPools, s, fetchDetail);
}

/**
 * Build the server-side filter_by string for the Pool-Discovery API.
 *
 * TWO MODES (Cassiopeia, CROWN JEWEL — server→client gate migration):
 *
 *  - LEGACY STRICT (broadDiscoveryEnabled === false): send EVERY strict gate to the
 *    server. The server cuts the 114k-pool universe to ~3 before we see anything.
 *    This is the behavior we are fixing; kept for full reversibility.
 *
 *  - BROAD (default): send ONLY a WIDE cheap pre-filter — pool_type=dlmm (this bot is
 *    DLMM-only), the critical-warning / single-ownership sanity flags (pure rug sanity,
 *    never narrows the QUALITY funnel), a WIDE mcap band (broadMcapFloor..broadMcapCeil)
 *    and a low tvl floor (broadMinTvl). Every strict quality gate (mcap band, holders,
 *    volume, tvl, binStep, fee/TVL, organic, age, launchpad, rug, bot, top10, ...) then
 *    runs CLIENT-SIDE via getRawPoolScreeningRejectReason + the getTopCandidates gates,
 *    IDENTICALLY — only the evaluation LOCATION moved.
 *
 * INVARIANT (this is what makes it NOT a loosening): every condition in the broad
 * filter is also enforced client-side, and the broad BOUNDS are deliberately wider
 * than the strict thresholds (broadMcapFloor <= minMcap, broadMcapCeil >= maxMcap,
 * broadMinTvl <= minTvl). So the server can NEVER drop a pool the strict client gate
 * would have passed — the broad result is a strict SUPERSET of the deployable set.
 *
 * Exported pure fn so the test can assert (a) broad mode is wide, (b) every broad
 * bound is looser-or-equal to the matching strict threshold.
 *
 * @param {object} s - effective screening thresholds.
 * @returns {string} the joined filter_by string.
 */
export function buildDiscoveryFilters(s) {
  // Cheap sanity flags shared by BOTH modes — pure rug/critical-warning gating that
  // the client gate (getRawPoolScreeningRejectReason lines for *_has_critical_warnings
  // / *_high_single_ownership / high_supply_concentration) also enforces. These never
  // narrow the quality funnel; they only drop pools the client gate would reject too.
  const sanity = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
  ];

  if (s.broadDiscoveryEnabled === false) {
    // LEGACY STRICT — every gate server-side (the pre-fix behavior, kept reversible).
    return [
      ...sanity,
      `base_token_market_cap>=${s.minMcap}`,
      `base_token_market_cap<=${s.maxMcap}`,
      `base_token_holders>=${s.minHolders}`,
      `volume>=${s.minVolume}`,
      `tvl>=${s.minTvl}`,
      s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
      `dlmm_bin_step>=${s.minBinStep}`,
      `dlmm_bin_step<=${s.maxBinStep}`,
      `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
      `base_token_organic_score>=${s.minOrganic}`,
      `quote_token_organic_score>=${s.minQuoteOrganic}`,
      s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
      s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
      Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
        ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
        : null,
    ].filter(Boolean).join("&&");
  }

  // BROAD — wide cheap pre-filter only; the strict gate runs client-side. The wide
  // mcap band must STRADDLE both the native (minMcap..maxMcap) and the strict client
  // bounds, so we cannot drop a pool the client would pass. broadMinTvl is a low sanity
  // floor (kills 0-TVL dust without touching the strict client minTvl).
  const mcapFloor = numeric(s.broadMcapFloor);
  let   mcapCeil  = numeric(s.broadMcapCeil);
  const tvlFloor  = numeric(s.broadMinTvl);
  // Bluechip dual-mode (Cassiopeia — Wave 2): the memecoin broad ceiling (50M) would
  // drop SOL-USDC (SOL ~$40B) at the SERVER, before the client gate runs — the exact
  // discovery-miss the bluechip band must avoid. When the flag is ON, RAISE the broad
  // ceiling to bluechipBroadMcapCeil ($1T default) so large-cap bluechips survive the
  // server pre-filter. This stays a SUPERSET: memecoin pools above the memecoin maxMcap
  // are still rejected CLIENT-side, and bluechips are gated by the bluechip band — the
  // server can only let MORE through, never drop a deployable pool. Flag OFF → ceiling
  // unchanged (byte-for-byte memecoin behavior).
  if (s.bluechipModeEnabled === true) {
    const bcCeil = numeric(s.bluechipBroadMcapCeil);
    if (bcCeil != null && (mcapCeil == null || bcCeil > mcapCeil)) mcapCeil = bcCeil;
  }
  return [
    ...sanity,
    mcapFloor != null ? `base_token_market_cap>=${mcapFloor}` : null,
    mcapCeil  != null ? `base_token_market_cap<=${mcapCeil}`  : null,
    tvlFloor  != null ? `tvl>=${tvlFloor}` : null,
  ].filter(Boolean).join("&&");
}

export async function discoverPools({
  page_size = 50,
  // returnLimit caps the gate-passed `pools` array we RETURN (token-bloat guard for
  // the direct discover_pools LLM tool, which would otherwise dump the whole broad
  // gate-passed set into the prompt). getTopCandidates passes returnLimit=null so its
  // deterministic pre-rank sees the FULL gate-passed universe before slicing to
  // `limit` itself. Default = page_size: a direct tool call gets at most page_size
  // gate-passed pools (legacy-feeling cap), the screening path stays uncapped.
  returnLimit = undefined,
} = {}) {
  const s = effectiveScreeningThresholds();
  const filters = buildDiscoveryFilters(s);
  // Broad mode pulls up to broadDiscoveryPageSize (API ceiling 1000) with a free
  // server pre-sort so the highest fee/TVL pools survive even if the page clips.
  // Legacy strict mode keeps the caller's page_size (default 50). The strict client
  // gate runs on whatever set comes back — identical regardless of breadth.
  const broad = s.broadDiscoveryEnabled !== false;
  const effectivePageSize = broad
    ? (numeric(s.broadDiscoveryPageSize) ?? page_size)
    : page_size;
  const sortBy = broad ? (s.broadSortBy || null) : null;

  const data = await fetchPoolDiscoveryPage({
    page_size: effectivePageSize,
    filters,
    timeframe: s.timeframe,
    category: s.category,
    sort_by: sortBy,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  // CROWN JEWEL breadth telemetry — surface how many candidates the broad server
  // pre-filter returned (vs the legacy ~3). The strict client gate runs next; this
  // is the raw breadth BEFORE client gating. Draco watches this to confirm the fix.
  log(
    "screening",
    `Discovery fetch: ${broad ? "BROAD" : "legacy-strict"} mode, page_size=${effectivePageSize}` +
      `${sortBy ? `, sort=${sortBy}` : ""} → ${rawPools.length} raw pool(s)` +
      (data.total != null ? ` (server total=${data.total})` : ""),
  );

  // Phase G — stamp Meteora as the base source for every discovery pool.
  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    tagSignalSource(pool, "meteora");
    recordSignalSighting(pool.pool_address, "meteora");
  }

  if (config.screening.useDiscordSignals) {
    // Fix #3 — Discord phantom source. The legacy HiveMind path
    // (api.agentmeridian.xyz/signals/discord/candidates) returns 404 → [] →
    // the flag was a no-op. `discordSource` switches between the REAL local
    // MeteoraIDN ranked-digest source (default) and the dead HiveMind path.
    const discordSource = config.screening.discordSource ?? "meteoraidn_ranked";
    let signalPools = [];

    if (discordSource === "meteoraidn_ranked") {
      // REAL source: parse MeteoraIDN #dlmm-multiday-opps / #dlmm-exotic-opps
      // ranked digests (Lincoln Score / FDV / TVL / bin step / base fee). Metlex
      // firehose is deliberately excluded inside the module. Never throws.
      signalPools = (await fetchDiscordMeteoraIdnRanked()) || [];
    } else {
      // Legacy HiveMind path (currently 404 → phantom). Kept behind the flag for
      // when/if the endpoint returns. Graceful: failure → [].
      const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
        log("screening", `Discord signal fetch failed: ${error.message}`);
        return [];
      });
      signalPools = signalCandidates
        .map((candidate) => {
          const discoveryPool = candidate.discovery_pool;
          if (!discoveryPool?.pool_address) return null;
          return {
            ...discoveryPool,
            discord_signal: true,
            discord_signal_count: candidate.source_count || 1,
            discord_signal_seen_count: candidate.seen_count || 1,
            discord_signal_first_seen_at: candidate.first_seen_at || null,
            discord_signal_last_seen_at: candidate.last_seen_at || null,
          };
        })
        .filter(Boolean);
    }

    // Source-agnostic copier: lift only the discord_* surface fields a signal
    // pool carries onto a merged Meteora pool. Tolerates both HiveMind shape
    // (discord_signal_count/seen_count/...) and MeteoraIDN ranked shape
    // (discord_source/discord_lincoln_score/...). Undefined fields are skipped.
    const liftDiscordFields = (signalPool) => {
      const lifted = { discord_signal: true };
      for (const [k, v] of Object.entries(signalPool)) {
        if (k.startsWith("discord_") && v !== undefined) lifted[k] = v;
      }
      return lifted;
    };

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Phase G — discord-only mode: discord is the sole origin source.
      for (const pool of rawPools) {
        if (!pool?.pool_address) continue;
        tagSignalSource(pool, "discord");
        recordSignalSighting(pool.pool_address, "discord");
      }
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const signalPool of signalPools) {
        if (!signalPool?.pool_address) continue;
        if (byPool.has(signalPool.pool_address)) {
          const merged = {
            ...byPool.get(signalPool.pool_address),
            ...liftDiscordFields(signalPool),
          };
          // Phase G — APPEND discord to existing (e.g. meteora) provenance.
          tagSignalSource(merged, "discord");
          byPool.set(signalPool.pool_address, merged);
        } else {
          tagSignalSource(signalPool, "discord");
          byPool.set(signalPool.pool_address, signalPool);
        }
        recordSignalSighting(signalPool.pool_address, "discord");
      }
      rawPools = Array.from(byPool.values());
    }
  }

  // Phase D — Solscan/Birdeye trending source. Parallel to Meteora trending.
  // Graceful: fetchSolscanTrending never throws (returns [] on API failure).
  if (config.screening.useSolscanTrending) {
    const solscanPools = (await fetchSolscanTrending()) || [];
    if (config.screening.solscanTrendingMode === "only") {
      rawPools = solscanPools;
      // Phase G — solscan-only mode: solscan is the sole origin source.
      for (const pool of rawPools) {
        if (!pool?.pool_address) continue;
        tagSignalSource(pool, "solscan");
        recordSignalSighting(pool.pool_address, "solscan");
      }
    } else if (solscanPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const solscanPool of solscanPools) {
        if (!solscanPool?.pool_address) continue;
        if (byPool.has(solscanPool.pool_address)) {
          // Existing Meteora pool wins on metrics; APPEND solscan provenance.
          // signal_sources[] (via tagSignalSource) is authoritative; do NOT
          // overwrite the scalar signal_source — Meteora origin is preserved.
          const merged = {
            ...byPool.get(solscanPool.pool_address),
          };
          tagSignalSource(merged, "solscan");
          byPool.set(solscanPool.pool_address, merged);
        } else {
          tagSignalSource(solscanPool, "solscan");
          byPool.set(solscanPool.pool_address, solscanPool);
        }
        recordSignalSighting(solscanPool.pool_address, "solscan");
      }
      rawPools = Array.from(byPool.values());
    }
  }

  // Phase B — Pump.fun graduated-token source. Parallel to Meteora trending.
  // Graceful: fetchPumpfunGraduated never throws (returns [] on API failure).
  if (config.screening.usePumpfunGraduated) {
    const pumpfunPools = (await fetchPumpfunGraduated()) || [];
    if (config.screening.pumpfunGraduatedMode === "only") {
      rawPools = pumpfunPools;
      // Phase G — pumpfun-only mode: pumpfun is the sole origin source.
      for (const pool of rawPools) {
        if (!pool?.pool_address) continue;
        tagSignalSource(pool, "pumpfun");
        recordSignalSighting(pool.pool_address, "pumpfun");
      }
    } else if (pumpfunPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const pumpfunPool of pumpfunPools) {
        if (!pumpfunPool?.pool_address) continue;
        if (byPool.has(pumpfunPool.pool_address)) {
          // Existing pool wins on metrics; APPEND pumpfun provenance + grad stamp.
          const existing = byPool.get(pumpfunPool.pool_address);
          const merged = {
            ...existing,
            pumpfun_graduated_at: existing.pumpfun_graduated_at ?? pumpfunPool.pumpfun_graduated_at,
            pumpfun_graduation_age_hours:
              existing.pumpfun_graduation_age_hours ?? pumpfunPool.pumpfun_graduation_age_hours,
          };
          tagSignalSource(merged, "pumpfun");
          byPool.set(pumpfunPool.pool_address, merged);
        } else {
          tagSignalSource(pumpfunPool, "pumpfun");
          byPool.set(pumpfunPool.pool_address, pumpfunPool);
        }
        recordSignalSighting(pumpfunPool.pool_address, "pumpfun");
      }
      rawPools = Array.from(byPool.values());
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  // Item 3 — rescue stale vol≤0 readings before the volatility gate rejects them.
  rawPools = await refetchVolatilityForUnusable(rawPools);

  // Cassiopeia — enrich-before-gate: signal pools (discord/solscan/pumpfun) often
  // arrive with holders null/0 (source didn't carry it, NOT a real low count).
  // Fetch the real count for pools that clear every OTHER cheap gate, so the
  // holder floor judges a REAL number. Floor stays 500; enrich is NOT a bypass
  // (fail → holders stays null → gate rejects "holders unknown"). Lyra-aware:
  // no fetch is spent on a pool that would die on mcap/volume/tvl/age anyway.
  if (s.enrichHolderCountBeforeGate !== false) {
    await enrichHolderCountsBeforeGate(rawPools, s);
  }

  // Cassiopeia — enrich-before-gate (THE LAST FUNNEL WALL, 2026-06-11): cross-ref
  // signal pools (discord/solscan/pumpfun via dlmm.datapi.meteora.ag) arrive WITHOUT
  // volatility + organic_score — a STRUCTURAL GAP on the cross-ref endpoint (those
  // fields don't exist there; 0 = MISSING, not a real low score). They died at the
  // volatility/organic gates before the LLM judge. We back-fill the real numbers via
  // ONE native Pool-Discovery detail fetch per surviving pool (volatility + organic +
  // fee/age/mcap in one call). NOT a floor drop, NOT a minOrganic loosening. Runs
  // AFTER holder-enrich so the cheap-gate probe is accurate. Lyra-aware: no native
  // fetch on a pool that dies on mcap/volume/tvl/holders/bin_step anyway. Fail-closed:
  // fetch fails / field stays null → gate rejects volatility_unknown / organic_unknown.
  if (s.enrichNativeDetailBeforeGate !== false) {
    await enrichNativeDetailBeforeGate(rawPools, s);
  }

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    // Bluechip dual-mode branch (Cassiopeia — Wave 2). When bluechipModeEnabled is
    // FALSE, isBluechipPool() is ALWAYS false → every pool takes the memecoin gate
    // below, byte-for-byte unchanged. When ON, a both-leg-bluechip pool is routed to
    // its OWN inverted gate (vol-CEILING not floor, no rug/mcap-band/vol-floor) and
    // SKIPS the memecoin gate entirely; a memecoin pool is untouched.
    const isBc = isBluechipPool(pool, s);
    // Bluechip-ONLY mode (Cassiopeia — Item C, paper-soak validation). When
    // bluechipModeEnabled AND bluechipOnlyMode are BOTH on, the funnel deploys ONLY
    // bluechips: a non-bluechip (memecoin) pool is dropped HERE so the paper-soak data
    // is PURE bluechip, never diluted by memecoin deploys (Lyra's "bluechip loses the
    // pre-rank to memecoins → never reaches top-N → never deploys" fix — restrict, not
    // re-weight). bluechipOnlyMode default FALSE → memecoin path byte-for-byte
    // unchanged; and the master bluechipModeEnabled gate must also be on, so this is
    // doubly inert in the live memecoin funnel. Live can later run mixed (set
    // bluechipOnlyMode=false) — this restriction is the clean paper-soak lever only.
    if (s.bluechipModeEnabled === true && s.bluechipOnlyMode === true && !isBc) {
      filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason: "non_bluechip_filtered_bluechip_only_mode" });
      return false;
    }
    const reason = isBc
      ? bluechipPoolGateRejectReason(pool, s)
      : getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  // CROWN JEWEL — how many of the broad set survived the IDENTICAL strict client
  // gate. This is the gate-passed breadth getTopCandidates pre-ranks over (vs the
  // pre-fix ~3). The gate is byte-identical to the old server filter; only the
  // location moved, so a pool surviving here is a pool the old strict filter would
  // also have surfaced — we just now look at the whole universe to find them.
  log(
    "screening",
    `Client gate: ${thresholdedRawPools.length}/${rawPools.length} pool(s) passed the strict Cassiopeia gate`,
  );

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              // Piggyback created_at fallback (no extra API call) — Meteora pool
              // discovery sometimes returns null base_token_created_at; Jupiter
              // assets/search carries it. Used to back-fill token_age_hours so
              // the live 8h safety floor / age gates have data.
              return { pool: p.pool, dev: t?.dev || null, createdAt: numeric(t?.created_at) };
            })
            .catch(() => ({ pool: p.pool, dev: null, createdAt: null }))
        )
      );
      const devMap = {};
      const createdAtMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") {
          devMap[r.value.pool] = r.value.dev;
          if (r.value.createdAt != null) createdAtMap[r.value.pool] = r.value.createdAt;
        }
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        // Back-fill token_age_hours when Meteora gave us nothing
        if (p.token_age_hours == null && createdAtMap[p.pool] != null) {
          p.token_age_hours = Math.floor((Date.now() - createdAtMap[p.pool]) / 3_600_000);
        }
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  // Token-bloat guard: cap the RETURNED gate-passed set for direct tool callers.
  // returnLimit defaults to page_size (a direct discover_pools call gets at most
  // page_size pools — the legacy feel). getTopCandidates passes returnLimit=null →
  // uncapped, so its own pre-rank picks the cream of the FULL gate-passed universe.
  // The pre-sort (broadSortBy, fee/TVL desc) keeps the highest-quality pools at the
  // front, so even a capped return surfaces the best gate-passed pools first.
  const effectiveReturnLimit = returnLimit === null
    ? null
    : (numeric(returnLimit) ?? page_size);
  const returnedPools = (effectiveReturnLimit != null && pools.length > effectiveReturnLimit)
    ? pools.slice(0, effectiveReturnLimit)
    : pools;

  return {
    total: data.total,
    pools: returnedPools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  // page_size is honored only in legacy-strict mode; broad mode (default) uses
  // broadDiscoveryPageSize (1000) internally. discoverPools runs the FULL strict
  // Cassiopeia client gate, so `pools` here is already gate-passed (rug/bot-data-
  // independent cheap gates + mcap/holders/vol/organic/fee-TVL/age). Broad mode means
  // this set is the cream of the WHOLE universe, not the cream of 50. returnLimit:null
  // → discoverPools returns ALL gate-passed pools so our pre-rank below picks the true
  // top-`limit` from the whole universe (the cost slice happens HERE, not in discovery).
  const discovery = await discoverPools({ returnLimit: null });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const eff = effectiveScreeningThresholds();
  const minTvl = Number(eff.minTvl ?? 0);
  const maxTvl = eff.maxTvl == null ? null : Number(eff.maxTvl);
  const minFeeActiveTvlRatio = Number(eff.minFeeActiveTvlRatio ?? 0);

  const eligible = pools
    .filter((p) => {
      // Bluechip dual-mode (Cassiopeia — Wave 2). When the flag is OFF, isBluechip is
      // ALWAYS false → the full memecoin numeric gate stack below runs unchanged.
      // When ON, a bluechip pool SKIPS the memecoin-specific numeric gates (token-age
      // 8h floor, memecoin minTvl/maxTvl, memecoin minFeeActiveTvlRatio, the
      // isUsableVolatility vol-FLOOR) — those are inverted/irrelevant for bluechip.
      // Its OWN gate (bluechipPoolGateRejectReason) runs in the dedicated block below.
      // The non-mode-specific guards (open position / cooldown) STILL apply to both.
      const isBluechip = isBluechipPool(p, eff);
      if (!isBluechip) {
        const tokenAgeHours = Number(p.token_age_hours ?? 0);
        if (Number.isFinite(tokenAgeHours) && tokenAgeHours > 0 && tokenAgeHours < 8) {
          pushFilteredReason(filteredOut, p, `token age ${tokenAgeHours}h below live safety floor 8h`);
          return false;
        }
        const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
        if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
          pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
          return false;
        }
        if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
          pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
          return false;
        }
        const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
        if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
          pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
          return false;
        }
        if (!isUsableVolatility(p.volatility)) {
          pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
          return false;
        }
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    // CROWN JEWEL COST BOUNDARY (anti-pattern #8 — no waste to the LLM/enrichment).
    // Deterministic pre-rank by scoreCandidate (fee/TVL×weight + organic + volume +
    // tvl + bonuses), then HARD slice to `limit`. EVERY expensive per-pool step below
    // (PVP, Jupiter audit, OKX advanced-info/risk/clusters) and the LLM judge see ONLY
    // this top-`limit` set. So broadening the fetch from 50 → 1000 makes `limit` the
    // CREAM of the whole gate-passed universe instead of the cream of 50, while
    // enrichment + judge cost stay FLAT (still `limit` pools, no more). This slice runs
    // BEFORE any API enrichment — that is the entire cost guarantee.
    .sort((a, b) => scoreCandidate(b, eff) - scoreCandidate(a, eff))
    .slice(0, limit);

  log(
    "screening",
    `Pre-rank: ${pools.length} gate-passed pool(s) → top-${eligible.length} by score enter enrichment+judge (cost-flat at limit=${limit})`,
  );

  // Market-regime gate (Cassiopeia — STOP BLEED T3). Runs BEFORE all enrichment
  // (PVP/Jupiter audit/OKX) AND before the LLM judge so a downtrend-paused pool
  // costs nothing. Detect regime ONCE per cycle (cached 10 min; one price fetch,
  // not per-pool). PAUSE memecoin/narrow pools on a CONFIRMED SOL downtrend; blue-
  // chip profiles are EXEMPT (symmetric payoff, fine in a downtrend — Phase 1
  // ready). FAIL-SAFE: missing regime data → NEUTRAL → deploy as legacy (never a
  // blind freeze). ANTI-DORMANCY: only fires on regime===DOWNTREND, releases the
  // moment SOL recovers above the threshold next cycle.
  // Captured once per cycle for BOTH the gate AND the entry_features handoff below
  // (Vega persists these onto the position at deploy). Reuses the in-cycle value —
  // detectMarketRegime is 10-min cached, so no extra fetch even when read twice.
  let cycleRegime = null;
  if (eff.marketRegimeGateEnabled === true && eligible.length > 0) {
    const regimeResult = await detectMarketRegime({ s: eff });
    cycleRegime = regimeResult;
    const beforeRegime = eligible.length;
    const kept = eligible.filter((p) => {
      const reason = marketRegimeGateRejectReason(p, regimeResult, eff);
      if (reason) {
        log("screening", `Market-regime gate: paused ${p.name} — ${reason} (${regimeResult.reasoning})`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < beforeRegime) {
      log("screening", `Market-regime DOWNTREND paused ${beforeRegime - eligible.length} memecoin pool(s) — STOP BLEED (SOL 24h ${regimeResult.sol24hChangePct == null ? "n/a" : regimeResult.sol24hChangePct.toFixed(2) + "%"})`);
    }
  }

  // Direction gate (Cassiopeia — Track-B B2). Per-POOL directional guard, the pool-
  // level complement of the market-regime gate above. Runs in the SAME pre-enrichment
  // slot (before PVP/Jupiter/OKX + judge → a paused pool costs nothing). Pauses a
  // deploy when the pool's OWN price is measurably down at entry (asymmetric single-
  // side-SOL narrow payoff). FAIL-OPEN: missing price change → deploy as legacy (never
  // a freeze). See directionGateRejectReason for the flow-confirm slot nuance.
  if (eff.directionGateEnabled === true && eligible.length > 0) {
    const beforeDir = eligible.length;
    const kept = eligible.filter((p) => {
      const reason = directionGateRejectReason(p, eff);
      if (reason) {
        log("screening", `Direction gate: paused ${p.name} — ${reason} (price_change ${p.price_change_pct == null ? "n/a" : p.price_change_pct + "%"})`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < beforeDir) {
      log("screening", `Direction gate paused ${beforeDir - eligible.length} downtrend-at-entry pool(s)`);
    }
  }

  // Deployability pre-filter (Cassiopeia, Lyra cost-cut) — runs BEFORE all
  // enrichment (PVP/Jupiter audit/OKX) and BEFORE the LLM judge. We deploy
  // single-side SOL only; non-SOL-quoted pools (USDC etc.) are undeployable and
  // pure waste. Cut them here so we never spend enrichment OR judge cost on
  // them. BASE filter (fires both paper and live). Fail-closed on missing quote.
  if (eff.requireSolQuote === true && eligible.length > 0) {
    const beforeSq = eligible.length;
    const kept = eligible.filter((p) => {
      // Bluechip RELAX (Cassiopeia ↔ Vega): the SOL-quote filter rejects any non-wSOL
      // QUOTE (it assumes single-side-SOL needs a wSOL quote). A bluechip pair may be
      // USDC/USDT-QUOTED with a wSOL BASE (e.g. SOL-USDC: base=wSOL, quote=USDC) — that
      // pool IS single-side-SOL deployable (seed the wSOL base side) yet this filter
      // would wrongly drop it. So for bluechip pools we DEFER deployability to the
      // wSOL-LEG check below (either leg = wSOL), which is the true Opsi-B condition.
      // Flag OFF → isBluechipPool false → memecoin pools hit the strict quote filter
      // unchanged.
      if (isBluechipPool(p, eff)) return true;
      const reason = solQuoteRejectReason(p, eff);
      if (reason) {
        log("screening", `Deployability: dropped ${p.name} — ${reason} (quote=${p.quote?.symbol || p.quote?.mint || "unknown"})`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < beforeSq) log("screening", `SOL-quote filter removed ${beforeSq - eligible.length} undeployable pool(s)`);
  }

  // Bluechip income-engine GATE + deployability (Cassiopeia — Wave 2). Runs only when
  // bluechipModeEnabled (default OFF → entirely inert, memecoin path unchanged). Two
  // parts, both fail-closed:
  //   1) bluechipPoolGateRejectReason on the ENRICHED condensed pool (re-validates
  //      deep-TVL / consistent-volume / fee-yield / mcap / vol-CEILING — the inverted
  //      profile). Discovery already gated on the raw shape, but enrichment may have
  //      back-filled fields, so we re-gate on the final numbers (defense in depth).
  //   2) Deployability (Opsi 1 LST-SOL pivot): under Vega's Opsi B (single-side SOL) a
  //      bluechip pool is deployable ONLY if wSOL is its tokenY (QUOTE) leg — the side
  //      SOL can be deposited on-chain. requireBluechipWsolLeg (default true) drops
  //      pools where wSOL is the BASE leg (SOL-USDC, SOL-mSOL → on-chain 0x1) AND pools
  //      with no wSOL leg (JLP-USDC), via bluechipWsolQuoteRejectReason. The deployable
  //      bluechip set is now LST-SOL pools (JitoSOL-SOL / mSOL-SOL / JupSOL-SOL: mint
  //      sort → LST=tokenX, wSOL=tokenY). Flip the flag off once Vega ships two-sided
  //      (Opsi A) deploy that can seed a wSOL-base pool.
  if (eff.bluechipModeEnabled === true && eligible.length > 0) {
    const beforeBc = eligible.length;
    const requireWsolLeg = eff.requireBluechipWsolLeg !== false; // default true (Opsi B)
    const kept = eligible.filter((p) => {
      if (!isBluechipPool(p, eff)) return true; // memecoin pool — untouched here
      const reason = bluechipPoolGateRejectReason(p, eff);
      if (reason) {
        log("screening", `Bluechip gate: dropped ${p.name} — ${reason}`);
        pushFilteredReason(filteredOut, p, reason);
        return false;
      }
      if (requireWsolLeg) {
        const wsolReason = bluechipWsolQuoteRejectReason(p);
        if (wsolReason) {
          log("screening", `Bluechip deployability: dropped ${p.name} — ${wsolReason} (wSOL must be tokenY/quote for single-side-SOL Opsi B; quote=${p.quote?.symbol || p.token_y?.symbol || "?"})`);
          pushFilteredReason(filteredOut, p, wsolReason);
          return false;
        }
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < beforeBc) log("screening", `Bluechip gate/deployability removed ${beforeBc - eligible.length} pool(s)`);
  }

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with Jupiter audit data (top10/bot holders %) and apply concentration gates.
  // Audit shape: t.audit.topHoldersPercentage / botHoldersPercentage from /assets/search.
  // Fail-closed: if a knob is configured and data is missing, reject the pool.
  if (eligible.length > 0) {
    const maxBotPctCfg = numeric(eff.maxBotHoldersPct);
    const maxTop10PctCfg = numeric(eff.maxTop10Pct);
    const botGateActive = maxBotPctCfg != null && maxBotPctCfg > 0;
    const top10GateActive = maxTop10PctCfg != null && maxTop10PctCfg > 0;
    // Item 1 — rug gates need audit.{mint_disabled,freeze_disabled}. Fetch the
    // Jupiter audit whenever a mint/freeze gate is active, even if bot/top10
    // gates are off — otherwise p.audit stays null and fail-closed would reject
    // every pool. Compound dev_sold_all (Item 4) also reads audit.top_holders_pct.
    const mintGateActive = eff.requireMintRenounced === true;
    const freezeGateActive = eff.requireFreezeRenounced === true;
    const auditNeeded = botGateActive || top10GateActive || mintGateActive || freezeGateActive;

    if (auditNeeded) {
      const auditResults = await Promise.allSettled(
        eligible.map(async (p) => {
          if (!p.base?.mint) return { pool: p.pool, audit: null };
          const res = await fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`);
          if (!res.ok) return { pool: p.pool, audit: null };
          const data = await res.json();
          const arr = Array.isArray(data) ? data : [data];
          const hit = arr.find((t) => t?.id === p.base.mint) || arr[0] || null;
          return { pool: p.pool, audit: hit?.audit || null };
        })
      );
      const auditByPool = new Map();
      for (const r of auditResults) {
        if (r.status === "fulfilled") auditByPool.set(r.value.pool, r.value.audit);
        // unfulfilled → no entry → treated as data unavailable below
      }

      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        const audit = auditByPool.get(p.pool) || null;
        const botPct = audit ? numeric(audit.botHoldersPercentage) : null;
        const top10Pct = audit ? numeric(audit.topHoldersPercentage) : null;
        // Surface for downstream consumers (LLM prompt, logs)
        p.audit = audit
          ? {
              top_holders_pct: top10Pct,
              bot_holders_pct: botPct,
              mint_disabled: audit.mintAuthorityDisabled ?? null,
              freeze_disabled: audit.freezeAuthorityDisabled ?? null,
            }
          : null;

        // Bluechip exempt (Cassiopeia — Wave 2): bot/top10 concentration is meaningless
        // for stablecoins/LSTs (a stablecoin's "top holders" are protocols/CEXes by
        // design). Flag OFF → never reached as bluechip. Audit still surfaced above.
        if (isBluechipPool(p, eff)) return true;

        if (botGateActive) {
          if (botPct == null) {
            log("screening", `Risk filter: dropped ${p.name} — bot_holders_data_unavailable`);
            pushFilteredReason(filteredOut, p, "bot_holders_data_unavailable");
            return false;
          }
          if (botPct > maxBotPctCfg) {
            log("screening", `Risk filter: dropped ${p.name} — bot_holders ${botPct}% > ${maxBotPctCfg}%`);
            pushFilteredReason(filteredOut, p, `bot_holders_pct_above_cap (${botPct}% > ${maxBotPctCfg}%)`);
            return false;
          }
        }
        if (top10GateActive) {
          if (top10Pct == null) {
            log("screening", `Risk filter: dropped ${p.name} — top10_data_unavailable`);
            pushFilteredReason(filteredOut, p, "top10_data_unavailable");
            return false;
          }
          if (top10Pct > maxTop10PctCfg) {
            log("screening", `Risk filter: dropped ${p.name} — top10 ${top10Pct}% > ${maxTop10PctCfg}%`);
            pushFilteredReason(filteredOut, p, `top10_pct_above_cap (${top10Pct}% > ${maxTop10PctCfg}%)`);
            return false;
          }
        }
        return true;
      }));
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    const okxUnavailable = new Set();
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") {
        if (config.screening.maxBundlePct != null) {
          okxUnavailable.add(eligible[i].pool);
        }
        continue;
      }
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;

        // Item (a) Fee-Gen-Token — aggregate per-cluster buy/sell USD into a
        // pool-level two-sided flow proxy (no extra fetch; reuses cluster data).
        // Consumed by feeGenSymmetryBonus(). Only set when at least one finite
        // side value exists; otherwise leave undefined so the bonus stays neutral.
        let buyVol = 0, sellVol = 0, sawFlow = false;
        for (const c of clusters) {
          const b = Number(c?.buy_vol_usd);
          const s = Number(c?.sell_vol_usd);
          if (Number.isFinite(b)) { buyVol += b; sawFlow = true; }
          if (Number.isFinite(s)) { sellVol += s; sawFlow = true; }
        }
        if (sawFlow) {
          eligible[i].buy_vol = buyVol;
          eligible[i].sell_vol = sellVol;
        }
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    const maxBundlePctCfg = config.screening.maxBundlePct ?? 20;
    const maxSniperPctCfg = config.screening.maxSniperPct ?? 0.5;
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (okxUnavailable.has(p.pool)) {
        log("screening", `Risk filter: dropped ${p.name} — okx_risk_data_unavailable`);
        pushFilteredReason(filteredOut, p, "okx_risk_data_unavailable");
        return false;
      }
      const bundlePct = Number(p.bundle_pct);
      const sniperPct = Number(p.sniper_pct);
      if (Number.isFinite(bundlePct) && bundlePct > maxBundlePctCfg) {
        log("screening", `Risk filter: dropped ${p.name} — bundle ${bundlePct}% > ${maxBundlePctCfg}%`);
        pushFilteredReason(filteredOut, p, `bundle ${bundlePct}% > ${maxBundlePctCfg}%`);
        return false;
      }
      if (Number.isFinite(sniperPct) && sniperPct > maxSniperPctCfg) {
        log("screening", `Risk filter: dropped ${p.name} — sniper ${sniperPct}% > ${maxSniperPctCfg}%`);
        pushFilteredReason(filteredOut, p, `sniper ${sniperPct}% > ${maxSniperPctCfg}%`);
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);

    // Item 1 — Cassiopeia rug-protection BASE gates (always-on, fail-closed).
    // Fire in BOTH paper and live. mint/freeze authority + OKX rugpull flag.
    // p.audit (mint_disabled/freeze_disabled) is populated by the Jupiter audit
    // block above; p.is_rugpull by the OKX risk block above. Missing data =
    // reject (anti-pattern #2). Each gate toggle-able via config.screening.
    {
      const beforeRug = eligible.length;
      const kept = eligible.filter((p) => {
        // Bluechip exempt (Cassiopeia — Wave 2): a stablecoin has no "dev", LST mint/
        // freeze authorities are protocol-controlled by design → rug/mint/freeze gates
        // are irrelevant. Flag OFF → never reached as bluechip.
        if (isBluechipPool(p, eff)) return true;
        const reason = rugGateRejectReason(p, eff);
        if (reason) {
          log("screening", `Rug gate: dropped ${p.name} — ${reason}`);
          pushFilteredReason(filteredOut, p, reason);
          return false;
        }
        return true;
      });
      eligible.splice(0, eligible.length, ...kept);
      if (eligible.length < beforeRug) log("screening", `Rug gates removed ${beforeRug - eligible.length} pool(s)`);
    }

    // Item 4 — dev_sold_all gate, demoted to compound (BASE gate, fires both
    // paper and live). Default: reject only when dev_sold_all AND top10 >
    // maxTop10Pct. Set devSoldAllRequiresHighConcentration=false to revert to
    // legacy hard-reject on dev_sold_all alone.
    {
      const beforeDsa = eligible.length;
      const kept = eligible.filter((p) => {
        // Bluechip exempt (Cassiopeia — Wave 2): no "dev" to have sold. Flag OFF →
        // never reached as bluechip.
        if (isBluechipPool(p, eff)) return true;
        if (devSoldAllShouldReject(p, eff)) {
          const reason = eff.devSoldAllRequiresHighConcentration === false
            ? "dev_sold_all"
            : "dev_sold_all_high_concentration";
          log("screening", `Risk filter: dropped ${p.name} — ${reason} (top10=${p.audit?.top_holders_pct ?? "n/a"}%)`);
          pushFilteredReason(filteredOut, p, reason);
          return false;
        }
        return true;
      });
      eligible.splice(0, eligible.length, ...kept);
      if (eligible.length < beforeDsa) log("screening", `dev_sold_all gate removed ${beforeDsa - eligible.length} pool(s)`);
    }

    // Item 2 (yunus screen) — TVL/MC ratio gate. LIVE-ONLY (DRY_RUN=false).
    // Paper/backtest unaffected. Reject pools whose TVL/MC > maxTvlMcapRatio
    // (default 0.2) — thin-liquidity-vs-cap pools concentrate fees in a tighter
    // range. Fail-safe: missing/zero mcap or tvl → tvl_mcap_ratio_unknown reject.
    if (config.dryRun === false && eff.tvlMcapGateEnabled === true) {
      const beforeTm = eligible.length;
      const kept = eligible.filter((p) => {
        // Bluechip exempt (Cassiopeia — Wave 2): the TVL/MC<0.2 thesis is a memecoin
        // fee-concentration heuristic. A bluechip's mcap is enormous (SOL ~$40B) so the
        // ratio is meaninglessly tiny; the bluechip gate already enforces deep-TVL +
        // fee-yield floors. Flag OFF → never reached as bluechip.
        if (isBluechipPool(p, eff)) return true;
        const reason = tvlMcapGateRejectReason(p, eff);
        if (reason) {
          const tvl = numeric(p.tvl ?? p.active_tvl);
          const mcap = numeric(p.mcap);
          const ratioStr = (tvl != null && mcap != null && mcap > 0) ? (tvl / mcap).toFixed(3) : "n/a";
          log("screening", `TVL/MC gate: dropped ${p.name} — ${reason} (tvl/mc=${ratioStr}, cap ${eff.maxTvlMcapRatio})`);
          pushFilteredReason(filteredOut, p, reason === "tvl_mcap_ratio_too_high"
            ? `tvl_mcap_ratio_too_high (${ratioStr} > ${eff.maxTvlMcapRatio})`
            : reason);
          return false;
        }
        return true;
      });
      eligible.splice(0, eligible.length, ...kept);
      if (eligible.length < beforeTm) log("screening", `TVL/MC gate removed ${beforeTm - eligible.length} pool(s)`);
    }

    // Item 5 — the live-only requireSmartWalletOrHighOrganic hard gate was
    // REMOVED. It was a disguised organic floor (the 30-wallet smart-money list
    // rarely overlaps trending pools, so sw=0 was near-universal). Organic is now
    // governed solely by minOrganic (live overlay recommends 72), and smart-money
    // remains a scoreCandidate bonus only. requireDevNotSoldAll overlay key is
    // superseded by the Item 4 compound base gate.
  }

  // Phase G — multi-source cross-validation HARD GATE (live-only).
  // Default OFF (requireMultiSourceConfirm=false) → soft score bonus only.
  // When ON + live (DRY_RUN false): reject pools confirmed by < 2 sources.
  if (config.dryRun === false && config.screening.requireMultiSourceConfirm && eligible.length > 0) {
    const beforeMS = eligible.length;
    const kept = eligible.filter((p) => {
      const sourceCount = Array.isArray(p.signal_sources) ? p.signal_sources.length : 1;
      if (sourceCount < 2) {
        log("screening", `Multi-source gate: dropped ${p.name} — single_source_in_live (${(p.signal_sources || []).join(",") || "meteora"})`);
        pushFilteredReason(filteredOut, p, "single_source_unconfirmed_in_live");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...kept);
    if (eligible.length < beforeMS) log("screening", `Multi-source gate removed ${beforeMS - eligible.length} single-source pool(s)`);
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  // Item (a) — re-rank now that OKX flow (buy_vol/sell_vol) is enriched, so the
  // Fee-Gen-Token symmetry bonus (if enabled) can influence final ordering. The
  // earlier sort ran pre-enrichment when flow data wasn't yet attached. Pure
  // re-order — adds/removes nothing, fail-safe neutral when all flags are off.
  // Intel adoption — the fee/TVL high-preference and token-age sweet-spot bonuses
  // also influence final ordering; their inputs (fee_active_tvl_ratio,
  // token_age_hours) survive condensation, so a final re-rank keeps them honored
  // after any enrichment-driven reorder. Pure re-order, never adds/removes a pool.
  const reRankEnabled = eff.feeGenSymmetryBonusEnabled === true
    || eff.feeTvlHighBonusEnabled === true
    || eff.tokenAgeSweetSpotBonusEnabled === true;
  if (eligible.length > 1 && reRankEnabled) {
    eligible.sort((a, b) => scoreCandidate(b, eff) - scoreCandidate(a, eff));
  }

  // ── entry_features handoff (Cassiopeia ↔ Vega, DATA-COLLECTION MODE) ──────────
  // Thread the ALREADY-FETCHED in-cycle regime / price-change / flow / mcap onto
  // each surviving candidate so Vega's deploy path (trackPosition, which Vega owns)
  // can PERSIST the entry conditions for later loss-attribution / calibration.
  // STRICTLY telemetry — NOT a gate, never rejects. NO new API calls: every field
  // is a value already computed this cycle (regime from the gate block above, the
  // rest condensed/enriched onto the candidate). Missing → null (honest gap; this
  // is data collection, not a safety decision, so a null is recorded, never faked).
  const capturedAt = Date.now();
  for (const c of eligible) {
    c.entry_features = buildEntryFeatures(c, cycleRegime, capturedAt);
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    // Raw universe size from the discovery API (pre-gate). Funnel baseline for
    // the terse Telegram notif ("N pool → M lolos filter"). data.total is the
    // full pool count the API reports before any client-side gating.
    total_universe: Number.isFinite(Number(discovery.total)) ? Number(discovery.total) : pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Phase G — multi-source cross-validation provenance
    signal_sources: Array.isArray(p.signal_sources) ? p.signal_sources.slice() : ["meteora"],
    cross_source_confirmed: Boolean(p.cross_source_confirmed),

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
