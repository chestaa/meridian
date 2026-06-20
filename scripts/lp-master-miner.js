#!/usr/bin/env node
/**
 * lp-master-miner.js — Sirius 🐺 (Signal Collector) — Roadmap step 4: DATA-MOAT
 *
 * Mines REAL, on-chain-verified Solana wallet addresses that are active LPs in
 * Meteora DLMM pools, biased toward our OWN gate-passed quality pools, and seeds
 * PnL-VERIFIED "LP-Master" wallets from the LPAgent top-LPer feed where available.
 * NO fabrication: every address is either read straight off a getProgramAccounts
 * scan of the Meteora DLMM program, or returned by the LPAgent top-LP API.
 *
 * This SUPERSEDES scripts/mine-smart-wallets.js (recurrence-only, looser pool
 * filter, zero PnL). The upgrades roadmap step 4 demands:
 *   1. PRIMARY quality source = getTopCandidates() (the REAL Cassiopeia gate),
 *      not a hand-rolled fee_active_tvl_ratio>=0.05 filter.
 *   2. PnL-VERIFIED seed via tools/study.js (studyTopLPers → LPAgent winrate/ROI).
 *   3. Honest trust tiers that distinguish PnL-verified from recurrence-only.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *  Source A (PRIMARY) — gate-passed quality pools:
 *    getTopCandidates({limit}) → pools that pass the FULL strict Cassiopeia gate
 *    (rug/bot/holders/fee-TVL/organic/TVL-MC/volatility/age). These are the pools
 *    WE would deploy into, so their LPs are sophisticated by construction.
 *  Source B (FALLBACK) — public pool-discovery + our pool-memory positive-PnL
 *    pools. Used only if Source A throws (e.g. RPC/import unavailable in a bare
 *    cron env). Honest degradation, never silent.
 *
 *  For each pool:
 *    - getProgramAccounts(DLMM_PROGRAM) filtered by POOL@offset8, dataSlice
 *      owner@offset40 → real on-chain LP owners (recurrence signal).
 *    - studyTopLPers(pool) → LPAgent-ranked top LPers WITH winrate/ROI/PnL.
 *      These are the PnL-VERIFIED LP-Masters. (External API: fail-OPEN, never
 *      fabricate — if it returns nothing, we just lose the PnL tier for that pool.)
 *
 *  Ranking / trust tiers (HONEST — see anti-fabrication note):
 *    - lp_master  : appears in LPAgent top-LPers with positive winrate/ROI
 *                   (real PnL evidence). Highest trust.
 *    - recurring  : on-chain LP across >=2 distinct quality pools (strong proxy,
 *                   NO PnL evidence — conservative).
 *    - active     : on-chain LP in exactly 1 quality pool (weakest — included only
 *                   above --min-positions; default keeps these out of the write set).
 *
 * ── ANTI-FABRICATION (anti-pattern #2 + feedback no-fabrication) ─────────────
 *  - PnL is NEVER invented. On-chain raw data gives recurrence + pool quality, NOT
 *    realized PnL. The ONLY PnL evidence is LPAgent (studyTopLPers). A wallet with
 *    no LPAgent record gets trust_tier "recurring"/"active" and notes that say so.
 *  - If a source is blocked (RPC 403, API down), we report the gap honestly and
 *    write ONLY what was verified. Zero verified → write nothing, exit clean.
 *
 * ── MUST RUN ON VPS ─────────────────────────────────────────────────────────
 *  Requires real RPC (HELIUS_API_KEY / RPC_URL in VPS .env). getProgramAccounts
 *  with memcmp against the DLMM program is heavy and 403/timeouts on blocked local
 *  env. smart-wallets.json is gitignored (per-host) → run here to populate live.
 *  Run: `node scripts/lp-master-miner.js`
 *
 *  Flags:
 *    --dry              : do everything but DON'T write smart-wallets.json
 *    --pools=N          : how many quality pools to scan (default 15)
 *    --cap=N            : max NEW wallets to write (default 40)
 *    --min-positions=N  : min distinct quality pools a recurrence wallet must
 *                         appear in to be written (default 2 — keeps the moat
 *                         high-signal; LPAgent lp_masters bypass this floor).
 *    --no-onchain       : skip the getProgramAccounts recurrence scan (LPAgent only)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const WALLETS_PATH = path.join(ROOT, "smart-wallets.json");
const POOL_MEMORY_PATH = path.join(ROOT, "pool-memory.json");

const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Position account layout (matches tools/dlmm.js getWalletPositions):
//   bytes  8..40  -> pool (lbPair) pubkey
//   bytes 40..72  -> owner pubkey
const OFFSET_POOL = 8;
const OFFSET_OWNER = 40;

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const NO_ONCHAIN = args.includes("--no-onchain");
const numArg = (flag, def) => {
  const a = args.find((x) => x.startsWith(`${flag}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) ? n : def;
};
const POOL_COUNT = numArg("--pools", 15);
const CAP = numArg("--cap", 40);
const MIN_POSITIONS = numArg("--min-positions", 2);

const log = (...m) => console.log("[lp-master-miner]", ...m);

function getConnection() {
  const rpc = process.env.RPC_URL;
  if (!rpc) {
    throw new Error(
      "RPC_URL missing. This script MUST run on the VPS where .env has RPC_URL / HELIUS_API_KEY."
    );
  }
  return new Connection(rpc, "confirmed");
}

function shortAddr(a) {
  return `${a.slice(0, 4)}-${a.slice(-4)}`;
}

function sanitizeName(s) {
  return String(s || "pool").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24) || "pool";
}

// ── Source A (PRIMARY): the REAL Cassiopeia gate-passed quality pools ───────
async function qualityPoolsFromGate(limit) {
  try {
    const { getTopCandidates } = await import("../tools/screening.js");
    const res = await getTopCandidates({ limit });
    const cands = Array.isArray(res?.candidates)
      ? res.candidates
      : Array.isArray(res?.pools)
      ? res.pools
      : Array.isArray(res)
      ? res
      : [];
    const pools = cands
      .map((p) => ({
        pool: p.pool || p.pool_address || p.address,
        name: p.name || p.base?.symbol || "pool",
        fee_tvl: Number(p.fee_active_tvl_ratio ?? 0) || null,
        source: "gate-passed",
      }))
      .filter((p) => p.pool && SOLANA_PUBKEY_RE.test(p.pool));
    log(`Source A (getTopCandidates gate): ${pools.length} gate-passed quality pool(s)`);
    return pools;
  } catch (e) {
    log(`Source A FAILED (getTopCandidates): ${e.message} — falling back to public discovery + pool-memory`);
    return null; // null signals failure → trigger fallback
  }
}

// ── Source B (FALLBACK): public discovery API ───────────────────────────────
async function discoverGoodPools(pageSize) {
  const filters = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "tvl>=10000",
    "volume>=2000",
    "fee_active_tvl_ratio>=0.06",
  ].join("&&");
  const url =
    `${POOL_DISCOVERY_BASE}/pools?page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=24h&category=trending`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log(`pool-discovery API ${res.status} ${res.statusText} — skipping public discovery`);
      return [];
    }
    const data = await res.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows
      .map((p) => ({
        pool: p.pool_address,
        name: p.name || p.base?.symbol || "pool",
        fee_tvl: Number(p.fee_active_tvl_ratio ?? 0) || null,
        source: "public-discovery",
      }))
      .filter((p) => p.pool && SOLANA_PUBKEY_RE.test(p.pool));
  } catch (e) {
    log(`pool-discovery fetch failed: ${e.message}`);
    return [];
  }
}

// ── Source B (FALLBACK): our own positive-PnL pool-memory ───────────────────
function goodPoolsFromMemory() {
  if (!fs.existsSync(POOL_MEMORY_PATH)) return [];
  let mem;
  try {
    mem = JSON.parse(fs.readFileSync(POOL_MEMORY_PATH, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const [poolAddr, info] of Object.entries(mem)) {
    if (!SOLANA_PUBKEY_RE.test(poolAddr)) continue;
    const deploys = Array.isArray(info.deploys) ? info.deploys : [];
    const totalPnl = deploys.reduce((s, d) => s + (Number(d.pnl_pct) || 0), 0);
    if (totalPnl > 0) {
      out.push({ pool: poolAddr, name: info.name || "mem-pool", fee_tvl: null, source: "pool-memory" });
    }
  }
  return out;
}

// ── on-chain: who is LP in this pool? ───────────────────────────────────────
async function getLpOwnersForPool(conn, poolAddress) {
  const accounts = await conn.getProgramAccounts(DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: OFFSET_POOL, bytes: poolAddress } }],
    dataSlice: { offset: OFFSET_OWNER, length: 32 }, // owner field only → small response
  });
  const owners = new Set();
  for (const acc of accounts) {
    try {
      const owner = new PublicKey(acc.account.data).toBase58();
      if (SOLANA_PUBKEY_RE.test(owner)) owners.add(owner);
    } catch {
      /* skip undecodable */
    }
  }
  return [...owners];
}

