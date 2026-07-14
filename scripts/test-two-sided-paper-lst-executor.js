// Vega — Two-sided PAPER-lane curated-LST EXECUTOR-side maxTvl carve-out tests.
//
// THE FINAL Track-A paper blocker: a deep-TVL curated LST-SOL income pair (JitoSOL/
// mSOL/jupSOL-SOL) surfaces → passes the strict screening gate → reaches deploy_position
// → then the executor's MEMECOIN gates in validateDeployPoolThresholds bite:
//   [SAFETY_BLOCK] Pool TVL $2,703,525 above maxTvl $150000.
// This suite proves the executor now MIRRORS the screening paper-lane treatment for a
// curated LST pair while the paper lane is active (twoSidedEnabled + DRY_RUN):
//   - GATE 1 maxTvl ceiling      → EXEMPT (deep TVL is the POINT of an LST income pair)
//   - GATE 2 fee/TVL floor       → DROPPED (low ~1% APR fee/TVL is EXPECTED, not a risk)
//   - GATE 3 vol floor→CEILING   → only a WILD reading (de-peg/thin book) rejected
//   - binStep [80,125] floor     → EXEMPT (LST-SOL uses a fine bin_step; sanity bound stays)
// with HARD ISOLATION: LIVE (DRY_RUN=false), flag-OFF, and non-curated bases keep the
// memecoin maxTvl ceiling fully enforced, byte-unchanged. Independent of bluechipModeEnabled.
//
// Driven through __validateDeployPoolThresholdsForTests via the snapshot-fetch seam —
// no on-chain TX, no live API.
//
// Run: node scripts/test-two-sided-paper-lst-executor.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
process.env.DRY_RUN = "true";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const executor = await import("../tools/executor.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"; // in LST-SOL set but NOT freeze-exempt
const MEMECOIN = "9xyzMEMEcoinMintAddressNotWhitelistedDEADBEEF11";

function installDetail(detail) {
  executor.__setSnapshotFetchForTests(
    async () => ({ ok: true, json: async () => ({ data: [detail] }) }),
    [0, 0, 0, 0, 0],
  );
}

// Deep LST-SOL detail: LST = token_x (BASE), wSOL = token_y (QUOTE). $2.7M TVL, low
// ~1% APR fee/TVL (below BOTH the memecoin 0.10 and bluechip 0.03 floors — the exact
// profile that must clear the DROPPED fee floor), calm vol, fine bin_step 4.
function lstSolDetail(lstMint = JITOSOL, overrides = {}) {
  return {
    token_x: { address: lstMint },
    token_y: { address: WSOL },
    tvl: 2_703_525,
    fee_active_tvl_ratio: 0.003,
    fee_tvl_ratio: 0.003,
    volatility: 0.2,
    dlmm_params: { bin_step: 4 },
    ...overrides,
  };
}

// Deep NON-LST pool in the SAME leg shape (memecoin base on token_x, wSOL on token_y).
function nonLstDeepDetail(baseMint = MEMECOIN, overrides = {}) {
  return {
    token_x: { address: baseMint },
    token_y: { address: WSOL },
    tvl: 2_703_525,
    fee_active_tvl_ratio: 0.15,
    fee_tvl_ratio: 0.15,
    volatility: 4.0,
    dlmm_params: { bin_step: 100 },
    ...overrides,
  };
}

async function verify(args) {
  return executor.__validateDeployPoolThresholdsForTests(args);
}

// Memecoin floors (mirror live overlay) + bluechip ceilings the paper lane reuses.
config.screening.maxTvl = 150_000;
config.screening.minTvl = 0;
config.screening.minFeeActiveTvlRatio = 0.10;
config.screening.bluechipMinFeeTvlRatio = 0.03;
config.screening.bluechipMaxVolatility = 1.5;
config.screening.bluechipMaxBinStep = 200;
config.screening.minBinStep = 80;
config.screening.maxBinStep = 125;
config.screening.timeframe = "5m";
// Independence proof: bluechip income mode stays OFF the entire suite — the paper LST
// lane must work on its own, NOT via bluechipModeEnabled.
config.screening.bluechipModeEnabled = false;

function setPaperLane(on) {
  config.strategy = config.strategy || {};
  config.strategy.twoSidedEnabled = on;
  config.strategy.twoSidedPaperOnly = true; // never authorize live two-sided
}

console.log("\n=== Two-sided paper-lane curated-LST executor maxTvl carve-out ===\n");

// ── 0. Pure predicate (isTwoSidedPaperLstExempt) — isolation matrix ──
console.log("— 0. isTwoSidedPaperLstExempt (lane + curated-LST + fail-closed) —");
setPaperLane(true);
process.env.DRY_RUN = "true";
check("paper lane + JitoSOL base → exempt",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: JITOSOL }) === true);
check("paper lane + mSOL base → exempt",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: MSOL }) === true);
check("paper lane + jupSOL base → exempt",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: JUPSOL }) === true);
check("paper lane + bSOL base → NOT exempt (not freeze-probe-confirmed)",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: BSOL }) === false);
check("paper lane + USDC base → NOT exempt (stable, not LST)",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: USDC }) === false);
check("paper lane + memecoin base → NOT exempt",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: MEMECOIN }) === false);
check("paper lane + no base + detail token_x=JitoSOL → exempt (legs from detail)",
  executor.__isTwoSidedPaperLstExemptForTests({}, lstSolDetail(JITOSOL)) === true);
