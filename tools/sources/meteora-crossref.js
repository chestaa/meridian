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
