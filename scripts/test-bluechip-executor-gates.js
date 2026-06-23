// Vega — Bluechip EXECUTOR-side gate exemption tests (PENUTUP, money-path).
//
// Cassiopeia exempted maxTvl/fee-TVL/vol-floor SCREENING-side; the deploy-side
// pre-deploy verify (validateDeployPoolThresholds in executor.js) still applied the
// MEMECOIN gates and blocked clean bluechip pools (SOL-USDC: TVL $245k > maxTvl
// $150k; fee/TVL 0.04 < minFeeActiveTvlRatio 0.10; vol low). This suite proves the
// THREE money-path gates are exempt for a WHITELIST bluechip pair (flag ON) only,
// with memecoin + flag-OFF paths byte-for-byte unchanged, and fail-closed intact.
//
// Driven through __validateDeployPoolThresholdsForTests via the snapshot-fetch seam
// (__setSnapshotFetchForTests) — no on-chain TX, no live API. Each "fetch" returns a
// mock pool detail; we assert pass/fail of the threshold verify only.
//
// Run: node scripts/test-bluechip-executor-gates.js

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
const MEMECOIN = "9xyzMEMEcoinMintAddressNotWhitelistedDEADBEEF11";

// Mock a Pool-Discovery /pools response wrapping a single detail row.
function installDetail(detail) {
  executor.__setSnapshotFetchForTests(
    async () => ({ ok: true, json: async () => ({ data: [detail] }) }),
    [0, 0, 0, 0, 0],
  );
}

// SOL-USDC bluechip detail: deep TVL, lower fee/TVL, low/zero vol, bin_step 1.
function bluechipDetail(overrides = {}) {
  return {
    token_x: { address: WSOL },
    token_y: { address: USDC },
    tvl: 245_000,
    fee_active_tvl_ratio: 0.04,
    fee_tvl_ratio: 0.04,
    volatility: 0.14,
    dlmm_params: { bin_step: 1 },
    ...overrides,
  };
}

// LST-SOL bluechip detail (the FLAGSHIP shape Draco flagged in paper-soak).
// On-chain mint sort puts the LST on token_x (BASE) and wSOL on token_y (QUOTE) —
// the OPPOSITE leg arrangement from SOL-USDC (where wSOL is token_x). $2.44M TVL.
// This is the exact shape that must clear the maxTvl exemption, else the flagship
// JitoSOL-SOL pool never deploys and the soak only ever tests the small USDC-SOL.
function lstSolDetail(overrides = {}) {
  return {
    token_x: { address: JITOSOL }, // LST = base
    token_y: { address: WSOL },    // wSOL = quote (the single-side-SOL deposit leg)
    tvl: 2_440_000,                // flagship deep TVL >> $150k memecoin ceiling
    fee_active_tvl_ratio: 0.04,
    fee_tvl_ratio: 0.04,
    volatility: 0.2,
    dlmm_params: { bin_step: 4 },
    ...overrides,
  };
}