check("paper lane + base_mint=WSOL but detail token_x=JitoSOL → exempt (authoritative leg)",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: WSOL }, lstSolDetail(JITOSOL)) === true);
setPaperLane(false);
check("flag OFF + JitoSOL → NOT exempt (lane inactive)",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: JITOSOL }) === false);
setPaperLane(true);
process.env.DRY_RUN = "false";
check("LIVE (DRY_RUN=false) + JitoSOL → NOT exempt (lane inactive)",
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: JITOSOL }) === false);
process.env.DRY_RUN = "true";

// ── 1. THE FIX — deep JitoSOL-SOL clears maxTvl in the paper lane ──
console.log("\n— 1. Deep JitoSOL-SOL ($2.7M) clears maxTvl (paper lane) —");
setPaperLane(true);
process.env.DRY_RUN = "true";
installDetail(lstSolDetail(JITOSOL));
{
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: JITOSOL });
  check("JitoSOL-SOL $2.7M (base_mint=JITOSOL) → PASS (maxTvl EXEMPT, fee floor dropped, binStep exempt)",
    r.pass === true);
}
installDetail(lstSolDetail(JITOSOL));
{
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: WSOL });
  check("JitoSOL-SOL $2.7M (base_mint=WSOL, LST on detail token_x) → PASS", r.pass === true);
}
installDetail(lstSolDetail(JITOSOL));
{
  const r = await verify({ pool_address: "JITOSOL_SOL" });
  check("JitoSOL-SOL $2.7M (no base_mint, legs from detail) → PASS", r.pass === true);
}
installDetail(lstSolDetail(MSOL));
{
  const r = await verify({ pool_address: "MSOL_SOL", base_mint: MSOL });
  check("mSOL-SOL $2.7M → PASS", r.pass === true);
}
installDetail(lstSolDetail(JUPSOL));
{
  const r = await verify({ pool_address: "JUPSOL_SOL", base_mint: JUPSOL });
  check("jupSOL-SOL $2.7M → PASS", r.pass === true);
}

