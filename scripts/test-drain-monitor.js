/**
 * Vega money-path test — burner balance-drain false-alarm fix.
 *
 * Root cause being guarded:
 *   - tools/wallet.js getWalletBalances() used to return sentinel `sol: 0` on
 *     EVERY Helius failure (non-200 / timeout / empty array). The drain monitor
 *     guard `solNow >= 0` let 0 through → (prev - 0)/prev = 100% → phantom
 *     "BURNER BALANCE DRAIN" alert while the wallet was actually intact.
 *
 * Asserts:
 *   (a) Helius failure → getWalletBalances returns sol:null + error:true (NOT 0)
 *   (b) failed read → monitor SKIPs (no compute, no store, no alert)
 *   (c) single blip-0/low read confirmed by an intact second read → NO alert
 *   (d) real drain across TWO consecutive reads → alert FIRES
 *   (e) deploy-gate fails CLOSED when balance is null/unknown
 *   (f) genuine modest drop (in threshold band) fires directly, stores baseline
 *   (g) a 0-read can never compute a 100% drop into a direct alert (>0 guard)
 */
import assert from "node:assert";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// ─── Setup: stub env so imports don't reach real RPC/Helius ──────────────
// A throwaway burner keypair lets getSigningWallet() succeed, so fetch stubs
// (not "Wallet not configured") drive getWalletBalances outcomes. This key is
// generated fresh per run, never funded, never logged.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
process.env.DRY_RUN = "false";
process.env.RPC_URL = process.env.RPC_URL || "https://rpc.invalid";
process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY || "test-key";
process.env.BURNER_WALLET_KEY = bs58.encode(Keypair.generate().secretKey);

const wallet = await import("../tools/wallet.js");
const idx = await import("../index.js");
const exec = await import("../tools/executor.js");
const circuit = await import("../account-circuit-breaker.js");

// ─── (a) Helius failure → sol:null + error:true, NOT sentinel 0 ──────────
{
  const realFetch = globalThis.fetch;

  // Non-200
  globalThis.fetch = async () => ({ ok: false, status: 429, statusText: "Too Many Requests" });
  let r = await wallet.getWalletBalances();
  ok("(a1) non-200 → sol is null (not 0)", r.sol === null);
  ok("(a2) non-200 → error:true", r.error === true);
  ok("(a3) non-200 → tokens still [] (callers don't crash)", Array.isArray(r.tokens) && r.tokens.length === 0);

  // 200 but missing balances array (malformed)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ foo: "bar" }) });
  r = await wallet.getWalletBalances();
  ok("(a4) malformed 200 (no balances) → sol null", r.sol === null && r.error === true);

  // network throw
  globalThis.fetch = async () => { throw new Error("ETIMEDOUT"); };
  r = await wallet.getWalletBalances();
  ok("(a5) thrown fetch → sol null", r.sol === null && r.error === true);

  // genuine empty wallet (200, balances:[]) → real sol 0, NOT error
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balances: [], totalUsdValue: 0 }) });
  r = await wallet.getWalletBalances();
  ok("(a6) genuine empty wallet → sol === 0 and NOT error", r.sol === 0 && !r.error);

  // genuine funded wallet
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    balances: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL", balance: 0.856, pricePerToken: 150, usdValue: 128.4 }],
    totalUsdValue: 128.4,
  }) });
  r = await wallet.getWalletBalances();
  ok("(a7) funded wallet → sol 0.856, no error", Math.abs(r.sol - 0.856) < 1e-9 && !r.error);

  globalThis.fetch = realFetch;
}

