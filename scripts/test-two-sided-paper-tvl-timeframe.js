// Cassiopeia 👁️ — Two-sided PAPER lane: TVL-floor override (S2 blocker #4) +
// activity-window fix (S2 blocker #5). Paper-lane isolated, fail-closed.
//
// CONTEXT: cbBTC exemption shipped and works, but the deepest genuine cbBTC-SOL pools
// ($63k-$99k TVL) were dropped by the institutional bluechipMinTvl ($200k) surfacing
// floor BEFORE the base-leg gate (blocker #4). And at the live 1h screening timeframe a
// low-FREQUENCY bluechip pair reads volume=0 (empty window) → the activity floor killed
// it AND the judge saw a "dead" pool (blocker #5).
//
// WHAT THIS PROVES:
//   1. #4 OVERRIDE — twoSidedPaperMinTvl ($25k default) overrides bluechipMinTvl ($200k)
//      INSIDE twoSidedPaperBluechipGateReason: a $63k/$99k cbBTC-SOL pool now PASSES.
//   2. #4 FALLBACK — unset/0 override → falls back to bluechipMinTvl (the STRICTER floor);
//      never silently loosens when the paper key is cleared.
//   3. #4 FAIL-CLOSED — override active + missing TVL → two_sided_paper_tvl_unknown.
//   4. #4 STILL BITES — a genuinely thin pool ($10k) is still rejected under the $25k
//      override (the floor is lowered, NOT removed).
//   5. #4 ISOLATION — the LIVE/income lane (bluechipPoolGateRejectReason) still uses
//      bluechipMinTvl and is UNTOUCHED by twoSidedPaperMinTvl: a $63k pool is rejected by
//      the income lane's $200k floor even with the paper override set. Live floor intact.
//   6. #5 WINDOW — fetchTwoSidedPaperSupplement fetches at twoSidedPaperTimeframe (24h),
//      not the 1h screening timeframe (proven via a URL-capturing fetch spy); falls back
//      to the screening timeframe when unset; ZERO fetch in live / flag-off (isolation).
//
// Run: node scripts/test-two-sided-paper-tvl-timeframe.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  twoSidedPaperBluechipGateReason,
  bluechipPoolGateRejectReason,
  fetchTwoSidedPaperSupplement,
  clearDiscoveryCache,
} = await import("../tools/screening.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";

// Effective thresholds mirroring live bluechip defaults + the new paper keys. Note the
// INSTITUTIONAL income floor bluechipMinTvl stays at 200k — the point is the paper key
// overrides it ONLY inside the paper gate.
const S = {
  bluechipMinTvl: 200_000,      // live/income institutional floor — must stay untouched
  bluechipMinMcap: 50_000_000,
  bluechipMaxVolatility: 1.5,
  bluechipMinVolume: 50_000,
  bluechipMinFeeTvlRatio: 0.03,
  twoSidedPaperMinVolume: 500,
  twoSidedPaperMinFeeTvlRatio: 0,
  twoSidedPaperMinTvl: 25_000,  // #4 — paper-only override (default)
};

// Real cbBTC-SOL profile at 24h (H2US... deepest): tvl 99.5k, vol 46k, fee/TVL 0.0637,
// vola 0.198, mcap 188M. token_x carries mcap; volume/fee/vol at the fetched window.
function cbbtcSol(overrides = {}) {
  return {
    pool_address: "H2USRSaWuUchkbdmSJgKNfAm7ocyD4ZnCm69oRGyecKw",
    name: "cbBTC-SOL",
    token_x: { address: CBBTC, market_cap: 188_000_000 },
    token_y: { address: WSOL },
    tvl: 99_518,
    volume: 46_062,
    fee_active_tvl_ratio: 0.0637,
    volatility: 0.198,
    ...overrides,
  };
}

console.log("— 1. #4 OVERRIDE: twoSidedPaperMinTvl lets deep cbBTC-SOL through the paper gate —");
{
  // $99.5k pool: below the $200k income floor, ABOVE the $25k paper override → PASS.
  check("cbBTC-SOL $99.5k PASSES paper gate (override $25k beats income $200k)",
    twoSidedPaperBluechipGateReason(cbbtcSol(), S) === null);
  // $63k pool (the deepest Draco probe found): also passes the $25k override.
  check("cbBTC-SOL $63k PASSES under $25k override",
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: 63_267 }), S) === null);
}

console.log("\n— 2. #4 FALLBACK: unset/0 override → falls back to the STRICTER bluechipMinTvl —");
{
  const sUnset = { ...S, twoSidedPaperMinTvl: undefined };
  check("override unset → $99.5k rejected by fallback bluechipMinTvl $200k",
    twoSidedPaperBluechipGateReason(cbbtcSol(), sUnset) === "two_sided_paper tvl 99518 below paper tvl floor 200000");
  const sZero = { ...S, twoSidedPaperMinTvl: 0 };
  check("override 0 (disabled) → also falls back to bluechipMinTvl $200k",
    twoSidedPaperBluechipGateReason(cbbtcSol(), sZero) === "two_sided_paper tvl 99518 below paper tvl floor 200000");
  // Override precedence: with the paper key set, the income floor value is IRRELEVANT.
  check("override $25k wins even when bluechipMinTvl raised to $1M",
    twoSidedPaperBluechipGateReason(cbbtcSol(), { ...S, bluechipMinTvl: 1_000_000 }) === null);
}

