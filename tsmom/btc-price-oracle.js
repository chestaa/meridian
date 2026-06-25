// tsmom/btc-price-oracle.js — INDEPENDENT cbBTC price for the slippage check.
//
// VEGA 🔥 — Phase-B gap #3 fix. btc-order.js asserts realized fill slippage against
// an "expectedOut" derived from a price. Before this module the only price the
// executor had was whatever the caller passed; if it passed nothing, btc-order
// SELF-REFERENCED the Jupiter quote (slippage 0 by construction) — i.e. the slippage
// check could be comparing the quote against itself. That is not a real oracle.
//
// This module fetches an INDEPENDENT cbBTC/USD price so expectedOut is anchored to a
// source the trade route does not control:
//   1) PRIMARY: Jupiter PRICE v3 (lite-api.jup.ag/price/v3) for the cbBTC mint. This
//      is Jupiter's aggregated price feed — distinct from the swap QUOTE route, so a
//      bad/illiquid route shows up as slippage vs this mark.
//   2) FALLBACK: the locally-cached BTC daily CLOSE (Yahoo, from ohlcv-ingest). cbBTC
//      tracks BTC ~1:1; the latest closed daily bar is a sane independent anchor when
//      the live price API is unreachable. Labeled as a fallback so callers know it's
//      coarser (daily, not live).
//
// FAIL-CLOSED (the contract): if NEITHER source yields a finite positive price, we
// return { ok:false, price:null }. The executor then passes cbbtcPriceUsd=undefined,
// and — per Vega's tightening — must NOT let btc-order self-reference. (See
// executor wiring: a null oracle on the LIVE path refuses the order rather than
// trading blind. DRY-RUN still computes an intended order but flags price_unavailable.)
//
// NO MONEY MOVES HERE. Read-only price fetch + a fail-closed decision.

import { log } from "../logger.js";
import { CBBTC_MINT } from "./btc-guards.js";

const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";

function strictPositive(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * PRIMARY: Jupiter price v3 for cbBTC. Returns a finite positive USD price or null.
 * THROWS only on a programmer error; a network/HTTP/shape failure returns null
 * (so resolvePrice can fall through to the cache). Injectable fetch for tests.
 */
export async function fetchJupiterCbbtcPrice({ fetchFn = fetch } = {}) {
  try {
    const url = `${JUPITER_PRICE_API}?ids=${CBBTC_MINT}`;
    const res = await fetchFn(url);
    if (!res || !res.ok) return null;
    const j = await res.json();
    // v3 shape: { <mint>: { usdPrice, ... } }
    const entry = j && j[CBBTC_MINT];
    const px = strictPositive(entry?.usdPrice);
    return px;
  } catch {
    return null; // network/parse failure → let the caller fall back
  }
}

/**
 * FALLBACK: latest CLOSED BTC daily close from the local cache. cbBTC ~ BTC. Returns
 * a finite positive price or null. Injectable history loader for tests.
 */
export function fetchCachedBtcClose({ loadHistoryFn = null } = {}) {
  try {
    const loader = loadHistoryFn || null;
    let rows;
    if (loader) {
      const h = loader("BTC");
      rows = h && Array.isArray(h.rows) ? h.rows : null;
    } else {
      // Lazy import to keep this module load-light and test-injectable.
      // (Synchronous require-style not available in ESM; callers in tests inject.)
      return null;
    }
    if (!rows || rows.length < 2) return null;
    // latest CLOSED bar = second-to-last (last row may be the partial live day).
    const closed = rows[rows.length - 2];
    return strictPositive(closed?.close);
  } catch {
    return null;
  }
}

/**
 * Resolve an independent cbBTC USD price. Tries Jupiter price v3, then the cached BTC
 * close. FAIL-CLOSED: returns { ok:false, price:null, source:null } when neither is
 * usable — the LIVE money path must refuse rather than trade against a self-referenced
 * quote.
 *
 * @returns {Promise<{ok:boolean, price:number|null, source:string|null, reason?:string}>}
 */
export async function resolveCbbtcPrice({ fetchFn = fetch, loadHistoryFn = null } = {}) {
  const live = await fetchJupiterCbbtcPrice({ fetchFn });
  if (live !== null) {
    return { ok: true, price: live, source: "jupiter_price_v3" };
  }
  // Fall back to the cached daily close (needs an injected/real history loader).
  let loader = loadHistoryFn;
  if (!loader) {
    try {
      loader = (await import("./ohlcv-ingest.js")).loadHistory;
    } catch {
      loader = null;
    }
  }
  const cached = fetchCachedBtcClose({ loadHistoryFn: loader });
  if (cached !== null) {
    log("btc_price_oracle", `live price unavailable; using cached BTC close $${cached} as fallback`);
    return { ok: true, price: cached, source: "cached_btc_close_fallback" };
  }
  log("btc_price_oracle", "NO independent cbBTC price (Jupiter v3 + cache both unavailable) — fail-closed");
  return { ok: false, price: null, source: null, reason: "no_independent_price_fail_closed" };
}