// ─── pure decision core ──────────────────────────────────────────────────
{
  const now = 1_000_000;
  const within = { sol: 0.856, at: now - 1000 };

  // (b) read failed → skip, never store
  let d = idx.decideBalanceDrainAction(within, { sol: null, error: true }, now);
  ok("(b1) error read → action skip", d.action === "skip");
  d = idx.decideBalanceDrainAction(within, { sol: null }, now);
  ok("(b2) null sol → action skip", d.action === "skip");
  d = idx.decideBalanceDrainAction(within, { sol: NaN }, now);
  ok("(b3) NaN sol → action skip", d.action === "skip");

  // no prev → store
  d = idx.decideBalanceDrainAction(null, { sol: 0.856 }, now);
  ok("(b4) no baseline → store", d.action === "store");

  // stale prev (outside window) → store, no alert
  d = idx.decideBalanceDrainAction({ sol: 0.856, at: now - 5 * 60 * 60 * 1000 }, { sol: 0.01 }, now);
  ok("(b5) stale baseline → store (no alert)", d.action === "store");

  // modest drop in threshold band → alert directly
  d = idx.decideBalanceDrainAction({ sol: 1.0, at: now - 1000 }, { sol: 0.6 }, now); // 40% drop
  ok("(f1) 40% drop → action alert", d.action === "alert" && Math.abs(d.dropPct - 40) < 1e-6);

  // small drop below threshold → store
  d = idx.decideBalanceDrainAction({ sol: 1.0, at: now - 1000 }, { sol: 0.95 }, now); // 5%
  ok("(f2) 5% drop → store (below threshold)", d.action === "store");

  // catastrophic drop → confirm (needs second read)
  d = idx.decideBalanceDrainAction({ sol: 0.856, at: now - 1000 }, { sol: 0.0001 }, now); // ~99.99%
  ok("(g1) ~100% drop → action confirm (NOT direct alert)", d.action === "confirm");
}

// ─── orchestrator with injected second-read ───────────────────────────────
function makeDeps() {
  const alerts = [];
  let stored = null;
  return {
    alerts,
    getStored: () => stored,
    deps: {
      now: 1_000_000,
      fireAlert: (prevSol, solNow, dropPct) => { alerts.push({ prevSol, solNow, dropPct }); },
      store: (s) => { stored = s; },
    },
  };
}

// (b/skip) failed read does not store and does not alert
{
  idx.__setLastBalanceSampleForTest({ sol: 0.856, at: 1_000_000 - 1000 });
  const h = makeDeps();
  const res = await idx.runBalanceDrainMonitor({ sol: null, error: true }, h.deps);
  ok("(b6) failed read → no alert", h.alerts.length === 0);
  ok("(b7) failed read → not stored as baseline", h.getStored() === null);
  ok("(b8) failed read → resolved skip", res.action === "skip");
}

// (c) single blip-0 then second-read intact → NO alert (phantom suppressed)
{
  idx.__setLastBalanceSampleForTest({ sol: 0.856, at: 1_000_000 - 1000 });
  const h = makeDeps();
  // first read shows 0 (blip), second read shows wallet intact
  h.deps.secondRead = async () => ({ sol: 0.856, error: false });
  const res = await idx.runBalanceDrainMonitor({ sol: 0.0, error: false }, h.deps);
  ok("(c1) blip-0 + intact second read → NO alert", h.alerts.length === 0);
  ok("(c2) blip-0 case → resolved skip (not_confirmed)", res.action === "skip");
  ok("(c3) blip-0 case → baseline updated to GOOD reading", h.getStored() && Math.abs(h.getStored().sol - 0.856) < 1e-9);
}

// (c-variant) catastrophic drop but second-read itself fails → treat as blip, no alert
{
  idx.__setLastBalanceSampleForTest({ sol: 0.856, at: 1_000_000 - 1000 });
  const h = makeDeps();
  h.deps.secondRead = async () => ({ sol: null, error: true });
  const res = await idx.runBalanceDrainMonitor({ sol: 0.0001, error: false }, h.deps);
  ok("(c4) catastrophic + failed second read → NO alert", h.alerts.length === 0 && res.action === "skip");
}

// (d) real drain across TWO consecutive reads → alert FIRES
{
  idx.__setLastBalanceSampleForTest({ sol: 0.856, at: 1_000_000 - 1000 });
  const h = makeDeps();
  // both reads agree the wallet really collapsed (e.g. drained to ~0.001)
  h.deps.secondRead = async () => ({ sol: 0.001, error: false });
  const res = await idx.runBalanceDrainMonitor({ sol: 0.001, error: false }, h.deps);
  ok("(d1) confirmed real drain → alert FIRES", h.alerts.length === 1);
  ok("(d2) confirmed drain → resolved alert (confirmed)", res.action === "alert" && res.confirmed === true);
  ok("(d3) confirmed drain → baseline updated to collapsed value", h.getStored() && h.getStored().sol === 0.001);
}

