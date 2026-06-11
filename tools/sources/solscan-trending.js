import { log } from "../../logger.js";
import { findDlmmPoolForMint, numeric, crossrefPoolFields } from "./meteora-crossref.js";

/**
 * Phase D — Trending-token source (LOCAL). Jupiter-primary, Birdeye-optional.
 *
 * Parallel pool-discovery source to broaden candidate coverage beyond Meteora
 * trending. Fetches trending tokens from a public/free endpoint, then cross-refs
 * each against Meteora's DLMM pool index. Only tokens that HAVE a deployable
 * DLMM pool are returned — a trending-token list alone can't be deployed into.
 *
 * SOURCE (Sirius 2026-06-11): the original Birdeye trending endpoint requires a
 * PAID key (`X-API-KEY`) — keyless returns HTTP 401, so on the VPS (no key) the
 * source was DEAD (`BIRDEYE_API_KEY not set, skipping` → always []). Jupiter's
 * lite-api token-trending endpoint is KEYLESS and returns the same thing we need
 * (a list of trending Solana mints + metadata: symbol/mcap/fdv/liquidity/holders).
 * Jupiter is already the sanctioned token-data vendor in this repo (token.js uses
 * datapi.jup.ag). So Jupiter is now the keyless PRIMARY; Birdeye remains an
 * OPTIONAL override used only if BIRDEYE_API_KEY is set (e.g. for richer coverage
 * later). This revives the source with NO paid key and NO quality reduction —
 * every cross-refed pool still flows through every Cassiopeia gate + Orion judge
 * (anti-pattern #8 safe: trending membership is coverage, never a deploy trigger).
 *
 * Output shape MUST match Meteora's RAW pool shape (the object consumed by
 * getRawPoolScreeningRejectReason + condensePool in screening.js), namely:
 *   - top-level: pool_address, name, pool_type, tvl, volume, fee_active_tvl_ratio,
 *     volatility, base_token_holders, dlmm_params:{bin_step}
 *   - nested token_x/token_y: { symbol, address, organic_score, market_cap,
 *     created_at }
 * We additionally surface the spec-required flat aliases (pool_name, base_mint,
 * base_token_created_at, token_age_hours) for convenience; they are non-breaking.
 *
 * GRACEFUL DEGRADATION: any fetch failure / rate-limit → return [] + warn log.
 * Never throws (must not break the screening cycle).
 */

// Birdeye trending endpoint. Requires a PAID API key sent as the `X-API-KEY`
// header (keyless → HTTP 401). Key is read from process.env.BIRDEYE_API_KEY only
// (never hardcoded). Birdeye is now OPTIONAL — used only if the key is present.
const BIRDEYE_TRENDING = "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20";

// Jupiter lite-api token-trending endpoint. KEYLESS (free public tier), returns a
// bare array of trending tokens. Each record carries `id` (mint address) + symbol
// + mcap/fdv/liquidity/holderCount/dev/launchpad. This is the keyless PRIMARY
// trending feed so the source works on the VPS with no Birdeye key. Overridable
// via env for tests / alternate windows.
const JUPITER_TRENDING =
  process.env.JUPITER_TRENDING_URL ||
  "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=30";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-memory cache
let _cache = { at: 0, pools: null };

/**
 * Fetch trending tokens from Birdeye public tier.
 * @returns {Promise<Array>} raw trending token entries, or [] on any failure.
 */
async function fetchBirdeyeTrending() {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    // No key → Birdeye is optional; Jupiter is the keyless primary. Quiet skip
    // (debug-level intent): not an error, just "Birdeye override not configured".
    return [];
  }
  let res;
  try {
    res = await fetch(BIRDEYE_TRENDING, {
      headers: {
        accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": apiKey,
      },
    });
  } catch (err) {
    log("screening", `solscan-trending: Birdeye fetch error: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    log("screening", `solscan-trending: Birdeye HTTP ${res.status} ${res.statusText || ""}`.trim());
    return [];
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    log("screening", `solscan-trending: Birdeye JSON parse error: ${err.message}`);
    return [];
  }
  // Birdeye shape: { data: { tokens: [...] } }
  const tokens = data?.data?.tokens || data?.data?.items || data?.tokens;
  return Array.isArray(tokens) ? tokens : [];
}

/**
 * Fetch trending tokens from Jupiter lite-api (KEYLESS primary). Returns a list
 * of trending token entries normalized to a common shape the cross-ref + pool
 * normalizer understand:  { address, symbol, marketcap, fdv, liquidity, holder }.
 * Graceful [] on any failure (never throws). Jupiter returns a bare array of
 * records keyed by `id` (the mint).
 * @returns {Promise<Array>} trending token entries, or [] on any failure.
 */
async function fetchJupiterTrending() {
  let res;
  try {
    res = await fetch(JUPITER_TRENDING, { headers: { accept: "application/json" } });
  } catch (err) {
    log("screening", `solscan-trending: Jupiter fetch error: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    log("screening", `solscan-trending: Jupiter HTTP ${res.status} ${res.statusText || ""}`.trim());
    return [];
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    log("screening", `solscan-trending: Jupiter JSON parse error: ${err.message}`);
    return [];
  }
  // Jupiter v2 tokens shape: bare array of { id, symbol, mcap, fdv, liquidity, holderCount, ... }.
  // Some windows wrap as { tokens: [...] } — tolerate both.
  const rows = Array.isArray(data) ? data : Array.isArray(data?.tokens) ? data.tokens : [];
  // Map to the same flat field names normalizePool already reads from a Birdeye token
  // (address / marketcap / fdv / liquidity / volume24hUSD / holder) so the downstream
  // normalizer is source-agnostic. Jupiter is metadata-only here — every gate-read
  // field is resolved from the Meteora cross-ref, never from this list.
  return rows
    .map((t) => {
      const address = t?.id || t?.address || t?.mint;
      if (!address || typeof address !== "string") return null;
      return {
        address,
        symbol: t?.symbol,
        marketcap: t?.mcap,
        fdv: t?.fdv,
        liquidity: t?.liquidity,
        volume24hUSD: t?.stats24h?.buyVolume != null && t?.stats24h?.sellVolume != null
          ? Number(t.stats24h.buyVolume) + Number(t.stats24h.sellVolume)
          : undefined,
        holder: t?.holderCount,
      };
    })
    .filter(Boolean);
}