// Memecoin-shaped deep pool (NOT whitelisted): high TVL must still be rejected.
function memecoinDetail(overrides = {}) {
  return {
    token_x: { address: MEMECOIN },
    token_y: { address: WSOL },
    tvl: 80_000,
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

// Effective screening thresholds the executor reads (set directly on the live config).
function setBluechipMode(on) {
  config.screening.bluechipModeEnabled = on;
  config.screening.bluechipMinFeeTvlRatio = 0.03;
  config.screening.bluechipMaxVolatility = 1.5;
  config.screening.bluechipMaxBinStep = 200;
}
// Memecoin floors (mirror live overlay so the unchanged-path assertions are meaningful).
config.screening.maxTvl = 150_000;
config.screening.minTvl = 0;
config.screening.minFeeActiveTvlRatio = 0.10;
config.screening.minBinStep = 80;
config.screening.maxBinStep = 125;
config.screening.timeframe = "5m";

console.log("\n=== Bluechip executor-gate exemption (money-path) ===\n");

// ── (1) FLAG ON + WHITELIST bluechip → all 3 gates exempt → PASS ──
setBluechipMode(true);
installDetail(bluechipDetail());
{
  const r = await verify({ pool_address: "POOL_SOLUSDC", base_mint: WSOL });
  check("bluechip whitelist (TVL $245k, fee/TVL 0.04, vol 0.14, bin_step 1) → PASS", r.pass === true);
}

// gate-1 maxTvl exempt: even a HUGE TVL bluechip passes
installDetail(bluechipDetail({ tvl: 5_000_000 }));
{
  const r = await verify({ pool_address: "POOL_DEEP", base_mint: WSOL });
  check("bluechip maxTvl EXEMPT — $5M deep pool → PASS", r.pass === true);
}

// ── (1b) FLAGSHIP LST-SOL shape (Draco paper-soak block repro) ──
// JitoSOL-SOL $2.44M: LST=token_x(base), wSOL=token_y(quote). The maxTvl exemption
// MUST resolve the pair as bluechip from this leg arrangement (base from args or the
// detail's token_x, quote from the detail's token_y) and pass. Tested across the
// arg shapes the deploy path can present so the exemption can never silently
// fail-close on the flagship pool (→ block → soak only gets the small USDC-SOL).
installDetail(lstSolDetail());
{
  // base_mint = JITOSOL (screening candidate base == token_x)
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: JITOSOL });
  check("LST-SOL JitoSOL $2.44M (base_mint=JITOSOL) → PASS (maxTvl EXEMPT)", r.pass === true);
}
installDetail(lstSolDetail());
{
  // base_mint = WSOL (bot frames SOL as the deposited base) — both legs still whitelisted
  const r = await verify({ pool_address: "JITOSOL_SOL", base_mint: WSOL });
  check("LST-SOL JitoSOL $2.44M (base_mint=WSOL) → PASS (maxTvl EXEMPT)", r.pass === true);
}
installDetail(lstSolDetail());
{
  // NO base_mint in args → BOTH legs must resolve from the on-chain detail
  const r = await verify({ pool_address: "JITOSOL_SOL" });
  check("LST-SOL JitoSOL $2.44M (no base_mint, legs from detail) → PASS (maxTvl EXEMPT)", r.pass === true);
}

// gate-2 fee/TVL: bluechip floor 0.03 — 0.04 passes, 0.02 rejected
installDetail(bluechipDetail({ fee_active_tvl_ratio: 0.02, fee_tvl_ratio: 0.02 }));
{
  const r = await verify({ pool_address: "POOL_LOWFEE", base_mint: WSOL });
  check("bluechip fee/TVL 0.02 < bluechipMinFeeTvlRatio 0.03 → REJECT", r.pass === false && /bluechipMinFeeTvlRatio/.test(r.reason));
}
installDetail(bluechipDetail({ fee_active_tvl_ratio: 0.035, fee_tvl_ratio: 0.035 }));
{
  const r = await verify({ pool_address: "POOL_OKFEE", base_mint: WSOL });
  check("bluechip fee/TVL 0.035 ≥ 0.03 → PASS", r.pass === true);
}

// gate-3 volatility: bluechip CEILING not floor — vol 0 OK, vol above ceiling rejected
installDetail(bluechipDetail({ volatility: 0 }));
{
  const r = await verify({ pool_address: "POOL_VOL0", base_mint: WSOL });
  check("bluechip vol 0 (stable = GOOD) → PASS (floor exempt)", r.pass === true);
}
installDetail(bluechipDetail({ volatility: null }));
{
  const r = await verify({ pool_address: "POOL_VOLNULL", base_mint: WSOL });
  check("bluechip vol null (stable read) → PASS (floor exempt)", r.pass === true);
}
installDetail(bluechipDetail({ volatility: 2.5 }));
{
  const r = await verify({ pool_address: "POOL_VOLWILD", base_mint: WSOL });
  check("bluechip vol 2.5 > bluechipMaxVolatility 1.5 (de-peg/thin) → REJECT", r.pass === false && /bluechipMaxVolatility/.test(r.reason));
}