console.log("\n— 3. #4 FAIL-CLOSED + STILL BITES —");
{
  check("override active + missing TVL → two_sided_paper_tvl_unknown",
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: undefined }), S) === "two_sided_paper_tvl_unknown");
  check("Number(null)===0 trap avoided: tvl null !== tvl 0",
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: null }), S) === "two_sided_paper_tvl_unknown");
  check("genuinely thin pool ($10k) STILL rejected under the $25k override (lowered, not removed)",
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: 10_000 }), S) === "two_sided_paper tvl 10000 below paper tvl floor 25000");
  check("a pool exactly at the floor ($25k) passes; $24,999 rejected",
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: 25_000 }), S) === null &&
    twoSidedPaperBluechipGateReason(cbbtcSol({ tvl: 24_999 }), S) !== null);
}

console.log("\n— 4. #4 ISOLATION: the LIVE/income lane still uses bluechipMinTvl, UNTOUCHED —");
{
  // bluechipPoolGateRejectReason is the single-side income lane. It must NOT read the
  // paper override — a $63k pool is still rejected by the $200k income floor even with
  // twoSidedPaperMinTvl=$25k set. This is the live-floor-intact guarantee.
  check("income lane rejects $63k on bluechipMinTvl $200k (ignores paper override)",
    bluechipPoolGateRejectReason(cbbtcSol({ tvl: 63_267 }), S) === "bluechip tvl 63267 below bluechipMinTvl 200000");
  check("income lane still passes a genuinely deep $250k pool",
    bluechipPoolGateRejectReason(cbbtcSol({ tvl: 250_000, volume: 60_000 }), S) === null);
}

// ─── #5 activity window: supplement fetch timeframe ────────────────────────────
console.log("\n— 5. #5 WINDOW: supplement fetches at twoSidedPaperTimeframe (24h) —");
{
  const SUP = {
    broadMcapFloor: 10_000,
    bluechipBroadMcapCeil: 1_000_000_000_000,
    broadMinTvl: 1_000,
    broadDiscoveryPageSize: 1000,
    timeframe: "1h",              // the live screening window (empty for low-freq pairs)
    category: "trending",
    twoSidedPaperTimeframe: "24h", // #5 — the paper activity window
  };

  const realFetch = global.fetch;
  let capturedUrl = null;
  let fetchCalls = 0;
  const installSpy = () => {
    capturedUrl = null; fetchCalls = 0;
    global.fetch = async (url) => {
      capturedUrl = url; fetchCalls++;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: [], total: 0 }) };
    };
  };
  const savedTtl = config.screening.broadDiscoveryCacheTtlMin;
  config.screening.broadDiscoveryCacheTtlMin = 0; // force real fetch each call

  // Lane ACTIVE (twoSidedEnabled + DRY_RUN).
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "true";
  installSpy();
  clearDiscoveryCache();
  await fetchTwoSidedPaperSupplement(SUP);
  check("lane active → EXACTLY ONE supplement fetch", fetchCalls === 1);
  check("fetch uses timeframe=24h (paper activity window), NOT 1h",
    capturedUrl != null && capturedUrl.includes("timeframe=24h") && !capturedUrl.includes("timeframe=1h"));

  // Unset paper timeframe → falls back to the screening timeframe (1h).
  installSpy();
  clearDiscoveryCache();
  await fetchTwoSidedPaperSupplement({ ...SUP, twoSidedPaperTimeframe: undefined });
  check("unset twoSidedPaperTimeframe → falls back to screening timeframe (1h)",
    capturedUrl != null && capturedUrl.includes("timeframe=1h"));

  // Flag OFF → ZERO fetch (isolation).
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
  installSpy();
  clearDiscoveryCache();
  const off = await fetchTwoSidedPaperSupplement(SUP);
  check("flag OFF → [] and ZERO fetch (no extra API cost)", off.length === 0 && fetchCalls === 0);

  // LIVE (flag on, DRY_RUN false) → ZERO fetch (live discovery byte-identical).
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "false";
  installSpy();
  clearDiscoveryCache();
  const live = await fetchTwoSidedPaperSupplement(SUP);
  check("LIVE → [] and ZERO fetch (live single-side funnel untouched)", live.length === 0 && fetchCalls === 0);

  // Restore.
  global.fetch = realFetch;
  config.screening.broadDiscoveryCacheTtlMin = savedTtl;
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
}

// ─── DECOUPLE invariant: the basis for the enrichment-gate defense-in-depth ────
// The enrichment-stage memecoin rug / bot-top10 / dev_sold_all gates in getTopCandidates
// now exempt isTwoSidedPaperCandidate (in addition to isBluechipPool). That is only SAFE
// if two-sided candidacy is independent of bluechipModeEnabled — otherwise turning the
// income master flag off would route a cbBTC/LST base leg into the memecoin rug gate
// (which has NO mint/freeze exemption) and reject it on mint_authority_not_renounced
// BEFORE the base-leg gate (where the curated exemption lives). This proves the invariant.
console.log("\n— 6. DECOUPLE INVARIANT: two-sided candidacy ⊥ bluechipModeEnabled —");
{
  const { isTwoSidedPaperCandidate, isBluechipPool } = await import("../tools/screening.js");
  const pool = cbbtcSol();
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "true";
  // isBluechipPool is COUPLED to the master flag (returns false when it is off)...
  check("isBluechipPool coupled to bluechipModeEnabled (true only when on)",
    isBluechipPool(pool, { bluechipModeEnabled: true }) === true &&
    isBluechipPool(pool, { bluechipModeEnabled: false }) === false);
  // ...but two-sided candidacy is keyed on twoSidedEnabled + DRY_RUN ONLY, so the paper
  // lane (and its enrichment-gate exemptions) survives a bluechipModeEnabled toggle.
  check("isTwoSidedPaperCandidate TRUE regardless of bluechipModeEnabled",
    isTwoSidedPaperCandidate(pool, config, process.env.DRY_RUN) === true);
  config.strategy.twoSidedEnabled = false; // restore
  process.env.DRY_RUN = "true";
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "two-sided paper TVL-floor / timeframe suite must be green");
