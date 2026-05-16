// signal-enricher.js — Sirius 🐺
//
// Enriches a parsed signal (from signal-parser.js) with real-time on-chain/API
// data BEFORE handing off to Cassiopeia (deterministic filter) / Orion (LLM judge).
//
// Why: signal-parser only extracts fields literally present in the message text.
// Most KOL/alpha signals are just "ape this CA" — they don't contain mcap, vol,
// tvl, etc. So Cassiopeia correctly skips them → Orion never sees them → Phase 1
// gate stays stuck. This enricher fills in the missing fields from Jupiter
// (token info / holders) and Meteora (pool discovery) APIs.
//
// Contract:
//   input  : parsedSignal (output of parseSignalMessage)
//   output : { ...parsedSignal, enrichment: {...}, enriched: bool, enrichedAt: ISO }
//   errors : NEVER throws — returns best-effort partial enrichment on any failure.

import { config } from "./config.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./tools/token.js";

const METEORA_DLMM_BASE = "https://dlmm.datapi.meteora.ag";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

// Test seam: tests can override these to inject mocks without real network.
// eslint-disable-next-line prefer-const
let __overrides = {
  getTokenInfo: null,
  getTokenHolders: null,
  getTokenNarrative: null,
  findPoolForToken: null,
};

export function __setEnricherOverrides(overrides = {}) {
  __overrides = { ...__overrides, ...overrides };
}

export function __resetEnricherOverrides() {
  __overrides = {
    getTokenInfo: null,
    getTokenHolders: null,
    getTokenNarrative: null,
    findPoolForToken: null,
  };
}

/**
 * Find best Meteora DLMM pool for a token mint. Picks highest TVL pool that
 * has the mint on either side.
 */
