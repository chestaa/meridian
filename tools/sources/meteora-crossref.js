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
export function volumeScalar(volume, preferredOrder = ["30m", "1h", "2h", "4h", "12h", "24h"]) {
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
  const asNum = strictNum(volume);
  if (asNum != null) return asNum;
  // Window-object (cross-ref DLMM-index shape) → pick the shortest finite window.
  if (volume && typeof volume === "object") {
    for (const key of preferredOrder) {
      const v = strictNum(volume[key]);
      if (v != null) return v;
    }
  }
  // Unknown shape / null / empty object / all-NaN → fail-closed (gate rejects unknown).
  return null;
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