// ── 2. fee/TVL floor DROPPED for the paper LST lane ──
console.log("\n— 2. fee/TVL floor dropped (paper LST lane) —");
installDetail(lstSolDetail(JITOSOL, { fee_active_tvl_ratio: 0.0001, fee_tvl_ratio: 0.0001 }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_LOWFEE", base_mint: JITOSOL });
  check("JitoSOL-SOL fee/TVL 0.0001 (well below 0.03 & 0.10) → PASS (floor dropped)", r.pass === true);
}
installDetail(lstSolDetail(JITOSOL, { fee_active_tvl_ratio: null, fee_tvl_ratio: null }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_NOFEE", base_mint: JITOSOL });
  check("JitoSOL-SOL fee/TVL UNKNOWN → PASS (no floor to reject against in paper LST lane)", r.pass === true);
}

// ── 3. vol CEILING still bites (de-peg / thin-book guard preserved) ──
console.log("\n— 3. vol ceiling preserved (paper LST lane) —");
installDetail(lstSolDetail(JITOSOL, { volatility: 0 }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_VOL0", base_mint: JITOSOL });
  check("JitoSOL-SOL vol 0 (stable = GOOD) → PASS (floor exempt)", r.pass === true);
}
installDetail(lstSolDetail(JITOSOL, { volatility: 2.5 }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_VOLWILD", base_mint: JITOSOL });
  check("JitoSOL-SOL vol 2.5 > bluechipMaxVolatility 1.5 (de-peg) → REJECT",
    r.pass === false && /bluechipMaxVolatility/.test(r.reason));
}

// ── 4. binStep exempt but sanity bound retained ──
console.log("\n— 4. binStep exempt + sanity bound (paper LST lane) —");
installDetail(lstSolDetail(JITOSOL, { dlmm_params: { bin_step: 2 } }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_STEP2", base_mint: JITOSOL });
  check("JitoSOL-SOL bin_step 2 (< memecoin minBinStep 80) → PASS (binStep exempt)", r.pass === true);
}
installDetail(lstSolDetail(JITOSOL, { dlmm_params: { bin_step: 0 } }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_STEP0", base_mint: JITOSOL });
  check("JitoSOL-SOL bin_step 0 → REJECT (sanity bound, exemption ≠ no-check)",
    r.pass === false && /not a positive integer/.test(r.reason));
}

// ── 5. HARD ISOLATION — LIVE keeps memecoin maxTvl fully enforced ──
console.log("\n— 5. LIVE (DRY_RUN=false) → memecoin maxTvl STILL bites —");
process.env.DRY_RUN = "false";
installDetail(lstSolDetail(JITOSOL));
{
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: JITOSOL });
  check("SAME JitoSOL-SOL $2.7M in LIVE → REJECT (maxTvl, lane inactive → byte-unchanged)",
    r.pass === false && /maxTvl/.test(r.reason));
}
process.env.DRY_RUN = "true";

// ── 6. HARD ISOLATION — flag OFF keeps memecoin maxTvl ──
console.log("\n— 6. flag OFF → memecoin maxTvl STILL bites —");
setPaperLane(false);
installDetail(lstSolDetail(JITOSOL));
{
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: JITOSOL });
  check("JitoSOL-SOL $2.7M, twoSidedEnabled=false → REJECT (maxTvl, lane inactive)",
    r.pass === false && /maxTvl/.test(r.reason));
}
setPaperLane(true);

// ── 7. NON-LST bases in the paper lane → memecoin maxTvl STILL bites ──
console.log("\n— 7. non-curated bases in paper lane → memecoin maxTvl bites —");
installDetail(nonLstDeepDetail(MEMECOIN));
{
  const r = await verify({ pool_address: "MEME_SOL_DEEP", base_mint: MEMECOIN });
  check("deep memecoin-SOL $2.7M (paper lane) → REJECT (not curated LST → maxTvl bites)",
    r.pass === false && /maxTvl/.test(r.reason));
}
installDetail(lstSolDetail(BSOL));
{
  const r = await verify({ pool_address: "BSOL_SOL", base_mint: BSOL });
  check("deep bSOL-SOL $2.7M (paper lane) → REJECT (bSOL NOT freeze-probe-confirmed → maxTvl bites)",
    r.pass === false && /maxTvl/.test(r.reason));
}
installDetail(lstSolDetail(USDC));
{
  const r = await verify({ pool_address: "USDC_SOL", base_mint: USDC });
  check("deep USDC-SOL $2.7M (paper lane) → REJECT (stable, not LST → maxTvl bites)",
    r.pass === false && /maxTvl/.test(r.reason));
}

// ── 8. Other safety checks intact (fail-closed preserved) ──
console.log("\n— 8. other safety checks intact —");
installDetail(lstSolDetail(JITOSOL, { tvl: null }));
{
  const r = await verify({ pool_address: "JITOSOL_SOL_NOTVL", base_mint: JITOSOL });
  check("JitoSOL-SOL TVL UNKNOWN → REJECT (fail-closed, TVL read unconditional)",
    r.pass === false && /Could not verify pool TVL/.test(r.reason));
}
// memecoin normal pool unaffected by this change
installDetail(nonLstDeepDetail(MEMECOIN, { tvl: 80_000 }));
{
  const r = await verify({ pool_address: "MEME_OK", base_mint: MEMECOIN });
  check("memecoin normal (TVL 80k, fee 0.15, vol 4, bin_step 100) → PASS (unchanged)", r.pass === true);
}

executor.__resetSnapshotFetchForTests();
setPaperLane(false);
process.env.DRY_RUN = "true";

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
