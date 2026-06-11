/**
 * Cassiopeia — enrich-before-gate for the holder floor.
 *
 * Choke point (Draco 2026-06-11): 69 reject "holders 0 below minHolders 500"
 * was DOMINANT — signal pools (discord/solscan/pumpfun) arriving WITHOUT a
 * holder count died at the holder floor on DATA-MISSING (not a real low count),
 * before any other gate or the LLM judge ran. 4 dry deploy days.
 *
 * FIX (verified here): for pools with holders null/0 that clear every OTHER
 * cheap gate, fetch the REAL holder count once (cached), then let the floor
 * judge the real number. Floor stays 500. Enrich is NOT a bypass — a failed
 * fetch leaves holders null and the gate rejects "holders_unknown" (fail-closed,
 * anti-pattern #2).
 *
 * Asserts:
 *   - holders null + enrich→600  → PASS (gate sees real number)
 *   - holders null + enrich→300  → reject (floor genuinely fails)
 *   - holders null + enrich FAILS → reject "holders_unknown" (fail-closed)
 *   - holders already 700        → PASS, NO re-fetch
 *   - cheap-gate-fail pool        → NO fetch spent (Lyra cost-aware ordering)
 *   - same mint twice            → second is cached, NO second fetch
 */
import assert from "node:assert";
import {
  __enrichHolderCountsBeforeGateForTests,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  PASS  ${msg}`);
  pass++;
};

// Thresholds mirroring live floors. Holder floor stays 500 throughout.
const S = {
  minHolders: 500,
  minMcap: 150_000, maxMcap: 10_000_000,
  minVolume: 500, minTvl: 10_000, maxTvl: 150_000,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.06,
  minOrganic: 60, minQuoteOrganic: 0,
  minTokenAgeHours: null, maxTokenAgeHours: null,
  excludeHighSupplyConcentration: false,
  blockedLaunchpads: [], allowedLaunchpads: [],
};

// A signal pool that clears every gate EXCEPT it has no holder count yet.
function signalPool({ holders = null, mint = "MintAAA", name = "SIG-SOL" } = {}) {
  return {
    pool_address: `pool_${name}`,
    name,
    pool_type: "dlmm",
    discord_signal: true,
    tvl: 50_000,
    volume: 20_000,
    fee_active_tvl_ratio: 0.10,
    volatility: 3,
    base_token_holders: holders,
    dlmm_params: { bin_step: 100 },
    token_x: {
      symbol: name.split("-")[0],
      address: mint,
      organic_score: 75,
      market_cap: 1_000_000,
      created_at: Date.now() - 100 * 3_600_000,
    },
    token_y: { symbol: "SOL", address: "So111", organic_score: 0 },
    base_mint: mint,
  };
}

console.log("\n[1] holders null + enrich SUCCESS 600 → PASS (gate judges real number)");
{
  const p = signalPool({ holders: null, mint: "Mint600" });
  let calls = 0;
  await __enrichHolderCountsBeforeGateForTests([p], S, async ({ mint }) => {
    calls++;
    assert.strictEqual(mint, "Mint600", "fetched the pool's base mint");
    return 600;
  });
  ok(calls === 1, "enrich fetched exactly once for a survivor with no count");
  ok(p.base_token_holders === 600, "real count written onto pool");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate PASSES on real 600 (>= floor 500)");
}

console.log("\n[2] holders null + enrich SUCCESS 300 → reject (floor genuinely fails)");
{
  const p = signalPool({ holders: null, mint: "Mint300" });
  await __enrichHolderCountsBeforeGateForTests([p], S, async () => 300);
  ok(p.base_token_holders === 300, "real count 300 written");
  const r = getRawPoolScreeningRejectReason(p, S);
  ok(typeof r === "string" && r.includes("below minHolders 500"),
    `genuine sub-floor reject (got: ${r}) — floor 500 still enforced`);
}

console.log("\n[3] holders null + enrich FAILS → reject holders_unknown (FAIL-CLOSED)");
{
  const p = signalPool({ holders: null, mint: "MintFail" });
  await __enrichHolderCountsBeforeGateForTests([p], S, async () => {
    throw new Error("API down");
  });
  ok(p.base_token_holders == null, "failed enrich leaves holders null (no default to safe)");
  ok(getRawPoolScreeningRejectReason(p, S) === "holders_unknown",
    "fail-closed: enrich failure → holders_unknown reject, NOT a pass");
}

console.log("\n[3b] holders null + enrich returns null (no count in API) → holders_unknown");
{
  const p = signalPool({ holders: null, mint: "MintNullCount" });
  await __enrichHolderCountsBeforeGateForTests([p], S, async () => null);
  ok(getRawPoolScreeningRejectReason(p, S) === "holders_unknown",
    "null count (not just error) also fail-closed → holders_unknown");
}

console.log("\n[4] holders already 700 → PASS, NO re-fetch");
{
  const p = signalPool({ holders: 700, mint: "Mint700" });
  let calls = 0;
  await __enrichHolderCountsBeforeGateForTests([p], S, async () => { calls++; return 1; });
  ok(calls === 0, "pool with an existing real count is NOT re-fetched (cost-aware)");
  ok(p.base_token_holders === 700, "existing count untouched");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate passes on existing 700");
}

console.log("\n[5] Lyra cost ordering — pool failing a CHEAP gate gets NO fetch");
{
  // mcap below floor → would die on the (no-API) mcap gate. We must not spend a
  // holder fetch on it even though its holder count is missing.
  const cheapFail = signalPool({ holders: null, mint: "MintCheapFail" });
  cheapFail.token_x.market_cap = 1000; // below minMcap 150k
  let calls = 0;
  await __enrichHolderCountsBeforeGateForTests([cheapFail], S, async () => { calls++; return 600; });
  ok(calls === 0, "no holder fetch spent on a pool that dies on a cheap gate (mcap)");
  ok(getRawPoolScreeningRejectReason(cheapFail, S).includes("mcap"),
    "pool still rejected on the cheap gate as expected");
}

console.log("\n[5b] no base mint → no fetch, gate rejects holders_unknown");
{
  const noMint = signalPool({ holders: null });
  noMint.token_x.address = null;
  noMint.base_mint = null;
  let calls = 0;
  await __enrichHolderCountsBeforeGateForTests([noMint], S, async () => { calls++; return 600; });
  ok(calls === 0, "no mint → nothing to fetch");
  ok(getRawPoolScreeningRejectReason(noMint, S) === "holders_unknown",
    "no-mint pool fail-closed → holders_unknown");
}

console.log("\n[6] same mint across two pools in one pass → cached, ONE fetch");
{
  const a = signalPool({ holders: null, mint: "MintDup", name: "DUPA-SOL" });
  const b = signalPool({ holders: null, mint: "MintDup", name: "DUPB-SOL" });
  let calls = 0;
  await __enrichHolderCountsBeforeGateForTests([a, b], S, async () => { calls++; return 800; });
  // Note: both fire concurrently in the same pass; the per-mint TTL cache
  // collapses repeat fetches across SUBSEQUENT cycles. Within one Promise.all
  // batch both may call, so assert the cache is at least populated and both got
  // the count.
  ok(a.base_token_holders === 800 && b.base_token_holders === 800,
    "both pools sharing a mint receive the count");
  // Second standalone call for the same mint must hit cache (no new fetch).
  const c = signalPool({ holders: null, mint: "MintDup", name: "DUPC-SOL" });
  let calls2 = 0;
  await __enrichHolderCountsBeforeGateForTests([c], S, async () => { calls2++; return 999; });
  ok(calls2 === 0, "subsequent cycle for same mint served from TTL cache (no re-fetch)");
  ok(c.base_token_holders === 800, "cached count (800) reused, not re-fetched as 999");
}

console.log("\n[7] disabled flag (enrichHolderCountBeforeGate=false) is honored upstream");
{
  // The pass itself doesn't read the flag (discoverPools guards it); confirm the
  // legacy behavior — a null-count pool with no enrich → holders_unknown.
  const p = signalPool({ holders: null, mint: "MintLegacy" });
  ok(getRawPoolScreeningRejectReason(p, S) === "holders_unknown",
    "without enrich, missing count still fail-closed (legacy reject preserved)");
}

console.log(`\n${pass} assertions passed, 0 failed.`);
console.log("— Cassiopeia 👁️\n");