// ── PnL-verified seed: LPAgent top-LPers (the ONLY source of real PnL) ──────
async function topLpersForPool(poolAddress, poolName) {
  try {
    const { studyTopLPers } = await import("../tools/study.js");
    const res = await studyTopLPers({ pool_address: poolAddress, limit: 6 });
    const lpers = Array.isArray(res?.lpers) ? res.lpers : [];
    return lpers
      .map((l) => ({
        address: l.owner,
        win_rate: Number(l.summary?.win_rate ?? 0) || 0, // 0..1
        roi: Number(l.summary?.roi ?? 0) || 0,
        total_pnl_usd: Number(l.summary?.total_pnl_usd ?? 0) || 0,
        avg_hold_hours: Number(l.summary?.avg_hold_hours ?? 0) || 0,
        strategy: l.summary?.preferred_strategy || "unknown",
        poolName,
      }))
      .filter((l) => l.address && SOLANA_PUBKEY_RE.test(l.address));
  } catch (e) {
    log(`  ! LPAgent top-LPer fetch failed for ${poolName} (${shortAddr(poolAddress)}): ${e.message}`);
    return [];
  }
}

// ── PURE record builders (exported for tests — anti-fabrication invariants) ──
// Build the NEW wallet records from a recurrence tally + LPAgent master map,
// deduping against `knownAddrs`. Returns records in the exact addSmartWallet()
// schema ({name,address,category,type,addedAt}) PLUS a _provenance block.
//
// INVARIANTS (tested):
//   - lp_master records carry REAL LPAgent PnL; recurring records carry null PnL
//     (anti-fabrication: never invent profit for an on-chain-only wallet).
//   - no address appears twice; no address in knownAddrs is re-added.
//   - lp_master bypasses minPositions; recurring must meet minPositions.
//   - only positive-evidence masters qualify as lp_master.
// ── PnL plausibility gate (anti-fabrication on the EXTERNAL feed) ────────────
// The LPAgent feed returns garbage extremes (live-observed: roi=58_465_479%,
// winrate=0 — a single dust position inflating ROI to millions). Promoting those
// to the lp_master tier = following fake alpha (anti-pattern #2). A REAL LP-master
// must show a plausible win_rate AND a bounded ROI AND positive realized PnL.
// Anything outside the band is NOT trusted as PnL-verified — it can still land in
// the recurring tier on its on-chain merit, just without invented PnL.
//   - win_rate must be in (0, 1]  (0 = no won trades / no data → not a master)
//   - roi must be in (0, ROI_CEIL] (ROI_CEIL = 50 → 5000%; above = broken/dust)
//   - total_pnl_usd must be > MIN_PNL_USD (filters dust-position ROI artifacts)
export const ROI_CEIL = 50; // 5000% realized — generous, anything above is broken feed
export const MIN_PNL_USD = 20; // dust positions (<$20 PnL) produce nonsense ROI
export function isPlausibleMasterEvidence(m) {
  const wr = Number(m.win_rate);
  const roi = Number(m.roi);
  const pnl = Number(m.total_pnl_usd);
  if (!Number.isFinite(wr) || wr <= 0 || wr > 1) return false;
  if (!Number.isFinite(roi) || roi <= 0 || roi > ROI_CEIL) return false;
  if (!Number.isFinite(pnl) || pnl <= MIN_PNL_USD) return false;
  return true;
}

