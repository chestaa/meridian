/**
 * Cassiopeia — enrich-before-gate for the volatility + organic structural gaps.
 *
 * THE LAST FUNNEL WALL (Draco 2026-06-11): cross-ref signal pools
 * (discord/solscan/pumpfun via dlmm.datapi.meteora.ag) died at
 * "base organic 0 < minOrganic" / "volatility unknown" because organic_score and
 * volatility are a STRUCTURAL GAP on the cross-ref endpoint — a 0 there is
 * DATA-MISSING, not a real low score. The NATIVE Pool-Discovery detail endpoint
 * (by pool_address) carries both as proper scalars.
 *
 * FIX (verified here): for cross-ref pools missing volatility OR organic that
 * clear every OTHER cheap gate, fetch the native detail once (cached) and fill the
 * real numbers, then let the gates judge them. minOrganic is UNCHANGED. Enrich is
 * NOT a bypass — a failed fetch / still-null field leaves the gap null and the gate
 * rejects "volatility_unknown" / "organic_unknown" (fail-closed, anti-pattern #2).
 *
 * Asserts:
 *   - organic null + enrich→80  → PASS organic gate (real number judged)
 *   - organic null + enrich→50  → reject (genuine sub-floor, floor still 75)
 *   - organic null + enrich FAILS → reject organic_unknown (fail-closed)
 *   - volatility null + enrich→4 → PASS volatility gate
 *   - volatility null + enrich FAILS → reject volatility_unknown (fail-closed)
 *   - native pool already carrying organic+volatility → NO re-fetch
 *   - cheap-gate-fail pool (mcap) → NO native fetch spent (Lyra cost order)
 *   - same pool_address twice → second served from TTL cache (no re-fetch)
 *   - reject-reason split regression: null vs genuine-low are distinct reasons
 */
