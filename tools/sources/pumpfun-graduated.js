import { log } from "../../logger.js";
import { config } from "../../config.js";
import { findDlmmPoolForMint, numeric, crossrefPoolFields } from "./meteora-crossref.js";

/**
 * Phase B — Pump.fun graduated-token source (LOCAL).
 *
 * Tokens freshly graduated from the pump.fun bonding curve to a DEX often spawn
 * brand-new DLMM pools = early alpha. This source pulls recently-completed
 * (graduated) pump.fun coins, filters to a recency window, then cross-refs each
 * against Meteora's DLMM pool index. Only tokens that HAVE a deployable DLMM
 * pool are returned — a pump.fun coin alone can't be deployed into.
 *
 * Output shape MUST match Meteora's RAW pool shape (the object consumed by
 * getRawPoolScreeningRejectReason + condensePool in screening.js) — identical to
 * the Solscan source's output (see solscan-trending.js).
 *
 * GRADUATION AGE NOTE: the pump.fun public API exposes NO dedicated graduation
 * timestamp. It does expose `complete` (graduated flag) + `created_timestamp`.
 * When the feed is sorted by created_timestamp DESC with complete=true, the
 * freshest entries are the freshest graduates (fast-bonding coins graduate
 * within minutes/hours of creation). We therefore use created_timestamp as the
 * best-available graduation-age proxy and gate it by pumpfunMaxGraduationAgeHours.
 *
 * GRACEFUL DEGRADATION: any fetch failure / rate-limit → return [] + warn log.
 * Never throws (must not break the screening cycle).
 */

// Pump.fun public API (v3). No API key available locally — public/free tier.
// The legacy frontend-api.pump.fun host now 530s; v3 is the live successor.
// complete=true → only graduated coins. Sorted by recency for fresh graduates.
const PUMPFUN_GRADUATED =
  "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false&complete=true";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-memory cache (mirror solscan)
let _cache = { at: 0, pools: null };

/**
 * Fetch graduated coins from pump.fun public v3 API.
 * @returns {Promise<Array>} raw coin entries, or [] on any failure.
 */
