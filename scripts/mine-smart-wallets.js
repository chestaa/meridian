#!/usr/bin/env node
/**
 * mine-smart-wallets.js — Sirius 🐺 (Signal Collector)
 *
 * Mines REAL, on-chain-verified Solana wallet addresses that are active LPs in
 * Meteora DLMM pools — biased toward pools that are performing well (high fee /
 * TVL ratio + decent volume). NO fabrication: every address comes straight from
 * a `getProgramAccounts` scan of the Meteora DLMM program.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *  1. Discover candidate pools:
 *       a) Meteora pool-discovery API (public, ranked by fee/tvl) — primary.
 *       b) pool-memory.json deploys with positive PnL history — secondary.
 *  2. For each pool, getProgramAccounts(DLMM_PROGRAM) filtered by the POOL
 *     address at byte offset 8 (where dlmm.js reads pool from position data).
 *     Each returned position account's owner lives at offset 40 (same offset
 *     getWalletPositions() filters on). We READ that owner → that's a real LP.
 *  3. Rank wallets: appears in more good pools = higher confidence. Cap top 30.
 *  4. Write to smart-wallets.json in the exact addSmartWallet() schema:
 *       { name, address, category:"alpha", type:"lp", addedAt }
 *
 * ── MUST RUN ON VPS ─────────────────────────────────────────────────────────
 *  Requires a real RPC (HELIUS_API_KEY / RPC_URL in VPS .env). getProgramAccounts
 *  with memcmp against the DLMM program is heavy and will 403/timeout on the
 *  blocked local env. Run: `node scripts/mine-smart-wallets.js`
 *
 *  Flags:
 *    --dry         : do everything but DON'T write smart-wallets.json (print only)
 *    --pools=N     : how many discovery pools to scan (default 20)
 *    --cap=N       : max wallets to write (default 30)
 *    --min-positions=N : ignore wallets seen fewer than N times total (default 1)
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

// Position account layout (matches tools/dlmm.js):
//   bytes  8..40  -> pool (lbPair) pubkey
//   bytes 40..72  -> owner pubkey
const OFFSET_POOL = 8;
const OFFSET_OWNER = 40;

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const numArg = (flag, def) => {
  const a = args.find((x) => x.startsWith(`${flag}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) ? n : def;
};
const POOL_COUNT = numArg("--pools", 20);
const CAP = numArg("--cap", 30);
const MIN_POSITIONS = numArg("--min-positions", 1);

const log = (...m) => console.log("[mine-wallets]", ...m);

function getConnection() {
  const rpc = process.env.RPC_URL;
  if (!rpc) {
    throw new Error("RPC_URL missing. This script MUST run on the VPS where .env has RPC_URL / HELIUS_API_KEY.");
  }
  return new Connection(rpc, "confirmed");
}

// ── Step 1a: discover good pools from Meteora pool-discovery API ────────────
async function discoverGoodPools(pageSize) {
  // Public endpoint, no auth. Rank by fee/active-tvl ratio (real performance).
  const filters = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "tvl>=10000",
    "volume>=2000",
    "fee_active_tvl_ratio>=0.05",
  ].join("&&");

  const url =
    `${POOL_DISCOVERY_BASE}/pools?page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=24h&category=trending`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      log(`pool-discovery API ${res.status} ${res.statusText} — falling back to pool-memory only`);
      return [];
    }
    const data = await res.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows
      .map((p) => ({
        pool: p.pool_address,
        name: p.name || p.base?.symbol || "pool",
        source: "meteora-discovery",
      }))
      .filter((p) => p.pool && SOLANA_PUBKEY_RE.test(p.pool));
  } catch (e) {
    log(`pool-discovery fetch failed: ${e.message} — falling back to pool-memory only`);
    return [];
  }
}

// ── Step 1b: good pools from our own pool-memory.json (positive PnL) ────────
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
    if (!SOLANA_PUBKEY_RE.test(poolAddr)) continue; // skips TEST placeholder rows
    const deploys = Array.isArray(info.deploys) ? info.deploys : [];
    const totalPnl = deploys.reduce((s, d) => s + (Number(d.pnl_pct) || 0), 0);
    if (totalPnl > 0) {
      out.push({ pool: poolAddr, name: info.name || "mem-pool", source: "pool-memory" });
    }
  }
  return out;
}

// ── Step 2: who is LP in this pool? on-chain getProgramAccounts scan ────────
async function getLpOwnersForPool(conn, poolAddress) {
  const accounts = await conn.getProgramAccounts(DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: OFFSET_POOL, bytes: poolAddress } }],
    // dataSlice keeps the response small: we only need the owner field.
    dataSlice: { offset: OFFSET_OWNER, length: 32 },
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

// ── load existing wallets for dedupe ────────────────────────────────────────
function loadExisting() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
  }
}

function shortAddr(a) {
  return `${a.slice(0, 4)}-${a.slice(-4)}`;
}

async function main() {
  log(`start — pools=${POOL_COUNT} cap=${CAP} minPositions=${MIN_POSITIONS} dry=${DRY}`);

  const conn = getConnection();

  // gather candidate pools (discovery + our memory)
  const discovery = await discoverGoodPools(POOL_COUNT);
  const memory = goodPoolsFromMemory();
  const poolMap = new Map();
  for (const p of [...discovery, ...memory]) {
    if (!poolMap.has(p.pool)) poolMap.set(p.pool, p);
  }
  const pools = [...poolMap.values()].slice(0, POOL_COUNT);

  if (pools.length === 0) {
    log("NO candidate pools found (discovery API empty + no positive pool-memory). Nothing to mine. Reporting honestly — no wallets written.");
    return;
  }
  log(`scanning ${pools.length} pool(s): ${pools.map((p) => p.name).join(", ")}`);

  // wallet -> { count, pools:Set, label }
  const tally = new Map();

  for (const p of pools) {
    let owners = [];
    try {
      owners = await getLpOwnersForPool(conn, p.pool);
    } catch (e) {
      log(`  ! pool ${p.name} (${shortAddr(p.pool)}) scan failed: ${e.message}`);
      continue;
    }
    log(`  ${p.name} (${shortAddr(p.pool)}) → ${owners.length} unique LP owners`);
    for (const owner of owners) {
      if (!tally.has(owner)) {
        tally.set(owner, { count: 0, pools: new Set(), firstPool: p });
      }
      const t = tally.get(owner);
      t.count += 1;
      t.pools.add(p.pool);
    }
  }

  if (tally.size === 0) {
    log("Scanned pools but found ZERO LP owners on-chain. Likely RPC blocked getProgramAccounts or empty pools. Reporting honestly — no wallets written.");
    return;
  }

  // rank: more distinct good pools first, then total positions
  const ranked = [...tally.entries()]
    .map(([address, t]) => ({
      address,
      poolCount: t.pools.size,
      positionCount: t.count,
      firstPool: t.firstPool,
    }))
    .filter((w) => w.positionCount >= MIN_POSITIONS)
    .sort((a, b) => b.poolCount - a.poolCount || b.positionCount - a.positionCount);

  log(`found ${ranked.length} distinct on-chain LP wallets (>= ${MIN_POSITIONS} positions)`);

  // dedupe against existing + build records
  const existing = loadExisting();
  const known = new Set(existing.wallets.map((w) => w.address));

  const fresh = ranked.filter((w) => !known.has(w.address)).slice(0, CAP);

  const records = fresh.map((w) => ({
    name: `minedLP-${w.firstPool.name}-${shortAddr(w.address)}`.slice(0, 64),
    address: w.address,
    category: "alpha",
    type: "lp",
    addedAt: new Date().toISOString(),
    // provenance metadata (non-breaking extra fields; addSmartWallet ignores them)
    _provenance: {
      pools_seen_in: w.poolCount,
      total_positions: w.positionCount,
      confidence: w.poolCount >= 2 ? "high" : "medium",
      mined_by: "sirius",
      method: "getProgramAccounts(DLMM) owner@offset40",
    },
  }));

  log(`top ${records.length} new wallets to write (after dedupe vs ${known.size} existing):`);
  for (const r of records) {
    log(`  ${r._provenance.confidence.padEnd(6)} pools=${r._provenance.pools_seen_in} pos=${r._provenance.total_positions} ${r.address} (${r.name})`);
  }

  if (DRY) {
    log("--dry set: NOT writing smart-wallets.json. Done.");
    return;
  }

  if (records.length === 0) {
    log("Nothing new to add (all candidates already tracked). smart-wallets.json unchanged.");
    return;
  }

  existing.wallets.push(...records);
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(existing, null, 2));
  log(`wrote ${records.length} new wallets → ${WALLETS_PATH} (total now ${existing.wallets.length})`);
}

main().catch((e) => {
  console.error("[mine-wallets] FATAL:", e.message);
  process.exit(1);
});