import assert from "node:assert";
import {
  __enrichNativeDetailBeforeGateForTests,
  __buildEnrichProbeForTests,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  PASS  ${msg}`);
  pass++;
};

// Thresholds mirroring the live overlay. minOrganic 75 (the wall Draco hit).
const S = {
  minHolders: 500,
  minMcap: 150_000, maxMcap: 10_000_000,
  minVolume: 500, minTvl: 10_000, maxTvl: 150_000,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.06,
  minOrganic: 75, minQuoteOrganic: 0,
  minTokenAgeHours: null, maxTokenAgeHours: null,
  excludeHighSupplyConcentration: false,
  blockedLaunchpads: [], allowedLaunchpads: [],
};

// A cross-ref signal pool that clears every gate EXCEPT it is missing volatility
// and/or organic (the structural gaps). Holders already filled (holder-enrich ran
// first). volatility/organic default to null = the cross-ref data-missing state.
function crossrefPool({
  volatility = null,
  organic = null,
  mcap = 1_000_000,
  addr = "POOL_AAA",
  name = "SIG-SOL",
} = {}) {
  return {
    pool_address: addr,
    name,
    pool_type: "dlmm",
    discord_signal: true,
    signal_source: "discord_meteoraidn",
    tvl: 50_000,
    volume: 20_000,
    fee_active_tvl_ratio: 0.10,
    volatility,
    base_token_holders: 800,
    dlmm_params: { bin_step: 100 },
    token_x: {
      symbol: name.split("-")[0],
      address: "Mint" + addr,
      organic_score: organic,
      market_cap: mcap,
      created_at: Date.now() - 100 * 3_600_000,
    },
    token_y: { symbol: "SOL", address: "So111", organic_score: 0 },
    base_mint: "Mint" + addr,
  };
}

// A native detail response (pool-discovery-api shape) the injected fetcher returns.
function nativeDetail({ volatility = 5, organic = 80 } = {}) {
  return {
    volatility,
    fee_active_tvl_ratio: 0.34,
    tvl: 12_000,
    volume: 1500,
    base_token_holders: 13000,
    dlmm_params: { bin_step: 100 },
    token_x: {
      organic_score: organic,
      market_cap: 1_800_000,
      created_at: Date.now() - 100 * 3_600_000,
    },
  };
}

console.log("\n[1] organic null + enrich SUCCESS 80 → PASS organic gate (real number)");
{
  const p = crossrefPool({ organic: null, volatility: 4, addr: "P_ORG80" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S, async ({ poolAddress }) => {
    calls++;
    assert.strictEqual(poolAddress, "P_ORG80", "fetched the pool's address");
    return nativeDetail({ organic: 80, volatility: 4 });
  });
  ok(calls === 1, "native detail fetched exactly once for a survivor missing organic");
  ok(p.token_x.organic_score === 80, "real organic (80) written onto pool");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate PASSES on real organic 80 (>= floor 75)");
}

console.log("\n[2] organic null + enrich SUCCESS 50 → reject (genuine sub-floor)");
{
  const p = crossrefPool({ organic: null, volatility: 4, addr: "P_ORG50" });
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => nativeDetail({ organic: 50, volatility: 4 }));
  ok(p.token_x.organic_score === 50, "real organic 50 written");
  const r = getRawPoolScreeningRejectReason(p, S);
  ok(typeof r === "string" && r.includes("below minOrganic 75"),
    `genuine sub-floor reject (got: ${r}) — minOrganic 75 still enforced, NOT loosened`);
}

console.log("\n[3] organic null + enrich FAILS → reject organic_unknown (FAIL-CLOSED)");
{
  const p = crossrefPool({ organic: null, volatility: 4, addr: "P_ORGFAIL" });
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => { throw new Error("API down"); });
  ok(p.token_x.organic_score == null, "failed enrich leaves organic null (no default to safe)");
  ok(getRawPoolScreeningRejectReason(p, S) === "organic_unknown",
    "fail-closed: enrich failure → organic_unknown reject, NOT a pass");
}

console.log("\n[3b] organic null + enrich returns detail with null organic → organic_unknown");
{
  const p = crossrefPool({ organic: null, volatility: 4, addr: "P_ORGNULL" });
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => nativeDetail({ organic: null, volatility: 4 }));
  ok(getRawPoolScreeningRejectReason(p, S) === "organic_unknown",
    "null organic in the detail (not just error) also fail-closed → organic_unknown");
}

console.log("\n[4] volatility null + enrich SUCCESS 4 → PASS volatility gate");
{
  const p = crossrefPool({ organic: 80, volatility: null, addr: "P_VOL4" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => { calls++; return nativeDetail({ volatility: 4.2, organic: 80 }); });
  ok(calls === 1, "native detail fetched for a survivor missing volatility");
  ok(p.volatility === 4.2, "real volatility (4.2) written onto pool");
  ok(p.volatility_timeframe === "30m", "volatility stamped 30m timeframe (conservative window)");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate PASSES on real volatility 4.2");
}

console.log("\n[5] volatility null + enrich FAILS → reject volatility_unknown (FAIL-CLOSED)");
{
  const p = crossrefPool({ organic: 80, volatility: null, addr: "P_VOLFAIL" });
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => { throw new Error("timeout"); });
  ok(p.volatility == null, "failed enrich leaves volatility null (no default to usable)");
  ok(getRawPoolScreeningRejectReason(p, S) === "volatility_unknown",
    "fail-closed: enrich failure → volatility_unknown reject, NOT a pass");
}

console.log("\n[5b] volatility null + detail returns vol 0 → still unusable (not rescued to a fake number)");
{
  const p = crossrefPool({ organic: 80, volatility: null, addr: "P_VOL0" });
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => nativeDetail({ volatility: 0, organic: 80 }));
  // vol 0 is a real scalar (not null) → written, then the genuine-unusable gate fires.
  const r = getRawPoolScreeningRejectReason(p, S);
  ok(p.volatility === 0, "real vol 0 written (honest)");
  ok(typeof r === "string" && r.includes("unusable") && r !== "volatility_unknown",
    `genuine vol 0 → "...is unusable" (distinct from data-missing volatility_unknown), got: ${r}`);
}

console.log("\n[6] both gaps null → single fetch fills BOTH (one call, not per-field)");
{
  const p = crossrefPool({ organic: null, volatility: null, addr: "P_BOTH" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => { calls++; return nativeDetail({ organic: 82, volatility: 5 }); });
  ok(calls === 1, "ONE native fetch fills both volatility and organic (efficient, not per-field)");
  ok(p.volatility === 5 && p.token_x.organic_score === 82, "both gaps filled from the single detail");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate passes with both real numbers");
}

console.log("\n[7] native pool already carrying organic+volatility → NO re-fetch");
{
  const p = crossrefPool({ organic: 80, volatility: 4, addr: "P_NATIVE" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S, async () => { calls++; return nativeDetail(); });
  ok(calls === 0, "pool with both fields present is NOT re-fetched (cost-aware)");
  ok(p.volatility === 4 && p.token_x.organic_score === 80, "existing values untouched");
  ok(getRawPoolScreeningRejectReason(p, S) === null, "gate passes on existing data");
}

console.log("\n[8] Lyra cost ordering — pool failing a CHEAP gate gets NO native fetch");
{
  // mcap below floor → dies on the (no-API) mcap gate. Must not spend a native
  // detail fetch even though volatility+organic are missing.
  const cheapFail = crossrefPool({ organic: null, volatility: null, mcap: 1000, addr: "P_CHEAPFAIL" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([cheapFail], S, async () => { calls++; return nativeDetail(); });
  ok(calls === 0, "no native fetch spent on a pool that dies on a cheap gate (mcap)");
  ok(getRawPoolScreeningRejectReason(cheapFail, S).includes("mcap"),
    "pool still rejected on the cheap gate as expected");
}

console.log("\n[8b] no pool_address → no fetch, gate rejects on the missing gap");
{
  const noAddr = crossrefPool({ organic: null, volatility: null, addr: "P_NOADDR" });
  noAddr.pool_address = null;
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([noAddr], S, async () => { calls++; return nativeDetail(); });
  ok(calls === 0, "no pool_address → nothing to fetch");
  const r = getRawPoolScreeningRejectReason(noAddr, S);
  ok(r === "volatility_unknown" || r === "organic_unknown",
    `no-address pool fail-closed → ${r}`);
}

console.log("\n[9] same pool_address across cycles → second served from TTL cache (no re-fetch)");
{
  const a = crossrefPool({ organic: null, volatility: null, addr: "P_DUP" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([a], S, async () => { calls++; return nativeDetail({ organic: 81, volatility: 5 }); });
  ok(calls === 1, "first cycle fetches once");
  // Second standalone call for the same address must hit cache (no new fetch).
  const b = crossrefPool({ organic: null, volatility: null, addr: "P_DUP", name: "DUPB-SOL" });
  let calls2 = 0;
  await __enrichNativeDetailBeforeGateForTests([b], S, async () => { calls2++; return nativeDetail({ organic: 99, volatility: 9 }); });
  ok(calls2 === 0, "subsequent cycle for same pool_address served from TTL cache (no re-fetch)");
  ok(b.token_x.organic_score === 81 && b.volatility === 5,
    "cached detail (organic 81 / vol 5) reused, not re-fetched as 99/9");
}

console.log("\n[10] reject-reason split regression — null vs genuine-low are DISTINCT reasons");
{
  const missingOrg = crossrefPool({ organic: null, volatility: 4, addr: "P_R1" });
  ok(getRawPoolScreeningRejectReason(missingOrg, S) === "organic_unknown",
    "organic null (no enrich) → organic_unknown (data-missing, fail-closed)");

  const lowOrg = crossrefPool({ organic: 40, volatility: 4, addr: "P_R2" });
  const r2 = getRawPoolScreeningRejectReason(lowOrg, S);
  ok(typeof r2 === "string" && r2.includes("below minOrganic 75"),
    `organic 40 → genuine sub-floor reject (got: ${r2}), distinct from organic_unknown`);

  const missingVol = crossrefPool({ organic: 80, volatility: null, addr: "P_R3" });
  ok(getRawPoolScreeningRejectReason(missingVol, S) === "volatility_unknown",
    "volatility null (no enrich) → volatility_unknown (data-missing, fail-closed)");

  const deadVol = crossrefPool({ organic: 80, volatility: 0, addr: "P_R4" });
  const r4 = getRawPoolScreeningRejectReason(deadVol, S);
  ok(typeof r4 === "string" && r4.includes("unusable") && r4 !== "volatility_unknown",
    `volatility 0 → "...is unusable" (genuine), distinct from volatility_unknown (got: ${r4})`);
}

// ── CATCH-22 CLOSE (Cassiopeia 2026-06-11) ──────────────────────────────────
// The probe that decides "is the native fetch worth spending?" used to sentinel
// ONLY volatility+organic. But enrichNativeDetailBeforeGate ALSO back-fills
// created_at, mcap, tvl, volume, fee/tvl, holders, bin_step. A live overlay with
// an ACTIVE token-age band + a signal pool with NO created_at (structural gap on
// the cross-ref endpoint) → the AGE gate fired INSIDE the probe → fetch skipped →
// created_at never filled → pool never reached the judge. These tests pin the fix:
// the probe must sentinel EVERY field the fetch can fill, while real-eval after the
// fetch stays fail-closed.

// Live-overlay thresholds WITH an active age band (the production condition Draco
// hit — S above has age null, which is why the bug never surfaced in [1]-[10]).
const S_AGE = { ...S, minTokenAgeHours: 8, maxTokenAgeHours: 720, minOrganic: 75 };

// A signal pool with the FULL structural-gap profile of the 5 stuck pools
// (清正/CHANCE/1-SOL/Bountywork/PARQ): missing created_at AND volatility AND
// organic, but clearing every cheap gate once the fetch fills them.
function structuralGapPool({ addr = "P_STUCK", name = "STUCK-SOL", mcap = 1_000_000 } = {}) {
  return {
    pool_address: addr,
    name,
    pool_type: "dlmm",
    discord_signal: true,
    signal_source: "discord_meteoraidn",
    tvl: 50_000,
    volume: 20_000,
    fee_active_tvl_ratio: 0.10,
    volatility: null,                 // structural gap
    base_token_holders: 800,
    dlmm_params: { bin_step: 100 },
    token_x: {
      symbol: name.split("-")[0],
      address: "Mint" + addr,
      organic_score: null,            // structural gap
      market_cap: mcap,
      created_at: null,               // ← THE catch-22 field (missing on cross-ref)
    },
    token_y: { symbol: "SOL", address: "So111", organic_score: 0 },
    base_mint: "Mint" + addr,
  };
}

console.log("\n[11] CATCH-22: missing created_at + active age band → probe CLEARS (regression)");
{
  // PRE-FIX this returned a token-age reject (createdAt null → age gate) and the
  // fetch was skipped. The probe must now sentinel created_at and clear.
  const p = structuralGapPool({ addr: "P_AGE22" });
  const probe = __buildEnrichProbeForTests(p, S_AGE);
  ok(getRawPoolScreeningRejectReason(probe, S_AGE) === null,
    "probe with missing created_at + active age band CLEARS (catch-22 closed)");
}

console.log("\n[11b] CATCH-22 end-to-end: stuck signal pool → fetch FIRES → reaches judge");
{
  const p = structuralGapPool({ addr: "P_E2E" });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S_AGE, async ({ poolAddress }) => {
    calls++;
    assert.strictEqual(poolAddress, "P_E2E");
    return {
      volatility: 4.5,
      token_x: { organic_score: 80, created_at: Date.now() - 100 * 3_600_000 },
    };
  });
  ok(calls === 1, "native fetch FIRES for a stuck pool (was skipped pre-fix — the catch-22)");
  ok(p.volatility === 4.5 && p.token_x.organic_score === 80 && Number.isFinite(p.token_x.created_at),
    "back-fill wrote volatility + organic + created_at");
  ok(getRawPoolScreeningRejectReason(p, S_AGE) === null,
    "real-eval PASSES after back-fill → clean signal pool WOULD REACH THE JUDGE");
}

console.log("\n[12] FAIL-CLOSED preserved: fetch returns NO created_at → age reject (real-eval)");
{
  // The probe is optimistic, but if the native detail genuinely lacks created_at,
  // real-eval must STILL reject on age (sentinel ≠ bypass).
  const p = structuralGapPool({ addr: "P_NOAGE" });
  await __enrichNativeDetailBeforeGateForTests([p], S_AGE, async () => ({
    volatility: 4.5,
    token_x: { organic_score: 80 /* created_at absent */ },
  }));
  ok(p.token_x.created_at == null, "no created_at written (native genuinely lacked it)");
  const r = getRawPoolScreeningRejectReason(p, S_AGE);
  ok(typeof r === "string" && r.includes("token age"),
    `real-eval fail-closed: missing created_at → age reject (got: ${r}) — sentinel was probe-only`);
}

console.log("\n[12b] FAIL-CLOSED: probe clears but enrich FAILS → vol/organic_unknown (real-eval)");
{
  const p = structuralGapPool({ addr: "P_ENRICHFAIL" });
  await __enrichNativeDetailBeforeGateForTests([p], S_AGE, async () => { throw new Error("API down"); });
  const r = getRawPoolScreeningRejectReason(p, S_AGE);
  ok(r === "volatility_unknown" || r === "organic_unknown",
    `enrich failure after a cleared probe still fail-closed → ${r} (NOT a pass)`);
}

console.log("\n[13] Lyra cost: real mcap below floor + missing gaps → probe REJECTS → no fetch");
{
  // mcap is genuinely present and below floor — the probe must NOT sentinel a
  // present real value, so the cheap gate still drops the pool for free.
  const p = structuralGapPool({ addr: "P_REALMCAP", mcap: 1000 });
  let calls = 0;
  await __enrichNativeDetailBeforeGateForTests([p], S_AGE, async () => { calls++; return {}; });
  ok(calls === 0, "real mcap below floor → probe rejects → NO native fetch (cost preserved)");
  ok(getRawPoolScreeningRejectReason(p, S_AGE).includes("mcap"), "still rejected on the real mcap gate");
}

console.log("\n[14] AUDIT: probe sentinels EVERY back-fill field (tenth-field catch-22 guard)");
{
  // A pool missing ALL nine back-fill fields, but clearing the gates the fetch
  // can't help (no critical warnings etc). With an active age band. If ANY
  // back-fill field is left un-sentinelled in the probe, this asserts and points
  // at the exact gate — the guard that makes a future catch-22 fail loudly here
  // rather than silently in production.
  const bare = {
    pool_address: "P_AUDIT",
    name: "AUDIT-SOL",
    pool_type: "dlmm",
    discord_signal: true,
    volatility: null,
    base_token_holders: null,
    tvl: null,
    volume: null,
    fee_active_tvl_ratio: null,
    dlmm_params: { bin_step: null },
    token_x: { organic_score: null, market_cap: null, created_at: null },
    token_y: { symbol: "SOL", address: "So111", organic_score: 0 },
  };
  const probe = __buildEnrichProbeForTests(bare, S_AGE);
  const r = getRawPoolScreeningRejectReason(probe, S_AGE);
  ok(r === null,
    `probe with ALL back-fill fields missing CLEARS — every back-fill field is sentinelled (got: ${r ?? "null"})`);
}

console.log(`\n${pass} assertions passed, 0 failed.`);
console.log("— Cassiopeia 👁️\n");
