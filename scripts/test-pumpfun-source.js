/**
 * test-pumpfun-source.js — Phase B source unit tests (Sirius).
 *
 * Covers:
 *  1. Normalization shape correctness (Meteora-raw shape + signal_source tag +
 *     pumpfun_graduated_at stamp)
 *  2. Graceful [] on pump.fun fetch error (never throws)
 *  3. Graceful [] on pump.fun non-OK HTTP (rate-limit / 530)
 *  4. Skip graduated coins with NO Meteora DLMM pool (can't deploy)
 *  5. Dedup by pool_address
 *  6. Age-window filter — coins graduated older than the window are dropped
 *
 * No network: globalThis.fetch is stubbed per-case. No npm deps.
 */
import assert from "node:assert";
import {
  fetchPumpfunGraduated,
  __resetPumpfunCache,
} from "../tools/sources/pumpfun-graduated.js";

const realFetch = globalThis.fetch;
let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS — ${label}`);
}

const PUMPFUN_HOST = "frontend-api-v3.pump.fun";
const METEORA_HOST = "dlmm.datapi.meteora.ag";
const HOUR = 3_600_000;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: () => Promise.resolve(body),
  });
}

// Build a fake fetch router. `meteoraByMint` maps mint → Meteora pool array.
function makeFetch({ coins, meteoraByMint = {}, pumpfunFail = false, pumpfunStatus = 200 }) {
  return (url) => {
    const u = String(url);
    if (u.includes(PUMPFUN_HOST)) {
      if (pumpfunFail) return Promise.reject(new Error("network down"));
      if (pumpfunStatus !== 200) return jsonResponse({}, { ok: false, status: pumpfunStatus });
      return jsonResponse(coins); // v3 returns a bare array
    }
    if (u.includes(METEORA_HOST)) {
      const m = u.match(/query=([^&]+)/);
      const mint = m ? decodeURIComponent(m[1]) : null;
      const pools = meteoraByMint[mint] || [];
      return jsonResponse({ data: pools });
    }
    return jsonResponse({}, { ok: false, status: 404 });
  };
}

function pumpCoin(mint, { ageHours = 1, overrides = {} } = {}) {
  return {
    mint,
    symbol: "TKN",
    name: `${mint} coin`,
    complete: true,
    raydium_pool: `ray_${mint}`,
    creator: "Creator111",
    usd_market_cap: 450_000,
    created_timestamp: Date.now() - ageHours * HOUR,
    ...overrides,
  };
}

function meteoraPool(mint, overrides = {}) {
  return {
    pool_address: `pool_${mint}`,
    name: `${mint}-SOL`,
    pool_type: "dlmm",
    tvl: 50_000,
    active_tvl: 30_000,
    volume: 12_000,
    fee: 200,
    fee_pct: 0.4,
    fee_active_tvl_ratio: 0.08,
    volatility: 2.5,
    base_token_holders: 1200,
    dlmm_params: { bin_step: 100 },
    token_x: {
      symbol: "TKN",
      address: mint,
      organic_score: 72,
      market_cap: 400_000,
      created_at: Date.now() - 5 * HOUR,
      dev: "Dev111",
    },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 100 },
    ...overrides,
  };
}

async function run() {
  console.log("test-pumpfun-source");

  // ── Case 1: normalization shape + graduation stamp ──
  __resetPumpfunCache();
  globalThis.fetch = makeFetch({
    coins: [pumpCoin("MintAAA", { ageHours: 2 })],
    meteoraByMint: { MintAAA: [meteoraPool("MintAAA")] },
  });
  let pools = await fetchPumpfunGraduated();
  assert.strictEqual(pools.length, 1, "expected 1 normalized pool");
  const p = pools[0];
  assert.strictEqual(p.pool_address, "pool_MintAAA", "pool_address mapped");
  assert.strictEqual(p.signal_source, "pumpfun", "tagged signal_source=pumpfun");
  assert.strictEqual(p.pool_type, "dlmm", "pool_type dlmm");
  assert.strictEqual(p.dlmm_params.bin_step, 100, "bin_step nested");
  assert.strictEqual(p.base_token_holders, 1200, "holders mapped");
  assert.strictEqual(p.token_x.address, "MintAAA", "base mint in token_x");
  assert.strictEqual(p.base_mint, "MintAAA", "flat base_mint alias");
  assert.strictEqual(p.token_x.launchpad, "pumpfun", "launchpad defaults pumpfun");
  assert.ok(Number.isFinite(p.pumpfun_graduated_at), "pumpfun_graduated_at stamped");
  assert.ok(Number.isFinite(p.pumpfun_graduation_age_hours), "graduation age computed");
  assert.ok(Number.isFinite(p.token_x.market_cap), "market_cap numeric");
  assert.ok(Number.isFinite(p.token_age_hours), "token_age_hours computed");
  assert.strictEqual(p.fee_active_tvl_ratio, 0.08, "fee_active_tvl_ratio mapped");
  assert.strictEqual(p.volatility, 2.5, "volatility mapped");
  ok("normalization produces Meteora-raw shape + signal_source + grad stamp");

  // ── Case 2: graceful [] on fetch reject ──
  __resetPumpfunCache();
  globalThis.fetch = makeFetch({ coins: [], pumpfunFail: true });
  pools = await fetchPumpfunGraduated();
  assert.deepStrictEqual(pools, [], "fetch reject → []");
  ok("graceful [] on pump.fun network error (no throw)");

  // ── Case 3: graceful [] on non-OK HTTP (e.g. 530 / 429) ──
  __resetPumpfunCache();
  globalThis.fetch = makeFetch({ coins: [], pumpfunStatus: 530 });
  pools = await fetchPumpfunGraduated();
  assert.deepStrictEqual(pools, [], "HTTP 530 → []");
  ok("graceful [] on pump.fun 530/429 (origin down / rate-limit)");

  // ── Case 4: skip coin with no DLMM pool ──
  __resetPumpfunCache();
  globalThis.fetch = makeFetch({
    coins: [
      pumpCoin("MintHAS", { ageHours: 1 }),
      pumpCoin("MintNONE", { ageHours: 1 }),
    ],
    meteoraByMint: { MintHAS: [meteoraPool("MintHAS")] }, // MintNONE absent
  });
  pools = await fetchPumpfunGraduated();
  assert.strictEqual(pools.length, 1, "only DLMM-backed coin returned");
  assert.strictEqual(pools[0].base_mint, "MintHAS", "kept the one with a pool");
  ok("skips graduated coins without a Meteora DLMM pool");

  // ── Case 5: dedup by pool_address ──
  __resetPumpfunCache();
  const shared = meteoraPool("MintDUP", { pool_address: "pool_SHARED", name: "SHARED-SOL" });
  globalThis.fetch = makeFetch({
    coins: [
      pumpCoin("MintDUP", { ageHours: 1 }),
      pumpCoin("MintDUP2", { ageHours: 1 }),
    ],
    meteoraByMint: {
      MintDUP: [shared],
      MintDUP2: [{ ...shared }], // same pool_address
    },
  });
  pools = await fetchPumpfunGraduated();
  assert.strictEqual(pools.length, 1, "duplicate pool_address collapsed");
  assert.strictEqual(pools[0].pool_address, "pool_SHARED", "kept shared pool");
  ok("dedup collapses duplicate pool_address");

  // ── Case 6: age-window filter (default 48h) ──
  __resetPumpfunCache();
  globalThis.fetch = makeFetch({
    coins: [
      pumpCoin("MintFRESH", { ageHours: 10 }),   // inside 48h window
      pumpCoin("MintSTALE", { ageHours: 200 }),  // graduated 200h ago → drop
      pumpCoin("MintNOTS", { ageHours: 1, overrides: { created_timestamp: null, king_of_the_hill_timestamp: null, last_trade_timestamp: null } }), // no timestamp → drop
    ],
    meteoraByMint: {
      MintFRESH: [meteoraPool("MintFRESH")],
      MintSTALE: [meteoraPool("MintSTALE")],
      MintNOTS: [meteoraPool("MintNOTS")],
    },
  });
  pools = await fetchPumpfunGraduated();
  assert.strictEqual(pools.length, 1, "only fresh graduate within window kept");
  assert.strictEqual(pools[0].base_mint, "MintFRESH", "kept fresh graduate");
  ok("age-window filter drops stale + timestamp-less coins");

  console.log(`\nALL PASS — ${passed} assertion groups`);
}

run()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
  });