// ── (2) WHITELIST NON-NEGOTIABLE — non-bluechip + deep TVL → memecoin maxTvl still bites ──
installDetail(memecoinDetail({ tvl: 245_000 }));
{
  const r = await verify({ pool_address: "POOL_MEME_DEEP", base_mint: MEMECOIN });
  check("non-whitelist + TVL $245k → REJECT (memecoin maxTvl, NOT exempt)", r.pass === false && /maxTvl/.test(r.reason));
}
// LEAK GUARD: a deep-TVL pool in the SAME leg arrangement as LST-SOL (non-whitelist
// base on token_x, wSOL on token_y) must STILL be blocked. Proves the exemption keys
// off the WHITELIST pair, not the leg shape — a $2.44M memecoin-SOL pool is NOT exempt.
installDetail(lstSolDetail({ token_x: { address: MEMECOIN } }));
{
  const r = await verify({ pool_address: "MEME_SOL_DEEP", base_mint: MEMECOIN });
  check("non-whitelist LST-shaped pool $2.44M → REJECT (memecoin maxTvl, exemption ≠ leg-shape)", r.pass === false && /maxTvl/.test(r.reason));
}
// non-whitelist low fee/TVL → memecoin floor 0.10 bites (not bluechip 0.03)
installDetail(memecoinDetail({ tvl: 80_000, fee_active_tvl_ratio: 0.04, fee_tvl_ratio: 0.04 }));
{
  const r = await verify({ pool_address: "POOL_MEME_LOWFEE", base_mint: MEMECOIN });
  check("non-whitelist fee/TVL 0.04 → REJECT (memecoin minFeeActiveTvlRatio 0.10)", r.pass === false && /minFeeActiveTvlRatio/.test(r.reason));
}
// non-whitelist vol 0 → memecoin FLOOR bites (vol must be > 0)
installDetail(memecoinDetail({ tvl: 80_000, volatility: 0 }));
{
  const r = await verify({ pool_address: "POOL_MEME_VOL0", base_mint: MEMECOIN });
  check("non-whitelist vol 0 → REJECT (memecoin vol floor, NOT exempt)", r.pass === false && /unusable/.test(r.reason));
}

// ── (3) FLAG OFF — even a whitelist bluechip pair runs the MEMECOIN path unchanged ──
setBluechipMode(false);
installDetail(bluechipDetail()); // TVL 245k, fee 0.04, vol 0.14
{
  const r = await verify({ pool_address: "POOL_SOLUSDC", base_mint: WSOL });
  // flag OFF → maxTvl bites first (245k > 150k)
  check("flag OFF + whitelist pair → REJECT (memecoin path, maxTvl bites)", r.pass === false && /maxTvl/.test(r.reason));
}

// ── (4) Memecoin normal pool → unchanged (passes its own gates) ──
setBluechipMode(false);
installDetail(memecoinDetail({ tvl: 80_000, fee_active_tvl_ratio: 0.15, fee_tvl_ratio: 0.15, volatility: 4.0, dlmm_params: { bin_step: 100 } }));
{
  const r = await verify({ pool_address: "POOL_MEME_OK", base_mint: MEMECOIN });
  check("memecoin normal (TVL 80k, fee 0.15, vol 4, bin_step 100) → PASS (unchanged)", r.pass === true);
}

// ── (5) FAIL-CLOSED preserved — bluechip with UNKNOWN fee/TVL still rejected ──
setBluechipMode(true);
installDetail(bluechipDetail({ fee_active_tvl_ratio: null, fee_tvl_ratio: null }));
{
  const r = await verify({ pool_address: "POOL_NOFEE", base_mint: WSOL });
  // bluechipMinFeeTvlRatio 0.03 > 0 → missing fee/TVL → reject (anti-pattern #2)
  check("bluechip fee/TVL UNKNOWN → REJECT (fail-closed)", r.pass === false && /bluechipMinFeeTvlRatio/.test(r.reason));
}
// bluechip with unknown TVL → reject (TVL read is unconditional)
installDetail(bluechipDetail({ tvl: null }));
{
  const r = await verify({ pool_address: "POOL_NOTVL", base_mint: WSOL });
  check("bluechip TVL UNKNOWN → REJECT (fail-closed)", r.pass === false && /Could not verify pool TVL/.test(r.reason));
}
// bluechip bin_step garbage → sanity bound still bites inside exemption lane
installDetail(bluechipDetail({ dlmm_params: { bin_step: 0 } }));
{
  const r = await verify({ pool_address: "POOL_BADSTEP", base_mint: WSOL });
  check("bluechip bin_step 0 → REJECT (sanity bound, exemption ≠ no-check)", r.pass === false && /not a positive integer/.test(r.reason));
}

executor.__resetSnapshotFetchForTests();
setBluechipMode(false);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
