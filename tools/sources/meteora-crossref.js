import { log } from "../../logger.js";

/**
 * Shared Meteora DLMM cross-reference helper (Phase D + Phase B).
 *
 * Both the Solscan/Birdeye trending source and the Pump.fun graduated source
 * pull tokens from an external feed, then must confirm each token actually has a
 * deployable Meteora DLMM pool (a raw symbol/mint alone can't be deployed into).
 * This helper centralizes that lookup so both sources stay consistent.
 *
 * GRACEFUL: any fetch/parse failure → returns null (treated as "no pool, skip").
 * Never throws.
 */

// Meteora DLMM pool index — same host screening.js uses for rival lookup.
export const METEORA_DLMM_BASE = "https://dlmm.datapi.meteora.ag";

export function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a scalar volume from the cross-ref endpoint's volume shape.
 *
 * MAPPING BUG (Sirius, 2026-06-11): the cross-ref DLMM index
 * (dlmm.datapi.meteora.ag) returns `volume` as a per-WINDOW OBJECT
 * `{ "30m": …, "1h": …, "2h": …, "4h": …, "12h": …, "24h": … }`, NOT a scalar.
 * The Pool-Discovery API (pool-discovery-api.datapi.meteora.ag) used by native
 * screening returns `volume` as a scalar for the requested timeframe. All three
 * signal sources (discord-meteoraidn / solscan-trending / pumpfun-graduated)
 * cross-ref via the DLMM index, so they were doing `numeric(meteoraPool.volume)`
 * on an OBJECT → NaN → null → every signal pool died at the minVolume gate
 * ("volume 0/unknown"). This was the dominant signal-source choke point
 * (Draco live data 2026-06-11: 25 MeteoraIDN pools dead on volume).
 *
 * Window choice — anti-pattern #8 (anti-hype): we pick the SHORTEST available
 * window ("30m") so we never overstate flow. The native gate (minVolume=500) is
 * calibrated against the short 5m native window; the cross-ref index has no 5m,
 * so 30m is the closest conservative proxy. A scalar input passes through
 * unchanged (back-compat with the native shape + test mocks).
 *
 * FAIL-CLOSED (anti-pattern #2): unknown shape / empty object / no finite window
 * → null. Null flows to the gate as "volume unknown" → REJECT. We never default
 * to a passing number when the data is missing.
 *
 * @param {number|object|null|undefined} volume the raw `volume` field
 * @param {string[]} [preferredOrder] window keys, shortest→longest preference
 * @returns {number|null} a finite scalar volume, or null if unresolvable
 */
export const WINDOW_ORDER = ["30m", "1h", "2h", "4h", "12h", "24h"];

/**
 * GENERAL window→scalar resolver (Sirius, 2026-06-11 exhaustive cross-ref audit).
 *
 * The cross-ref DLMM index (dlmm.datapi.meteora.ag) returns MULTIPLE fields as
 * per-WINDOW OBJECTS `{ "30m":…, "1h":…, "2h":…, "4h":…, "12h":…, "24h":… }`,
 * NOT scalars — confirmed live across SOL/JUP/BONK/WIF: `volume`, `fees`,
 * `protocol_fees`, `fee_tvl_ratio` are ALL window-objects. The native
 * Pool-Discovery API returns these as scalars for the requested timeframe. Every
 * signal source cross-refs via the DLMM index, so reading `pool.<field>` straight
 * yielded an OBJECT → NaN → null → the field's gate rejected EVERY signal pool.
 * `volumeScalar` fixed `volume` (commit b233425); this generalizes the SAME
 * treatment to every window-object field so we don't peel one gate at a time.
 *
 * Window choice — anti-pattern #8 (anti-hype): we pick the SHORTEST available
 * window (default "30m"). For flow fields (volume/fees) the shortest window never
 * overstates activity. For RATIO fields (fee_tvl_ratio) the shortest window is
 * also the most CONSERVATIVE — longer windows compound the ratio (live SOL-USDC:
 * 30m=0.0048 vs 24h=0.386, an 80× inflation that would falsely clear a 0.06
 * floor). Cross-ref has no 5m window, so 30m is the closest analog to the native
 * 5m-timeframe scalar the gate is calibrated against. A scalar passes through
 * unchanged (back-compat with the native shape + test mocks).
 *
 * FAIL-CLOSED (anti-pattern #2): unknown shape / empty object / no finite window
 * → null. Null flows to the gate as "field unknown" → REJECT. We never default to
 * a passing number when the data is missing.
 *
 * @param {number|object|null|undefined} field a raw cross-ref field value
 * @param {string[]} [preferredOrder] window keys, shortest→longest preference
 * @returns {number|null} a finite scalar, or null if unresolvable
 */
export function windowScalar(field, preferredOrder = WINDOW_ORDER) {
  // Strict scalar coercion: numeric() alone is unsafe here because
  // Number(null)===0 and Number("")===0 would silently FABRICATE a zero from
  // missing data. Treat ONLY real numbers / non-empty numeric strings as
  // scalars; anything else (null/undefined/empty/object) → null.
  const strictNum = (v) => {
    if (typeof v === "number") return numeric(v);
    if (typeof v === "string" && v.trim() !== "") return numeric(v);
    return null;
  };
  // Scalar (native Pool-Discovery shape / test mocks) → pass through.
  const asNum = strictNum(field);
  if (asNum != null) return asNum;
  // Window-object (cross-ref DLMM-index shape) → pick the shortest finite window.
  if (field && typeof field === "object") {
    for (const key of preferredOrder) {
      const v = strictNum(field[key]);
      if (v != null) return v;
    }
  }
  // Unknown shape / null / empty object / all-NaN → fail-closed (gate rejects unknown).
  return null;
}

/**
 * Back-compat alias for the volume-specific call site. `volume` was the first
 * window-object field discovered (commit b233425); `windowScalar` is the general
 * form. Kept so existing imports/tests keep working.
 */
export function volumeScalar(volume, preferredOrder = WINDOW_ORDER) {
  return windowScalar(volume, preferredOrder);
}

/**
 * Map a RAW cross-ref pool (dlmm.datapi.meteora.ag shape) into the scalar field
 * slots the screening gate (getRawPoolScreeningRejectReason) reads. ONE place
 * that knows the cross-ref shape so all three sources stay consistent and no
 * future "layer 7" mismatch can appear in only one source.
 *
 * EXHAUSTIVE shape audit (Sirius 2026-06-11, live SOL/JUP/BONK/WIF):
 *   - volume         → window-OBJECT  → windowScalar (USD, 30m)            [gate: minVolume]
 *   - fee_tvl_ratio  → window-OBJECT  → windowScalar (ratio 0-1, 30m)      [gate: minFeeActiveTvlRatio]
 *       NOTE: there is NO `fee_active_tvl_ratio` on this endpoint. Native
 *       `fee_active_tvl_ratio` and `fee_tvl_ratio` are near-identical ratios
 *       (active_tvl≈tvl) — the total-tvl ratio is the more conservative (lower)
 *       number for a floor gate, and the unit matches (0-1). Cassiopeia-confirmed
 *       unit = ratio. We map fee_tvl_ratio[30m] into the gate's fee_active_tvl_ratio slot.
 *   - tvl            → SCALAR          → numeric (USD)                      [gate: minTvl/maxTvl]
 *       (no `active_tvl` field on this endpoint — tvl is the only TVL number)
 *   - bin_step       → pool_config.bin_step (SCALAR)                        [gate: minBinStep/maxBinStep]
 *       NOTE: native uses dlmm_params.bin_step; cross-ref uses pool_config.bin_step.
 *   - holders        → token_x/y.holders (SCALAR, NOT holder_count)         [gate: minHolders]
 *   - market_cap     → token_x/y.market_cap (SCALAR, USD)                   [gate: minMcap/maxMcap]
 *
 * STRUCTURAL GAPS — fields the gate needs that this endpoint DOES NOT expose
 * (flagged, never fabricated; left null → gate fail-closed rejects, anti-pattern #2):
 *   - volatility     : absent. Native-only. Cross-ref pools can't clear the
 *                      volatility gate without a separate native detail fetch.
 *   - organic_score  : absent on the token object. Cross-ref pools can't clear
 *                      the minOrganic gate.
 *   - token created_at: absent. The endpoint's top-level `created_at` is the
 *                      POOL creation time, NOT the token's — using it for the
 *                      token-age gate is the wrong semantic, so we DO NOT map it.
 *
 * @param {object} meteoraPool raw cross-ref pool, or {} when cross-ref missed
 * @param {object} base the resolved base-side token object (token_x or token_y)
 * @returns {object} scalar field slots (each null when unresolvable)
 */
export function crossrefPoolFields(meteoraPool = {}, base = {}) {
  return {
    tvl: numeric(meteoraPool.tvl ?? meteoraPool.active_tvl),
    volume: windowScalar(meteoraPool.volume),
    // No fee_active_tvl_ratio on this endpoint → use the fee_tvl_ratio window-object
    // (same unit: ratio 0-1; 30m is conservative). Fall back to a scalar
    // fee_active_tvl_ratio if a native-shaped pool/mock is ever passed in.
    feeActiveTvlRatio: windowScalar(meteoraPool.fee_active_tvl_ratio ?? meteoraPool.fee_tvl_ratio),
    feeTvlRatio: windowScalar(meteoraPool.fee_tvl_ratio),
    binStep: numeric(
      meteoraPool.pool_config?.bin_step ??
        meteoraPool.dlmm_params?.bin_step ??
        meteoraPool.bin_step
    ),
    holders: numeric(meteoraPool.base_token_holders ?? base?.holders ?? base?.holder_count),
    marketCap: numeric(base?.market_cap),
    // Structural gaps — kept null on purpose (see header). Never fabricate.
    volatility: numeric(meteoraPool.volatility),
    baseOrganic: numeric(base?.organic_score),
  };
}

/**
 * Look up the best DLMM pool for a mint on Meteora. Returns the raw Meteora pool
 * object or null if no DLMM pool exists (→ skip, can't deploy).
 * @param {string} mint Solana mint address
 * @param {string} [tag] caller tag for log lines (e.g. "pumpfun-graduated")
 */
export async function findDlmmPoolForMint(mint, tag = "meteora-crossref") {
  const url = `${METEORA_DLMM_BASE}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    log("screening", `${tag}: Meteora cross-ref fetch error: ${err.message}`);
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const pools = Array.isArray(data?.data) ? data.data : [];
  return (
    pools.find(
      (pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint
    ) || null
  );
}