export function buildRecords({ tally, lpMasters, knownAddrs, minPositions = 2, cap = 40 }) {
  const records = [];
  const used = new Set(knownAddrs);

  const rankedMasters = [...lpMasters.values()]
    .filter(isPlausibleMasterEvidence)
    .sort((a, b) => b.roi - a.roi || b.win_rate - a.win_rate);
  for (const m of rankedMasters) {
    if (used.has(m.address)) continue;
    if (records.length >= cap) break;
    const t = tally.get(m.address);
    records.push({
      name: `lpmaster-${sanitizeName(m.poolName)}-${shortAddr(m.address)}`.slice(0, 64),
      address: m.address,
      category: "alpha",
      type: "lp",
      addedAt: new Date().toISOString(),
      _provenance: {
        trust_tier: "lp_master",
        mined_by: "sirius",
        source: "lpagent_top_lper",
        win_rate: m.win_rate,
        roi: m.roi,
        total_pnl_usd: m.total_pnl_usd,
        avg_hold_hours: m.avg_hold_hours,
        preferred_strategy: m.strategy,
        onchain_pools_seen_in: t ? t.pools.size : 0,
        notes:
          "PnL-verified via LPAgent top-LPer feed (winrate/ROI are real, externally sourced). " +
          (t ? `Also confirmed on-chain in ${t.pools.size} quality pool(s).` : "Not cross-confirmed on-chain this run."),
      },
    });
    used.add(m.address);
  }

  const rankedRecurring = [...tally.entries()]
    .map(([address, t]) => ({ address, poolCount: t.pools.size, positionCount: t.count, firstPool: t.firstPool }))
    .filter((w) => !used.has(w.address) && w.poolCount >= minPositions)
    .sort((a, b) => b.poolCount - a.poolCount || b.positionCount - a.positionCount);
  for (const w of rankedRecurring) {
    if (records.length >= cap) break;
    records.push({
      name: `recurring-${sanitizeName(w.firstPool.name)}-${shortAddr(w.address)}`.slice(0, 64),
      address: w.address,
      category: "alpha",
      type: "lp",
      addedAt: new Date().toISOString(),
      _provenance: {
        trust_tier: "recurring",
        mined_by: "sirius",
        source: "onchain_getProgramAccounts",
        method: "getProgramAccounts(DLMM) owner@offset40",
        onchain_pools_seen_in: w.poolCount,
        onchain_positions: w.positionCount,
        win_rate: null,
        roi: null,
        notes:
          `Recurring LP across ${w.poolCount} gate-passed quality pool(s). ` +
          "NO realized-PnL evidence (on-chain raw cannot prove profit); trust is recurrence + pool-quality proxy only — conservative.",
      },
    });
    used.add(w.address);
  }
  return records;
}