async function fetchGraduatedCoins() {
  let res;
  try {
    res = await fetch(PUMPFUN_GRADUATED, { headers: { accept: "application/json" } });
  } catch (err) {
    log("screening", `pumpfun-graduated: fetch error: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    log("screening", `pumpfun-graduated: HTTP ${res.status} ${res.statusText || ""}`.trim());
    return [];
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    log("screening", `pumpfun-graduated: JSON parse error: ${err.message}`);
    return [];
  }
  // v3 shape: bare array, or { coins: [...] } / { data: [...] } defensively.
  const coins = Array.isArray(data) ? data : data?.coins || data?.data;
  return Array.isArray(coins) ? coins : [];
}

/**
 * Best-available graduation timestamp (ms) for a pump.fun coin.
 * No explicit graduation field exists; created_timestamp is the proxy (see file
 * header). Falls back to king_of_the_hill / last_trade if created is missing.
 */
function graduationTimestampMs(coin) {
  return (
    numeric(coin?.created_timestamp) ??
    numeric(coin?.king_of_the_hill_timestamp) ??
    numeric(coin?.last_trade_timestamp) ??
    null
  );
}

/**
 * Normalize a Meteora DLMM pool (sourced via cross-ref) into the screening raw
 * shape, tagging it as pumpfun-originated. Prefers real Meteora fields when
 * present and falls back to pump.fun coin metrics for coverage. Stamps the
 * graduation timestamp onto pumpfun_graduated_at.
 */
function normalizePool(meteoraPool, coin, mint, graduatedAtMs) {
  const tokenX = meteoraPool.token_x || {};
  const tokenY = meteoraPool.token_y || {};
  // Ensure base side aligns with the graduated mint.
  const baseIsX = tokenX.address === mint;
  const base = baseIsX ? tokenX : tokenY;
  const quote = baseIsX ? tokenY : tokenX;

  // Resolve ALL gate-read fields through the shared cross-ref shape mapper
  // (window-objects → shortest finite window, pool_config.bin_step, token.holders,
  // fee_tvl_ratio→fee_active_tvl_ratio slot). Fail-closed → null when unresolvable
  // (anti-pattern #2). See meteora-crossref.js.
  const f = crossrefPoolFields(meteoraPool, base);
  const tvl = f.tvl;
  const volume = f.volume;
  const feeActiveTvlRatio = f.feeActiveTvlRatio;
  const volatility = f.volatility;
  const binStep = f.binStep;
  const holders = f.holders;
  const createdAt = numeric(base?.created_at) ?? graduatedAtMs;
  const tokenAgeHours = createdAt != null ? Math.floor((Date.now() - createdAt) / 3_600_000) : null;
  const gradAgeHours = graduatedAtMs != null ? Math.floor((Date.now() - graduatedAtMs) / 3_600_000) : null;

  return {
    // ── Meteora-raw top-level (consumed by reject-reason + condensePool) ──
    pool_address: meteoraPool.pool_address || meteoraPool.address,
    name: meteoraPool.name || `${base?.symbol || coin?.symbol || "?"}-${quote?.symbol || "?"}`,
    pool_type: meteoraPool.pool_type || "dlmm",
    tvl,
    active_tvl: numeric(meteoraPool.active_tvl),
    volume,
    fee: numeric(meteoraPool.fee),
    fee_pct: numeric(meteoraPool.fee_pct),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility,
    volatility_timeframe: meteoraPool.volatility_timeframe || null,
    base_token_holders: holders,
    dlmm_params: { bin_step: binStep },

    base_token_has_critical_warnings: meteoraPool.base_token_has_critical_warnings ?? false,
    quote_token_has_critical_warnings: meteoraPool.quote_token_has_critical_warnings ?? false,
    base_token_has_high_single_ownership: meteoraPool.base_token_has_high_single_ownership ?? false,
    base_token_has_high_supply_concentration: meteoraPool.base_token_has_high_supply_concentration ?? false,

    token_x: {
      symbol: base?.symbol || coin?.symbol,
      address: base?.address || mint,
      organic_score: numeric(base?.organic_score),
      market_cap: numeric(base?.market_cap ?? coin?.usd_market_cap ?? coin?.market_cap),
      created_at: createdAt,
      dev: base?.dev || coin?.creator || null,
      launchpad: base?.launchpad || "pumpfun",
    },
    token_y: {
      symbol: quote?.symbol,
      address: quote?.address,
      organic_score: numeric(quote?.organic_score),
    },

    // ── Spec-required flat aliases (non-breaking convenience) ──
    pool_name: meteoraPool.name || `${base?.symbol || coin?.symbol || "?"}-${quote?.symbol || "?"}`,
    base_mint: base?.address || mint,
    pool_address_alias: meteoraPool.pool_address || meteoraPool.address,
    base_token_created_at: createdAt,
    token_age_hours: tokenAgeHours,

    // ── Pump.fun graduation provenance ──
    pumpfun_graduated_at: graduatedAtMs,
    pumpfun_graduation_age_hours: gradAgeHours,

    // ── Source tag ──
    signal_source: "pumpfun",
  };
}

/**
 * Fetch graduated pump.fun coins, filter to the recency (graduation-age) window,
 * cross-ref each against Meteora DLMM pools, and return normalized raw pools.
 * 5-min cached. Never throws.
 * @returns {Promise<Array>} normalized pools tagged signal_source:"pumpfun".
 */
export async function fetchPumpfunGraduated() {
  const now = Date.now();
  if (_cache.pools && now - _cache.at < CACHE_TTL_MS) {
    return _cache.pools;
  }

  try {
    const maxAgeHours = numeric(config?.screening?.pumpfunMaxGraduationAgeHours) ?? 48;
    const maxAgeMs = maxAgeHours * 3_600_000;

    const coins = await fetchGraduatedCoins();
    if (coins.length === 0) {
      _cache = { at: now, pools: [] };
      return [];
    }

    // Age-window filter: keep only coins graduated within the configured window.
    const fresh = coins.filter((coin) => {
      const gradAt = graduationTimestampMs(coin);
      if (gradAt == null) return false; // no timestamp → can't verify freshness → skip
      return now - gradAt <= maxAgeMs;
    });

    const settled = await Promise.allSettled(
      fresh.map(async (coin) => {
        const mint = coin?.mint || coin?.address;
        if (!mint || typeof mint !== "string") return null;
        const meteoraPool = await findDlmmPoolForMint(mint, "pumpfun-graduated");
        if (!meteoraPool) return null; // no DLMM pool → can't deploy → skip
        const gradAt = graduationTimestampMs(coin);
        const normalized = normalizePool(meteoraPool, coin, mint, gradAt);
        return normalized.pool_address ? normalized : null;
      })
    );

    const pools = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const addr = r.value.pool_address;
      if (seen.has(addr)) continue;
      seen.add(addr);
      pools.push(r.value);
    }

    log(
      "screening",
      `pumpfun-graduated: ${pools.length} DLMM-backed pool(s) from ${fresh.length} fresh / ${coins.length} graduated coin(s) (≤${maxAgeHours}h)`
    );
    _cache = { at: now, pools };
    return pools;
  } catch (err) {
    // Defensive: any unexpected error degrades to empty, never breaks screening.
    log("screening", `pumpfun-graduated: unexpected failure, returning []: ${err.message}`);
    return [];
  }
}

// Exposed for tests — allows cache reset between assertions.
export function __resetPumpfunCache() {
  _cache = { at: 0, pools: null };
}
