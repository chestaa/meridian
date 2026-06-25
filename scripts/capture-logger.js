#!/usr/bin/env node
/**
 * capture-logger.js — Cassiopeia 👁️
 *
 * Forward-capture data logger. READ-ONLY. NO money path, NO on-chain writes,
 * NO LLM calls. Captures the pool universe AS SEEN at snapshot_ts so we build an
 * honest forward dataset (no look-ahead bias — we NEVER re-query a past snapshot
 * and overwrite it).
 *
 * STRICT import boundary (enforced by test-capture-imports.js):
 *   - reads ONLY the screening / pool-read path (tools/screening.js exports +
 *     config.js)
 *   - MUST NOT import executor.js, dlmm.js (deploy), or wallet.js signing.
 *
 * Cadence (TIERED):
 *   - tier1 (hourly): full broad-discovery universe. Gate fields + price
 *     envelope, NO OKX/Jupiter enrichment. Derived gate verdict per pool.
 *   - tier2 (15-min): the watchlist = pools that PASSED the gate on the most
 *     recent tier1 sweep. Full per-pool detail re-fetch (native detail endpoint),
 *     re-run the gate against the fresh snapshot. Small set → negligible cost.
 *
 * Storage: append-only JSONL, one file per UTC day, OUTSIDE the git tree
 *   /var/lib/meridian-capture/{tier1,tier2}/YYYY-MM-DD.jsonl
 *   /var/lib/meridian-capture/manifest.jsonl   (one line per sweep — data GAPS
 *                                                are explicitly recorded, never
 *                                                silently inferred as zero)
 *
 * Every data row carries: schema_version, config_hash, snapshot_ts, the pool
 * snapshot fields, the derived gate verdict (pass/reject) + reject_reason.
 *
 * Usage:
 *   node scripts/capture-logger.js tier1
 *   node scripts/capture-logger.js tier2
 *   CAPTURE_DIR=/custom/path node scripts/capture-logger.js tier1
 *
 * The watchlist is persisted between runs at <CAPTURE_DIR>/watchlist.json (the
 * last tier1 pass set), so the cron tier2 job knows what to re-snapshot.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// READ-PATH ONLY imports. Everything here is from the screening/pool-read path
// or pure config — no executor, no dlmm deploy, no wallet signing.
import { config } from "../config.js";
import {
  effectiveScreeningThresholds,
  buildDiscoveryFilters,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

const SCHEMA_VERSION = 1;

// Native Pool-Discovery API (same base screening.js reads). We construct the
// URL locally rather than importing the private fetcher — keeps the import
// surface to the exported, side-effect-free helpers only.
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const CAPTURE_DIR = process.env.CAPTURE_DIR || "/var/lib/meridian-capture";

// ─── helpers ──────────────────────────────────────────────────────────────

/** UTC day string YYYY-MM-DD for the daily file rotation. */
function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Deterministic config hash over the EFFECTIVE screening thresholds — so each
 * row records exactly which gate config produced its verdict. Sorted keys →
 * stable hash regardless of object key order.
 */