export { sanitizeName, shortAddr, SOLANA_PUBKEY_RE };

function loadExisting() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    const data = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    if (!Array.isArray(data.wallets)) return { wallets: [] };
    return data;
  } catch {
    return { wallets: [] };
  }
}

async function main() {
  log(
    `start — pools=${POOL_COUNT} cap=${CAP} minPositions=${MIN_POSITIONS} ` +
      `onchain=${!NO_ONCHAIN} dry=${DRY}`
  );

  // ── gather quality pools (Source A primary, B fallback) ────────────────────
  let pools = await qualityPoolsFromGate(POOL_COUNT);
  let degraded = false;
  if (pools === null) {
    degraded = true;
    const disc = await discoverGoodPools(POOL_COUNT);
    const mem = goodPoolsFromMemory();
    const map = new Map();
    for (const p of [...disc, ...mem]) if (!map.has(p.pool)) map.set(p.pool, p);
    pools = [...map.values()];
  }
  pools = pools.slice(0, POOL_COUNT);

  if (pools.length === 0) {
    log("NO quality pools available (all sources empty/blocked). Reporting gap honestly — no wallets written.");
    return;
  }
  log(
    `${degraded ? "[DEGRADED fallback] " : ""}scanning ${pools.length} pool(s): ${pools
      .map((p) => p.name)
      .join(", ")}`
  );

  // ── on-chain recurrence tally + LPAgent PnL seed ───────────────────────────
  const conn = NO_ONCHAIN ? null : (() => { try { return getConnection(); } catch (e) { log(`RPC unavailable: ${e.message} — recurrence scan SKIPPED`); return null; } })();

  const tally = new Map(); // owner -> { count, pools:Set, firstPool }
  const lpMasters = new Map(); // owner -> best LPAgent record

  for (const p of pools) {
    // recurrence (on-chain)
    if (conn) {
      try {
        const owners = await getLpOwnersForPool(conn, p.pool);
        log(`  ${p.name} (${shortAddr(p.pool)}) → ${owners.length} on-chain LP owners`);
        for (const owner of owners) {
          if (!tally.has(owner)) tally.set(owner, { count: 0, pools: new Set(), firstPool: p });
          const t = tally.get(owner);
          t.count += 1;
          t.pools.add(p.pool);
        }
      } catch (e) {
        log(`  ! ${p.name} (${shortAddr(p.pool)}) on-chain scan failed: ${e.message}`);
      }
    }
    // PnL-verified (LPAgent)
    const masters = await topLpersForPool(p.pool, p.name);
    if (masters.length) {
      log(`  ${p.name}: LPAgent returned ${masters.length} top-LPer(s) with PnL data`);
    }
    for (const m of masters) {
      const prev = lpMasters.get(m.address);
      // keep the record with the strongest evidence (higher roi, then winrate)
      if (!prev || m.roi > prev.roi || (m.roi === prev.roi && m.win_rate > prev.win_rate)) {
        lpMasters.set(m.address, m);
      }
    }
  }

  if (tally.size === 0 && lpMasters.size === 0) {
    log("Scanned pools but found ZERO LP wallets (on-chain blocked AND LPAgent empty). Reporting gap honestly — no wallets written.");
    return;
  }

  // ── build records with HONEST trust tiers ──────────────────────────────────
  const existing = loadExisting();
  const known = new Set(existing.wallets.map((w) => w.address));

  const records = buildRecords({
    tally,
    lpMasters,
    knownAddrs: known,
    minPositions: MIN_POSITIONS,
    cap: CAP,
  });

  // ── report ─────────────────────────────────────────────────────────────────
  const nMaster = records.filter((r) => r._provenance.trust_tier === "lp_master").length;
  const nRecur = records.filter((r) => r._provenance.trust_tier === "recurring").length;
  log(`built ${records.length} NEW wallet record(s) after dedupe vs ${known.size} existing:`);
  log(`  lp_master (PnL-verified): ${nMaster}   recurring (proxy, no PnL): ${nRecur}`);
  for (const r of records.slice(0, 40)) {
    const pv = r._provenance;
    const ev =
      pv.trust_tier === "lp_master"
        ? `winrate=${(pv.win_rate * 100).toFixed(0)}% roi=${(pv.roi * 100).toFixed(1)}% pnl=$${pv.total_pnl_usd}`
        : `pools=${pv.onchain_pools_seen_in} pos=${pv.onchain_positions}`;
    log(`  ${pv.trust_tier.padEnd(10)} ${r.address} ${ev}`);
  }

  if (DRY) {
    log("--dry set: NOT writing smart-wallets.json. Done.");
    return;
  }
  if (records.length === 0) {
    log("Nothing new to add (all verified candidates already tracked). smart-wallets.json unchanged.");
    return;
  }

  existing.wallets.push(...records);
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(existing, null, 2));
  log(`wrote ${records.length} new wallet(s) → ${WALLETS_PATH} (total now ${existing.wallets.length})`);
  if (degraded) log("NOTE: ran in DEGRADED fallback mode (getTopCandidates gate unavailable). Pools came from public discovery / pool-memory, not the live Cassiopeia gate.");
}

// Only run when invoked directly (not when imported by tests).
const INVOKED_DIRECTLY = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    console.error("[lp-master-miner] FATAL:", e.message);
    process.exit(1);
  });
}