/**
 * Resolve the trending-token list: Birdeye when a key is configured (optional
 * override), otherwise Jupiter keyless (the primary). Both degrade to [].
 */
async function fetchTrendingTokens() {
  if (process.env.BIRDEYE_API_KEY) {
    const birdeye = await fetchBirdeyeTrending();
    if (birdeye.length > 0) return birdeye;
    // Key set but Birdeye empty/failed → fall back to keyless Jupiter, don't go dark.
  }
  return fetchJupiterTrending();
}

/**
 * Normalize a Meteora DLMM pool (sourced via cross-ref) into the screening raw
 * shape, tagging it as solscan-originated. We prefer real Meteora fields when
 * present and fall back to Birdeye token metrics for coverage.
 */
function normalizePool(meteoraPool, birdeyeToken, mint) {
  const tokenX = meteoraPool.token_x || {};
  const tokenY = meteoraPool.token_y || {};
  // Ensure base side aligns with the trending mint.
  const baseIsX = tokenX.address === mint;
  const base = baseIsX ? tokenX : tokenY;
  const quote = baseIsX ? tokenY : tokenX;

  // Resolve ALL gate-read fields through the shared cross-ref shape mapper
  // (window-objects → shortest finite window, pool_config.bin_step, token.holders,
  // fee_tvl_ratio→fee_active_tvl_ratio slot). Birdeye scalars fill gaps only when
  // the Meteora value is unresolvable. Fail-closed → null. See meteora-crossref.js.
  const f = crossrefPoolFields(meteoraPool, base);
  const tvl = f.tvl ?? numeric(birdeyeToken?.liquidity);
  const volume = f.volume ?? numeric(birdeyeToken?.volume24hUSD ?? birdeyeToken?.volume24h);
  const feeActiveTvlRatio = f.feeActiveTvlRatio;
  const volatility = f.volatility;
  const binStep = f.binStep;
  const holders = f.holders ?? numeric(birdeyeToken?.holder);
  const createdAt = numeric(base?.created_at);
  const tokenAgeHours = createdAt != null ? Math.floor((Date.now() - createdAt) / 3_600_000) : null;

  return {
    // ── Meteora-raw top-level (consumed by reject-reason + condensePool) ──
    pool_address: meteoraPool.pool_address || meteoraPool.address,
    name: meteoraPool.name || `${base?.symbol || "?"}-${quote?.symbol || "?"}`,
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
      symbol: base?.symbol,
      address: base?.address || mint,
      organic_score: numeric(base?.organic_score),
      market_cap: numeric(base?.market_cap ?? birdeyeToken?.marketcap ?? birdeyeToken?.fdv),
      created_at: createdAt,
      dev: base?.dev || null,
      launchpad: base?.launchpad || null,
    },
    token_y: {
      symbol: quote?.symbol,
      address: quote?.address,
      organic_score: numeric(quote?.organic_score),
    },

    // ── Spec-required flat aliases (non-breaking convenience) ──
    pool_name: meteoraPool.name || `${base?.symbol || "?"}-${quote?.symbol || "?"}`,
    base_mint: base?.address || mint,
    pool_address_alias: meteoraPool.pool_address || meteoraPool.address,
    base_token_created_at: createdAt,
    token_age_hours: tokenAgeHours,

    // ── Source tag ──
    signal_source: "solscan",
  };
}

/**
 * Fetch trending tokens (Birdeye), cross-ref each against Meteora DLMM pools,
 * and return normalized raw pools. 5-min cached. Never throws.
 * @returns {Promise<Array>} normalized pools tagged signal_source:"solscan".
 */
export async function fetchSolscanTrending() {
  const now = Date.now();
  if (_cache.pools && now - _cache.at < CACHE_TTL_MS) {
    return _cache.pools;
  }

  try {
    // Birdeye when a key is configured (optional override), else Jupiter keyless
    // (the primary). This is the line that revives the source on the VPS with no
    // paid Birdeye key — see fetchTrendingTokens().
    const tokens = await fetchTrendingTokens();
    if (tokens.length === 0) {
      _cache = { at: now, pools: [] };
      return [];
    }

    const settled = await Promise.allSettled(
      tokens.map(async (token) => {
        const mint = token?.address || token?.mint;
        if (!mint || typeof mint !== "string") return null;
        const meteoraPool = await findDlmmPoolForMint(mint, "solscan-trending");
        if (!meteoraPool) return null; // no DLMM pool → can't deploy → skip
        const normalized = normalizePool(meteoraPool, token, mint);
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

    log("screening", `solscan-trending: ${pools.length} DLMM-backed pool(s) from ${tokens.length} trending token(s)`);
    _cache = { at: now, pools };
    return pools;
  } catch (err) {
    // Defensive: any unexpected error degrades to empty, never breaks screening.
    log("screening", `solscan-trending: unexpected failure, returning []: ${err.message}`);
    return [];
  }
}

// Exposed for tests — allows cache reset between assertions.
export function __resetSolscanCache() {
  _cache = { at: 0, pools: null };
}
