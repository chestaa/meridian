/**
 * test-solscan-source.js — Phase D source unit tests (Sirial).
 *
 * Covers:
 *  1. Normalization shape correctness (Meteora-raw shape + signal_source tag)
 *  2. Graceful [] on Birdeye fetch error (never throws)
 *  3. Graceful [] on Birdeye non-OK HTTP
 *  4. Skip tokens with NO Meteora DLMM pool (can't deploy)
 *  5. Dedup by pool_address
 *
 * No network: globalThis.fetch is stubbed per-case. No npm deps.
 */
import assert from "node:assert";
import {
  fetchSolscanTrending,
  __resetSolscanCache,
} from "../tools/sources/solscan-trending.js";

const realFetch = globalThis.fetch;
const realKey = process.env.BIRDEYE_API_KEY;
const TEST_KEY = "test-birdeye-key";
let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS — ${label}`);
}

const BIRDEYE_HOST = "public-api.birdeye.so";
const METEORA_HOST = "dlmm.datapi.meteora.ag";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: () => Promise.resolve(body),
  });
}

// Build a fake fetch router. `meteoraByMint` maps mint → Meteora pool array.
function makeFetch({ trending, meteoraByMint = {}, birdeyeFail = false, birdeyeStatus = 200, capture }) {
  return (url, opts = {}) => {
    const u = String(url);
    if (u.includes(BIRDEYE_HOST)) {
      if (capture) capture.headers = opts.headers || null;
      if (birdeyeFail) return Promise.reject(new Error("network down"));
      if (birdeyeStatus !== 200) return jsonResponse({}, { ok: false, status: birdeyeStatus });
      return jsonResponse({ data: { tokens: trending } });
    }
    if (u.includes(METEORA_HOST)) {
      // query=<mint>
      const m = u.match(/query=([^&]+)/);
      const mint = m ? decodeURIComponent(m[1]) : null;
      const pools = meteoraByMint[mint] || [];
      return jsonResponse({ data: pools });
    }
    return jsonResponse({}, { ok: false, status: 404 });
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
      created_at: Date.now() - 100 * 3_600_000,
      dev: "Dev111",
    },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 100 },
    ...overrides,
  };
}

async function run() {
  console.log("test-solscan-source");

  // Every case below (except the explicit no-key case) requires the key env set,
  // since the source now skips the fetch entirely when BIRDEYE_API_KEY is absent.
  process.env.BIRDEYE_API_KEY = TEST_KEY;

  // ── Case 1: normalization shape + X-API-KEY header sent ──
  __resetSolscanCache();
  const cap = {};
  globalThis.fetch = makeFetch({
    trending: [{ address: "MintAAA", symbol: "AAA" }],
    meteoraByMint: { MintAAA: [meteoraPool("MintAAA")] },
    capture: cap,
  });
  let pools = await fetchSolscanTrending();
  assert.ok(cap.headers, "Birdeye request sent headers");
  assert.strictEqual(cap.headers["X-API-KEY"], TEST_KEY, "X-API-KEY header carries env key");
  assert.strictEqual(cap.headers["x-chain"], "solana", "x-chain header preserved");
  assert.strictEqual(cap.headers.accept, "application/json", "accept header preserved");
  assert.strictEqual(pools.length, 1, "expected 1 normalized pool");
  const p = pools[0];
  assert.strictEqual(p.pool_address, "pool_MintAAA", "pool_address mapped");
  assert.strictEqual(p.signal_source, "solscan", "tagged signal_source=solscan");
  assert.strictEqual(p.pool_type, "dlmm", "pool_type dlmm");
  assert.strictEqual(p.dlmm_params.bin_step, 100, "bin_step nested");
  assert.strictEqual(p.base_token_holders, 1200, "holders mapped");
  assert.strictEqual(p.token_x.address, "MintAAA", "base mint in token_x");
  assert.strictEqual(p.base_mint, "MintAAA", "flat base_mint alias");
  assert.ok(Number.isFinite(p.token_x.market_cap), "market_cap numeric");
  assert.ok(Number.isFinite(p.token_x.created_at), "created_at numeric");
  assert.ok(Number.isFinite(p.token_age_hours), "token_age_hours computed");
  assert.strictEqual(p.fee_active_tvl_ratio, 0.08, "fee_active_tvl_ratio mapped");
  assert.strictEqual(p.volatility, 2.5, "volatility mapped");
  ok("normalization produces Meteora-raw shape with signal_source tag");

  // ── Case 2: graceful [] on Birdeye fetch reject ──
  __resetSolscanCache();
  globalThis.fetch = makeFetch({ trending: [], birdeyeFail: true });
  pools = await fetchSolscanTrending();
  assert.deepStrictEqual(pools, [], "fetch reject → []");
  ok("graceful [] on Birdeye network error (no throw)");

  // ── Case 3: graceful [] on Birdeye non-OK HTTP (e.g. 429 rate-limit / 401 auth) ──
  __resetSolscanCache();
  globalThis.fetch = makeFetch({ trending: [], birdeyeStatus: 429 });
  pools = await fetchSolscanTrending();
  assert.deepStrictEqual(pools, [], "HTTP 429 → []");
  ok("graceful [] on Birdeye 429/401 (rate-limit / auth required)");

  // ── Case 4: skip token with no DLMM pool ──
  __resetSolscanCache();
  globalThis.fetch = makeFetch({
    trending: [
      { address: "MintHAS", symbol: "HAS" },
      { address: "MintNONE", symbol: "NONE" },
    ],
    meteoraByMint: { MintHAS: [meteoraPool("MintHAS")] }, // MintNONE absent
  });
  pools = await fetchSolscanTrending();
  assert.strictEqual(pools.length, 1, "only DLMM-backed token returned");
  assert.strictEqual(pools[0].base_mint, "MintHAS", "kept the one with a pool");
  ok("skips trending tokens without a Meteora DLMM pool");

  // ── Case 5: dedup by pool_address ──
  __resetSolscanCache();
  // Two distinct trending mints that resolve to the SAME Meteora pool_address.
  const shared = meteoraPool("MintDUP", { pool_address: "pool_SHARED", name: "SHARED-SOL" });
  globalThis.fetch = makeFetch({
    trending: [
      { address: "MintDUP", symbol: "DUP" },
      { address: "MintDUP2", symbol: "DUP2" },
    ],
    meteoraByMint: {
      MintDUP: [shared],
      MintDUP2: [{ ...shared }], // same pool_address
    },
  });
  pools = await fetchSolscanTrending();
  assert.strictEqual(pools.length, 1, "duplicate pool_address collapsed");
  assert.strictEqual(pools[0].pool_address, "pool_SHARED", "kept shared pool");
  ok("dedup collapses duplicate pool_address");

  // ── Case 6: graceful [] when BIRDEYE_API_KEY absent (no fetch, no empty key) ──
  __resetSolscanCache();
  delete process.env.BIRDEYE_API_KEY;
  const capNoKey = {};
  globalThis.fetch = makeFetch({
    trending: [{ address: "MintAAA", symbol: "AAA" }],
    meteoraByMint: { MintAAA: [meteoraPool("MintAAA")] },
    capture: capNoKey,
  });
  pools = await fetchSolscanTrending();
  assert.deepStrictEqual(pools, [], "no key → []");
  assert.strictEqual(capNoKey.headers, undefined, "Birdeye fetch skipped entirely (no request)");
  ok("graceful [] + no fetch when BIRDEYE_API_KEY absent");

  console.log(`\nALL PASS — ${passed} assertions groups`);
}

run()
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.BIRDEYE_API_KEY;
    else process.env.BIRDEYE_API_KEY = realKey;
  });
