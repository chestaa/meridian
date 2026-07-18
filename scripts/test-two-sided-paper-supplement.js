// Cassiopeia 👁️ — Two-sided PAPER supplement (Track-A surfacing fix).
//
// WHAT THIS PROVES:
//   1. FILTER BUILDER — the supplement filter uses a WIDE bluechip mcap ceiling
//      (bluechipBroadMcapCeil, $1T) NOT the memecoin broad ceiling (50M) that would
//      drop large-cap bluechip base legs (JitoSOL) at the server. Sanity + tvl floor
//      carried over so it stays a strict SUPERSET of the candidate set.
//   2. SURFACING — with the lane ACTIVE, a deep LST-SOL pool that the main
//      fee/TVL-sorted + 50M-ceilinged fetch would CLIP now surfaces via the tvl:desc
//      supplement. Random deep memecoin pools and wSOL-BASE bluechips in the same page
//      are filtered out (isTwoSidedPaperCandidate) so the merge stays tight.
//   3. BASE-LEG SAFETY still bites — a surfaced-but-bad LST pool (mint authority live)
//      is surfaced by the mechanism BUT rejected by twoSidedBaseLegGateReason. Surfacing
//      never weakens safety.
//   4. HARD ISOLATION — with the lane INACTIVE (live OR flag-off), fetchTwoSidedPaper-
//      Supplement returns [] and makes ZERO fetch calls; with the lane active it makes
//      EXACTLY ONE. Proven with a fetch spy.
//
// Run: node scripts/test-two-sided-paper-supplement.js

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
  buildTwoSidedPaperSupplementFilters,
  fetchTwoSidedPaperSupplement,
  twoSidedBaseLegGateReason,
  clearDiscoveryCache,
} = await import("../tools/screening.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"; // LST-SOL surfacing base, but NOT mint/freeze-exempt (Option A excludes it)
const DEGEN = "Deg3nMemeCoinAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Effective thresholds mirroring live defaults for the supplement.
const S = {
  broadMcapFloor: 10_000,
  broadMcapCeil: 50_000_000,          // memecoin ceiling that DROPS large-cap LST base legs
  bluechipBroadMcapCeil: 1_000_000_000_000, // wide bluechip ceiling ($1T)
  broadMinTvl: 1_000,
  broadDiscoveryPageSize: 1000,
  timeframe: "1h",
  category: "trending",
};

// Raw pool-discovery shape (token_x / token_y). LST=tokenX, wSOL=tokenY.
function rawPool(addr, xMint, yMint, name) {
  return { pool_address: addr, name: name || addr, token_x: { address: xMint }, token_y: { address: yMint } };
}

// Lane control helpers (mirror the sibling lane test).
function laneOn()  { config.strategy.twoSidedEnabled = true;  process.env.DRY_RUN = "true"; }
function laneOffFlag() { config.strategy.twoSidedEnabled = false; process.env.DRY_RUN = "true"; }
function laneOffLive() { config.strategy.twoSidedEnabled = true; process.env.DRY_RUN = "false"; }

// Base-leg safety thresholds (live defaults).
const SAFETY = {
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};

// Fetch spy: counts pool-discovery calls, returns a controllable tvl:desc page.
let fetchCalls = 0;
let pageToReturn = [];
const realFetch = global.fetch;
function installFetchSpy() {
  fetchCalls = 0;
  global.fetch = async (_url) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => { fetchCalls++; return { data: pageToReturn, total: pageToReturn.length }; },
  });
}
function restoreFetch() { global.fetch = realFetch; }

// Disable the discovery page cache so each call actually fetches (deterministic spy).
const savedTtl = config.screening.broadDiscoveryCacheTtlMin;
config.screening.broadDiscoveryCacheTtlMin = 0;
clearDiscoveryCache();

console.log("\n— 1. FILTER BUILDER (buildTwoSidedPaperSupplementFilters) —");
{
  const f = buildTwoSidedPaperSupplementFilters(S);
  check("uses WIDE bluechip ceiling ($1T)", f.includes("base_token_market_cap<=1000000000000"));
  check("does NOT use memecoin 50M ceiling (would drop LSTs)", !f.includes("base_token_market_cap<=50000000"));
  check("carries mcap floor", f.includes("base_token_market_cap>=10000"));
  check("carries tvl floor", f.includes("tvl>=1000"));
  check("carries pool_type=dlmm sanity", f.includes("pool_type=dlmm"));
  check("carries critical-warning sanity", f.includes("base_token_has_critical_warnings=false"));
  // Fall back to the memecoin ceiling only when the bluechip key is unset.
  const f2 = buildTwoSidedPaperSupplementFilters({ ...S, bluechipBroadMcapCeil: undefined });
  check("falls back to broadMcapCeil when bluechip ceil unset", f2.includes("base_token_market_cap<=50000000"));
}