async function defaultFindPoolForToken(mint) {
  const url = `${METEORA_DLMM_BASE}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  const match = pools.find((p) => p?.token_x?.address === mint || p?.token_y?.address === mint);
  if (!match?.address) return null;

  // Fetch deeper detail from pool-discovery API so we get fee_active_tvl_ratio,
  // volatility, bin_step, etc. — same fields screening.js uses for gates.
  const tf = config?.screening?.timeframe || "30m";
  const detailUrl = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${match.address}`)}&timeframe=${tf}`;
  const detailRes = await fetch(detailUrl);
  const detailJson = detailRes.ok ? await detailRes.json() : null;
  const detail = (detailJson?.data || [])[0] || null;

  return {
    pool_address: match.address,
    tvl: Number(detail?.tvl ?? match.tvl ?? 0) || null,
    active_tvl: Number(detail?.active_tvl ?? null) || null,
    volume24h: Number(detail?.volume ?? match.volume ?? 0) || null,
    fee_active_tvl_ratio: Number(detail?.fee_active_tvl_ratio ?? null) || null,
    bin_step: Number(detail?.dlmm_params?.bin_step ?? match.bin_step ?? null) || null,
    volatility: Number(detail?.volatility ?? null) || null,
    base_mint: detail?.token_x?.address ?? match?.token_x?.address ?? null,
    quote_mint: detail?.token_y?.address ?? match?.token_y?.address ?? null,
    base_symbol: detail?.token_x?.symbol ?? match?.token_x?.symbol ?? null,
  };
}

function summarize(symbol, enrichment) {
  const fmt = (n) =>
    n == null || !Number.isFinite(Number(n))
      ? "n/a"
      : `$${Math.round(Number(n)).toLocaleString("en-US")}`;
  return `[ENRICH] ${symbol || "?"} mcap=${fmt(enrichment.mcapUsd)} vol=${fmt(enrichment.volume24h)} tvl=${fmt(enrichment.tvl)}`;
}

export async function enrichSignal(parsedSignal) {
  if (!parsedSignal || typeof parsedSignal !== "object") return parsedSignal;
  if (!parsedSignal.tokenAddress) return parsedSignal; // can't enrich w/o mint

  const mint = parsedSignal.tokenAddress;
  const errors = [];
  const enrichment = {
    mint,
    mcapUsd: null,
    priceUsd: null,
    liquidityUsd: null,
    holders: null,
    organicScore: null,
    top10Pct: null,
    bundlersPct: null,
    snipersPct: null,
    suspiciousPct: null,
    riskLevel: null,
    narrative: null,
    pool_address: null,
    tvl: null,
    active_tvl: null,
    volume24h: null,
    fee_active_tvl_ratio: null,
    bin_step: null,
    volatility: null,
    base_symbol: null,
  };

  const tokenInfoFn = __overrides.getTokenInfo || getTokenInfo;
  const tokenHoldersFn = __overrides.getTokenHolders || getTokenHolders;
  const narrativeFn = __overrides.getTokenNarrative || getTokenNarrative;
  const poolFinderFn = __overrides.findPoolForToken || defaultFindPoolForToken;

  // 1) Jupiter token info
  try {
    const info = await tokenInfoFn({ query: mint });
    const hit = info?.results?.find((r) => r.mint === mint) || info?.results?.[0] || null;
    if (hit) {
      enrichment.mcapUsd = Number(hit.mcap) || null;
      enrichment.priceUsd = Number(hit.price) || null;
      enrichment.liquidityUsd = Number(hit.liquidity) || null;
      enrichment.holders = Number(hit.holders) || null;
      enrichment.organicScore = Number(hit.organic_score) || null;
      enrichment.base_symbol = hit.symbol || enrichment.base_symbol;
      if (hit.bundle_pct != null) enrichment.bundlersPct = Number(hit.bundle_pct);
      if (hit.sniper_pct != null) enrichment.snipersPct = Number(hit.sniper_pct);
      if (hit.suspicious_pct != null) enrichment.suspiciousPct = Number(hit.suspicious_pct);
      if (hit.risk_level != null) enrichment.riskLevel = hit.risk_level;
    }
  } catch (err) {
    errors.push(`tokenInfo: ${err.message}`);
  }

  // 2) Jupiter holders (top10 concentration, bundle/sniper/risk via OKX inside)
  try {
    const holders = await tokenHoldersFn({ mint, limit: 20 });
    if (holders) {
      const top10 = parseFloat(holders.top_10_real_holders_pct);
      if (Number.isFinite(top10)) enrichment.top10Pct = top10;
      if (enrichment.bundlersPct == null && holders.bundle_pct != null) {
        enrichment.bundlersPct = Number(holders.bundle_pct);
      }
      if (enrichment.snipersPct == null && holders.sniper_pct != null) {
        enrichment.snipersPct = Number(holders.sniper_pct);
      }
      if (enrichment.suspiciousPct == null && holders.suspicious_pct != null) {
        enrichment.suspiciousPct = Number(holders.suspicious_pct);
      }
      if (enrichment.riskLevel == null && holders.risk_level != null) {
        enrichment.riskLevel = holders.risk_level;
      }
    }
  } catch (err) {
    errors.push(`tokenHolders: ${err.message}`);
  }

  // 3) Jupiter narrative (best-effort, often null)
  try {
    const nar = await narrativeFn({ mint });
    enrichment.narrative = nar?.narrative || null;
  } catch (err) {
    errors.push(`narrative: ${err.message}`);
  }

  // 4) Meteora pool lookup
  try {
    const pool = await poolFinderFn(mint);
    if (pool) {
      enrichment.pool_address = pool.pool_address || null;
      enrichment.tvl = pool.tvl ?? null;
      enrichment.active_tvl = pool.active_tvl ?? null;
      enrichment.volume24h = pool.volume24h ?? null;
      enrichment.fee_active_tvl_ratio = pool.fee_active_tvl_ratio ?? null;
      enrichment.bin_step = pool.bin_step ?? null;
      enrichment.volatility = pool.volatility ?? null;
      if (!enrichment.base_symbol && pool.base_symbol) enrichment.base_symbol = pool.base_symbol;
    }
  } catch (err) {
    errors.push(`poolFinder: ${err.message}`);
  }

  // Merge enrichment fields up to top-level so scoreParsedSignal sees them.
  const merged = {
    ...parsedSignal,
    // Promote into top-level signal fields used by scoreParsedSignal + judge prompt.
    mcapUsd: parsedSignal.mcapUsd ?? enrichment.mcapUsd,
    vol5mUsd: parsedSignal.vol5mUsd ?? enrichment.volume24h, // best available proxy
    symbol: parsedSignal.symbol ?? enrichment.base_symbol,
    enrichment,
    enriched: true,
    enrichedAt: new Date().toISOString(),
    enrichmentErrors: errors.length ? errors : undefined,
  };

  console.log(summarize(merged.symbol, enrichment));
  return merged;
}

export default enrichSignal;