// (f) modest in-band drop fires directly (no second read needed), stores baseline
{
  idx.__setLastBalanceSampleForTest({ sol: 1.0, at: 1_000_000 - 1000 });
  const h = makeDeps();
  h.deps.secondRead = async () => { throw new Error("second read should NOT be called for in-band drop"); };
  const res = await idx.runBalanceDrainMonitor({ sol: 0.6, error: false }, h.deps); // 40%
  ok("(f3) 40% in-band drop → alert fires directly", h.alerts.length === 1 && res.action === "alert");
  ok("(f4) 40% drop → baseline stored", h.getStored() && h.getStored().sol === 0.6);
}

// reset module baseline so we don't leak state
idx.__setLastBalanceSampleForTest(null);

// ─── (e) deploy-gate fails CLOSED on null/unknown balance ──────────────────
// Two independent fail-closed layers must each refuse on an unknown balance:
//   (e1) circuit breaker — null balance on day-rollover → state unreadable → halt
//   (e3) SOL-coverage gate — even if the circuit passes, null sol must refuse
{
  const realFetch = globalThis.fetch;
  // Make getWalletBalances fail → sol:null
  globalThis.fetch = async () => ({ ok: false, status: 503, statusText: "Service Unavailable" });

  const args = {
    pool_address: "PoolXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    amount_y: 0.2,
    bins_below: 40,
    bins_above: 0,
    bin_step: 100,
    volatility: 2,
    strategy: "spot",
  };

  const refused = (r) =>
    r && (r.blocked === true || r.success === false || r.pass === false || !!r.error);
  const noOnChain = (r) => !r?.tx && !r?.position && !r?.txs && !r?.signature;

  // (e1) — with ALL reads failing (Helius + Pool Discovery + circuit self-fetch),
  // the deploy must be refused fail-closed at the FIRST gate it hits, and never
  // touch chain. (Gate ordering: screening-threshold verify fires first here; the
  // point is the layered fail-closed posture — unreadable inputs never deploy.)
  circuit.__setWalletFetchForTest(async () => ({ sol: null, error: true }));
  let result = await exec.executeTool("deploy_position", args);
  let reason = (result?.reason || result?.error || "").toLowerCase();
  ok("(e1) deploy refused — fail-closed when all reads unavailable",
    refused(result) && (reason.includes("circuit") || reason.includes("unread") ||
      reason.includes("balance") || reason.includes("verify") || reason.includes("threshold")));
  ok("(e2) deploy did NOT proceed to on-chain (no tx/position)", noOnChain(result));

  circuit.__setWalletFetchForTest(null);
  globalThis.fetch = realFetch;
}

// ─── (e3-e7) DIRECT unit test of the SOL-coverage gate (the code this fix changed)
// solCoverageRejectReason is the pure decision used by runSafetyChecks. Proves the
// fail-closed behavior in isolation, independent of gate ordering.
{
  // null balance read → refuse (the core fix; old code would FAIL OPEN here)
  ok("(e3) null-sol balance → coverage gate REFUSES (fail-closed)",
    typeof exec.solCoverageRejectReason({ sol: null, error: true }, 0.2, 0.2) === "string");
  // error:true even with a numeric sol → refuse
  ok("(e4) error:true read → coverage gate REFUSES",
    typeof exec.solCoverageRejectReason({ sol: 0.5, error: true }, 0.2, 0.2) === "string");
  // genuine insufficient funds → refuse
  ok("(e5) genuinely insufficient SOL → REFUSES",
    typeof exec.solCoverageRejectReason({ sol: 0.1 }, 0.2, 0.2) === "string");
  // sufficient funds, clean read → ALLOW (null reject reason)
  ok("(e6) sufficient SOL, clean read → ALLOWS (null reason)",
    exec.solCoverageRejectReason({ sol: 0.856 }, 0.2, 0.2) === null);
  // sentinel-0 read with error flag must NOT be treated as "0 funds < required"
  // ambiguously — it's a read failure → refuse with the read-failed message.
  ok("(e7) sol:0 WITH error:true → refused as read-failure (not 'insufficient')",
    /read failed\/unknown/i.test(exec.solCoverageRejectReason({ sol: 0, error: true }, 0.2, 0.2) || ""));
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (fail > 0) { process.exit(1); }