console.log("\n— 2. SURFACING (fetchTwoSidedPaperSupplement, lane active) —");
{
  installFetchSpy();
  laneOn();
  // tvl:desc page: the deep pools first. The main fee/TVL fetch would have clipped the
  // low-fee LST-SOL pools; here they are surfaced. Also include noise that must be cut.
  pageToReturn = [
    rawPool("PoolJito", JITOSOL, WSOL, "JitoSOL-SOL"),
    rawPool("PoolMsol", MSOL, WSOL, "mSOL-SOL"),
    rawPool("PoolMeme", DEGEN, WSOL, "DEGEN-SOL"),      // deep memecoin — not bluechip pair
    rawPool("PoolSolUsdc", WSOL, USDC, "SOL-USDC"),     // bluechip pair but wSOL=BASE → not deployable
  ];
  clearDiscoveryCache();
  const surfaced = await fetchTwoSidedPaperSupplement(S);
  const addrs = surfaced.map((p) => p.pool_address).sort();
  check("exactly ONE fetch call (Lyra: single supplementary page)", fetchCalls === 1);
  check("surfaces the two LST-SOL pools", addrs.length === 2 && addrs.includes("PoolJito") && addrs.includes("PoolMsol"));
  check("drops deep memecoin pool (not bluechip pair)", !addrs.includes("PoolMeme"));
  check("drops SOL-USDC (wSOL=base, not deployable single-side-SOL)", !addrs.includes("PoolSolUsdc"));
  restoreFetch();
}

console.log("\n— 3. BASE-LEG SAFETY still bites on a surfaced pool —");
{
  installFetchSpy();
  laneOn();
  // A surfaced LST-SOL pool whose HELD base leg has a live mint authority. Surfacing
  // finds it (mechanism is safety-agnostic); base-leg safety must reject it. Use bSOL:
  // it IS a surfacing candidate but is DELIBERATELY excluded from the mint/freeze-exempt
  // set (Option A only exempts JitoSOL/mSOL/jupSOL), so its live mint authority still
  // bites — proving surfacing never weakens safety even inside the LST family.
  const badLst = rawPool("PoolBadBsol", BSOL, WSOL, "bSOL-SOL(bad)");
  pageToReturn = [badLst];
  clearDiscoveryCache();
  const surfaced = await fetchTwoSidedPaperSupplement(S);
  check("mechanism surfaces the pool (safety-agnostic)", surfaced.some((p) => p.pool_address === "PoolBadBsol"));
  // Now attach a bad audit and run the base-leg safety gate (as the funnel does downstream).
  const enriched = { ...badLst, audit: { mint_disabled: false, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: false };
  check("base-leg gate REJECTS live mint authority → mint_authority_not_renounced",
    twoSidedBaseLegGateReason(enriched, SAFETY) === "mint_authority_not_renounced");
  restoreFetch();
}

console.log("\n— 4. HARD ISOLATION (inactive → [] + ZERO fetch) —");
{
  installFetchSpy();
  pageToReturn = [rawPool("PoolJito", JITOSOL, WSOL, "JitoSOL-SOL")];

  // flag OFF (dry) → no-op.
  laneOffFlag();
  clearDiscoveryCache();
  const offFlag = await fetchTwoSidedPaperSupplement(S);
  check("flag OFF → returns []", Array.isArray(offFlag) && offFlag.length === 0);
  check("flag OFF → ZERO fetch calls (no extra API cost)", fetchCalls === 0);

  // LIVE (flag on but DRY_RUN=false) → no-op. This is the live single-side guarantee.
  laneOffLive();
  clearDiscoveryCache();
  const offLive = await fetchTwoSidedPaperSupplement(S);
  check("LIVE → returns []", Array.isArray(offLive) && offLive.length === 0);
  check("LIVE → ZERO fetch calls (live discovery byte-identical)", fetchCalls === 0);

  // lane ON → exactly one fetch (contrast: proves the guard is what suppressed it).
  laneOn();
  clearDiscoveryCache();
  const on = await fetchTwoSidedPaperSupplement(S);
  check("lane ON → surfaces the candidate", on.length === 1 && on[0].pool_address === "PoolJito");
  check("lane ON → exactly ONE fetch call", fetchCalls === 1);
  restoreFetch();
}

// Restore config + env.
config.screening.broadDiscoveryCacheTtlMin = savedTtl;
clearDiscoveryCache();
config.strategy.twoSidedEnabled = false;
process.env.DRY_RUN = "true";

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
