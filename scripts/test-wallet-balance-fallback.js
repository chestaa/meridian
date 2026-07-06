/**
 * Vega P1 self-check — getWalletBalances() Helius retry + RPC fallback.
 *
 * Proves:
 *   1. Helius 502 (exhausted) → RPC getBalance fallback returns real SOL,
 *      error:false, degraded:true (deploy gate can proceed).
 *   2. Helius 502 once then 200 → retry recovers, full Helius shape (tokens).
 *   3. Helius 502 (exhausted) AND RPC fails → walletReadFailure (error:true,
 *      sol:null) — fail-closed, NEVER a fabricated/sentinel balance.
 *
 * Run: node scripts/test-wallet-balance-fallback.js
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// ── Env setup BEFORE importing wallet.js (module binds at import) ──────────
const kp = Keypair.generate();
process.env.BURNER_WALLET_KEY = bs58.encode(kp.secretKey);
process.env.DRY_RUN = "true";
process.env.HELIUS_API_KEY = "test-helius-key";
process.env.RPC_URL = "https://rpc.test.local/";
const WALLET = kp.publicKey.toString();

const { getWalletBalances } = await import("../tools/wallet.js");

// ── Mock fetch harness ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
function makeRes({ ok, status, json, text }) {
  return {
    ok,
    status,
    statusText: `status ${status}`,
    json: async () => json,
    text: async () => text ?? "",
  };
}
const isHelius = (u) => String(u).includes("api.helius.xyz");
const isRpc = (u) => String(u).startsWith(process.env.RPC_URL);

let assertions = 0;
let failures = 0;
function assert(cond, msg) {
  assertions++;
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ── Scenario 1: Helius always 502 → RPC fallback returns SOL ────────────────
console.log("\n[1] Helius 502 exhausted → RPC getBalance fallback");
{
  let heliusCalls = 0;
  let rpcCalls = 0;
  globalThis.fetch = async (url) => {
    if (isHelius(url)) { heliusCalls++; return makeRes({ ok: false, status: 502 }); }
    if (isRpc(url)) { rpcCalls++; return makeRes({ ok: true, status: 200, json: { result: { value: 850_000_000 } } }); }
    throw new Error(`unexpected url: ${url}`);
  };
  const r = await getWalletBalances();
  assert(heliusCalls === 3, `Helius retried to exhaustion (3 attempts, got ${heliusCalls})`);
  assert(rpcCalls === 1, `RPC fallback called once (got ${rpcCalls})`);
  assert(r.error === false, "fallback result error === false (deploy gate proceeds)");
  assert(r.degraded === true && r.source === "rpc_fallback", "marked degraded/rpc_fallback");
  assert(r.sol === 0.85, `SOL from RPC = 0.85 (got ${r.sol})`);
  assert(r.sol_usd === null && r.sol_price === null && r.total_usd === null, "USD fields null (never fabricated)");
  assert(Array.isArray(r.tokens) && r.tokens.length === 0, "tokens [] (auto-swap fail-closed)");
}

// ── Scenario 2: Helius 502 once then 200 → retry recovers full shape ────────
console.log("\n[2] Helius 502 then 200 → retry recovers Helius data");
{
  let heliusCalls = 0;
  let rpcCalls = 0;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  globalThis.fetch = async (url) => {
    if (isHelius(url)) {
      heliusCalls++;
      if (heliusCalls === 1) return makeRes({ ok: false, status: 502 });
      return makeRes({ ok: true, status: 200, json: {
        balances: [{ mint: SOL_MINT, symbol: "SOL", balance: 1.5, pricePerToken: 150, usdValue: 225 }],
        totalUsdValue: 225,
      }});
    }
    if (isRpc(url)) { rpcCalls++; return makeRes({ ok: true, status: 200, json: { result: { value: 1 } } }); }
    throw new Error(`unexpected url: ${url}`);
  };
  const r = await getWalletBalances();
  assert(heliusCalls === 2, `Helius retried once and recovered (2 calls, got ${heliusCalls})`);
  assert(rpcCalls === 0, `RPC fallback NOT used when Helius recovers (got ${rpcCalls})`);
  assert(!r.degraded, "not degraded (full Helius path)");
  assert(r.sol === 1.5, `SOL from Helius = 1.5 (got ${r.sol})`);
  assert(r.sol_usd === 225, `USD present from Helius (got ${r.sol_usd})`);
}

// ── Scenario 3: Helius exhausted AND RPC fails → fail-closed ────────────────
console.log("\n[3] Helius 502 exhausted AND RPC fails → walletReadFailure (fail-closed)");
{
  let heliusCalls = 0;
  let rpcCalls = 0;
  globalThis.fetch = async (url) => {
    if (isHelius(url)) { heliusCalls++; return makeRes({ ok: false, status: 502 }); }
    if (isRpc(url)) { rpcCalls++; return makeRes({ ok: false, status: 500 }); }
    throw new Error(`unexpected url: ${url}`);
  };
  const r = await getWalletBalances();
  assert(heliusCalls === 3, `Helius retried to exhaustion (got ${heliusCalls})`);
  assert(rpcCalls === 1, `RPC fallback attempted (got ${rpcCalls})`);
  assert(r.error === true, "error === true (unreadable → deploy gate SKIPS)");
  assert(r.sol === null, "sol === null (NEVER a fabricated/sentinel 0)");
  assert(r.degraded === undefined, "not marked degraded (this is a true read failure)");
}

// ── Scenario 3b: RPC throws (network reject) → still fail-closed ────────────
console.log("\n[3b] RPC fallback throws → still fail-closed (no fabrication)");
{
  globalThis.fetch = async (url) => {
    if (isHelius(url)) return makeRes({ ok: false, status: 503 });
    throw new Error("RPC network down");
  };
  const r = await getWalletBalances();
  assert(r.error === true && r.sol === null, "both-down → error:true, sol:null");
}

globalThis.fetch = realFetch;

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES PRESENT"}: ${assertions - failures}/${assertions} assertions`);
process.exit(failures === 0 ? 0 : 1);