function configHash(s) {
  const stable = JSON.stringify(s, Object.keys(s).sort());
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Append one JSON object as a line to a JSONL file (created if missing). */
function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function tierFile(tier, ts) {
  return path.join(CAPTURE_DIR, tier, `${utcDay(ts)}.jsonl`);
}

function manifestFile() {
  return path.join(CAPTURE_DIR, "manifest.jsonl");
}

function watchlistFile() {
  return path.join(CAPTURE_DIR, "watchlist.json");
}

/**
 * Raw broad-discovery page fetch. Mirrors screening.js fetchPoolDiscoveryPage URL
 * construction but is local to the capture path (no private import). READ-ONLY
 * GET. Throws on non-OK so the caller records the error in the manifest (never
 * silently treats a failed fetch as an empty universe).
 */
async function fetchBroadUniverse(s) {
  const filters = buildDiscoveryFilters(s);
  const pageSize = Number(s.broadDiscoveryPageSize) || 1000;
  const timeframe = s.timeframe || "1h";
  const category = s.category || "trending";
  const sortBy = s.broadDiscoveryEnabled !== false ? s.broadSortBy || null : null;

  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}` +
    (sortBy ? `&sort_by=${encodeURIComponent(sortBy)}` : "");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Single-pool native detail fetch (full risk-relevant fields) for tier2. READ-ONLY
 * GET. Throws on non-OK so the caller records a degraded source. Returns the raw
 * pool object (same shape the gate fn reads) or null if the pool vanished.
 */
async function fetchPoolDetail(poolAddress, s) {
  const timeframe = s.timeframe || "1h";
  const url =
    `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

/**
 * Extract the capture row from a RAW pool object AS SEEN at snapshot_ts. We keep
 * the gate-relevant fields + a price envelope. We do NOT re-derive or back-fill
 * anything from a later query — this is a point-in-time snapshot.
 *
 * `enriched` flags tier2 rows (full detail re-fetch) vs tier1 (broad-page fields).
 */
function buildPoolRow(pool, s, { snapshotTs, cfgHash, tier, enriched }) {
  const base = pool?.token_x || {};
  // Derived gate verdict AT CAPTURE TIME — the whole point of forward capture.
  // Run the SAME gate the live screener runs, against this exact snapshot.
  let rejectReason = null;
  let gateError = null;
  try {
    rejectReason = getRawPoolScreeningRejectReason(pool, s);
  } catch (err) {
    // Never fabricate a verdict. A gate exception is recorded honestly so the
    // row is not silently counted as either pass or reject.
    gateError = err?.message || String(err);
  }

  return {
    schema_version: SCHEMA_VERSION,
    config_hash: cfgHash,
    snapshot_ts: snapshotTs,
    tier,
    enriched: Boolean(enriched),

    pool_address: pool?.pool_address ?? null,
    name: pool?.name ?? null,
    pool_type: pool?.pool_type ?? null,

    base_symbol: base?.symbol ?? null,
    base_mint: base?.address ?? null,
    quote_symbol: pool?.token_y?.symbol ?? null,
    quote_mint: pool?.token_y?.address ?? null,

    // Gate-relevant fields (raw, as seen). null is preserved as null — NEVER
    // coerced to 0 (a missing field must stay missing in the dataset).
    bin_step: pool?.dlmm_params?.bin_step ?? null,
    tvl: pool?.tvl ?? null,
    active_tvl: pool?.active_tvl ?? null,
    fee_window: pool?.fee ?? null,
    volume_window: pool?.volume ?? null,
    fee_active_tvl_ratio: pool?.fee_active_tvl_ratio ?? null,
    volatility: pool?.volatility ?? null,
    holders: pool?.base_token_holders ?? null,
    mcap: base?.market_cap ?? null,
    organic_score: base?.organic_score ?? null,
    token_created_at: base?.created_at ?? null,
    launchpad: base?.launchpad ?? pool?.base_token_launchpad ?? null,

    // Warning / ownership sanity flags (gate inputs).
    base_critical_warnings: pool?.base_token_has_critical_warnings ?? null,
    quote_critical_warnings: pool?.quote_token_has_critical_warnings ?? null,
    base_high_single_ownership: pool?.base_token_has_high_single_ownership ?? null,
    base_high_supply_concentration: pool?.base_token_has_high_supply_concentration ?? null,

    // Price envelope (point-in-time).
    price: pool?.pool_price ?? null,
    price_change_pct: pool?.pool_price_change_pct ?? null,
    price_trend: pool?.price_trend ?? null,
    min_price: pool?.min_price ?? null,
    max_price: pool?.max_price ?? null,

    // Activity envelope.
    swap_count: pool?.swap_count ?? null,
    unique_traders: pool?.unique_traders ?? null,
    buy_vol: pool?.buy_vol ?? null,
    sell_vol: pool?.sell_vol ?? null,

    // Derived verdict.
    gate_pass: gateError ? null : rejectReason === null,
    reject_reason: rejectReason,
    gate_error: gateError,
  };
}

function writeManifest(line) {
  appendJsonl(manifestFile(), line);
}

function loadWatchlist() {
  try {
    const raw = fs.readFileSync(watchlistFile(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.pools) ? parsed : { pools: [], updated_ts: null };
  } catch {
    return { pools: [], updated_ts: null };
  }
}

function saveWatchlist(poolAddresses, ts) {
  ensureDir(CAPTURE_DIR);
  fs.writeFileSync(
    watchlistFile(),
    JSON.stringify({ pools: poolAddresses, updated_ts: ts }, null, 2),
  );
}

// ─── tier 1: full broad universe (hourly) ──────────────────────────────────

export async function runTier1() {
  const sweepTs = Date.now();
  const s = effectiveScreeningThresholds();
  const cfgHash = configHash(s);

  let universe = [];
  let apiErrors = 0;
  const sourcesDegraded = [];

  try {
    universe = await fetchBroadUniverse(s);
  } catch (err) {
    apiErrors += 1;
    sourcesDegraded.push(`pool_discovery_broad: ${err?.message || err}`);
  }

  let captured = 0;
  let passed = 0;
  const passedAddresses = [];
  const file = tierFile("tier1", sweepTs);

  for (const pool of universe) {
    const row = buildPoolRow(pool, s, {
      snapshotTs: sweepTs,
      cfgHash,
      tier: "tier1",
      enriched: false,
    });
    appendJsonl(file, row);
    captured += 1;
    if (row.gate_pass === true) {
      passed += 1;
      if (row.pool_address) passedAddresses.push(row.pool_address);
    }
  }

  // Persist the watchlist for the next tier2 sweep — only when the fetch
  // succeeded. If the universe fetch failed (apiErrors>0 + empty), do NOT
  // overwrite a good watchlist with an empty one inferred from a gap.
  if (apiErrors === 0) {
    saveWatchlist(passedAddresses, sweepTs);
  } else {
    sourcesDegraded.push("watchlist_not_updated_due_to_fetch_failure");
  }

  writeManifest({
    schema_version: SCHEMA_VERSION,
    config_hash: cfgHash,
    sweep_ts: sweepTs,
    tier: "tier1",
    pools_captured: captured,
    pools_passed: passed,
    api_errors: apiErrors,
    sources_degraded: sourcesDegraded,
  });

  return { tier: "tier1", captured, passed, apiErrors, sourcesDegraded };
}

// ─── tier 2: watchlist re-snapshot with full detail (15-min) ────────────────

export async function runTier2() {
  const sweepTs = Date.now();
  const s = effectiveScreeningThresholds();
  const cfgHash = configHash(s);

  const watchlist = loadWatchlist();
  const addresses = watchlist.pools || [];

  let captured = 0;
  let passed = 0;
  let apiErrors = 0;
  const sourcesDegraded = [];
  const file = tierFile("tier2", sweepTs);

  // Sequential to avoid hammering the API (read-only, small set). Each pool's
  // failure is isolated and recorded as a degraded source — a gap, never a zero.
  for (const addr of addresses) {
    let detail = null;
    try {
      detail = await fetchPoolDetail(addr, s);
    } catch (err) {
      apiErrors += 1;
      sourcesDegraded.push(`detail:${addr}: ${err?.message || err}`);
      continue;
    }
    if (!detail) {
      // Pool no longer returned by the endpoint — record the gap explicitly.
      sourcesDegraded.push(`detail:${addr}: pool_not_found`);
      continue;
    }
    const row = buildPoolRow(detail, s, {
      snapshotTs: sweepTs,
      cfgHash,
      tier: "tier2",
      enriched: true,
    });
    appendJsonl(file, row);
    captured += 1;
    if (row.gate_pass === true) passed += 1;
  }

  writeManifest({
    schema_version: SCHEMA_VERSION,
    config_hash: cfgHash,
    sweep_ts: sweepTs,
    tier: "tier2",
    watchlist_size: addresses.length,
    watchlist_updated_ts: watchlist.updated_ts,
    pools_captured: captured,
    pools_passed: passed,
    api_errors: apiErrors,
    sources_degraded: sourcesDegraded,
  });

  return {
    tier: "tier2",
    watchlistSize: addresses.length,
    captured,
    passed,
    apiErrors,
    sourcesDegraded,
  };
}

// Exported for unit tests (no network).
export {
  buildPoolRow,
  configHash,
  utcDay,
  SCHEMA_VERSION,
  CAPTURE_DIR,
};

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const tier = process.argv[2];
  if (tier === "tier1") {
    const r = await runTier1();
    console.log(`[capture] tier1: captured=${r.captured} passed=${r.passed} apiErrors=${r.apiErrors}`);
    if (r.sourcesDegraded.length) console.log(`[capture] degraded: ${r.sourcesDegraded.join("; ")}`);
  } else if (tier === "tier2") {
    const r = await runTier2();
    console.log(`[capture] tier2: watchlist=${r.watchlistSize} captured=${r.captured} passed=${r.passed} apiErrors=${r.apiErrors}`);
    if (r.sourcesDegraded.length) console.log(`[capture] degraded: ${r.sourcesDegraded.join("; ")}`);
  } else {
    console.error("usage: node scripts/capture-logger.js <tier1|tier2>");
    process.exit(2);
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[capture] fatal: ${err?.message || err}`);
    process.exit(1);
  });
}
