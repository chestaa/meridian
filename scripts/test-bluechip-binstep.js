// Vega — Bluechip DEPLOY-SIDE binStep exemption tests (Opsi B, money-path).
//
// ROOT BLOCKER (Lyra): bluechip never deployed — SOL-USDC has bin_step=1, far below the
// memecoin minBinStep (80), so the executor binStep safety gate refused EVERY bluechip
// deploy ("Pool bin_step 1 is below configured minBinStep 80"). FIX: when bluechip mode
// is ON AND the pair is a WHITELIST bluechip pair, the memecoin [minBinStep,maxBinStep]
// floor/ceiling is EXEMPTED — a sane absolute bound (0 < bin_step <= bluechipMaxBinStep,
// integer) still applies (fail-closed). Whitelist is NON-NEGOTIABLE: a non-whitelist pair
// NEVER gets the exemption. Flag OFF → memecoin floor byte-for-byte unchanged.
//
// Covers:
//   (1) pure isBluechipBinStepExempt decision (flag/whitelist/detail-resolve/fail-closed)
//   (2) pure bluechipBinStepSanityReject absolute bound
//   (3) full validateDeployPoolThresholds: SOL-USDC bin_step=1 LOLOS when exempt;
//       non-whitelist bin_step=1 REFUSE; memecoin bin_step=50 REFUSE (outside [80,200]);
//       flag OFF → bluechip-looking bin_step=1 REFUSE (regression: legacy floor)
//
// Run: node scripts/test-bluechip-binstep.js

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

const {
  __isBluechipBinStepExemptForTests: isExempt,
  __bluechipBinStepSanityRejectForTests: sanityReject,
  __validateDeployPoolThresholdsForTests: validateThresholds,
} = executor;

// ── Mints ──
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMECOIN = "9xyzMEMEcoinMintAddressNotWhitelistedDEADBEEF11";

// Save config knobs.
const ORIG = {
  bluechipModeEnabled: config.screening.bluechipModeEnabled,
  bluechipMaxBinStep: config.screening.bluechipMaxBinStep,
  minBinStep: config.screening.minBinStep,
  maxBinStep: config.screening.maxBinStep,
  minTvl: config.screening.minTvl,
  maxTvl: config.screening.maxTvl,
  minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
  timeframe: config.screening.timeframe,
};
function restore() {
  config.screening.bluechipModeEnabled = ORIG.bluechipModeEnabled;
  config.screening.bluechipMaxBinStep = ORIG.bluechipMaxBinStep;
  config.screening.minBinStep = ORIG.minBinStep;
  config.screening.maxBinStep = ORIG.maxBinStep;
  config.screening.minTvl = ORIG.minTvl;
  config.screening.maxTvl = ORIG.maxTvl;
  config.screening.minFeeActiveTvlRatio = ORIG.minFeeActiveTvlRatio;
  config.screening.timeframe = ORIG.timeframe;
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) isBluechipBinStepExempt — pure decision
console.log("\n— (1) isBluechipBinStepExempt (flag + WHITELIST + fail-closed) —");
config.screening.bluechipModeEnabled = true;
check("flag ON + SOL-USDC args → exempt", isExempt({ base_mint: WSOL, quote_mint: USDC }) === true);
check("flag ON + USDC-SOL (order indep) → exempt", isExempt({ base_mint: USDC, quote_mint: WSOL }) === true);
check("flag ON + MEMECOIN-SOL → NOT exempt (whitelist)", isExempt({ base_mint: MEMECOIN, quote_mint: WSOL }) === false);
check("flag ON + only base_mint (no quote) → NOT exempt (fail-closed)", isExempt({ base_mint: WSOL }) === false);
check("flag ON + quote resolved from DETAIL → exempt", isExempt({ base_mint: WSOL }, { token_y: { address: USDC } }) === true);
check("flag ON + both legs from detail → exempt", isExempt({}, { token_x: { address: WSOL }, token_y: { address: USDC } }) === true);
check("flag ON + detail non-whitelist quote → NOT exempt", isExempt({ base_mint: WSOL }, { token_y: { address: MEMECOIN } }) === false);
config.screening.bluechipModeEnabled = false;
check("flag OFF + SOL-USDC → NOT exempt (master flag)", isExempt({ base_mint: WSOL, quote_mint: USDC }) === false);
check("flag OFF + detail bluechip → NOT exempt", isExempt({}, { token_x: { address: WSOL }, token_y: { address: USDC } }) === false);

// ─────────────────────────────────────────────────────────────────────────────
// (2) bluechipBinStepSanityReject — absolute bound (applies even when exempt)
console.log("\n— (2) bluechipBinStepSanityReject (sane absolute bound) —");
config.screening.bluechipMaxBinStep = 200;
check("bin_step=1 → acceptable (null reject)", sanityReject(1) === null);
check("bin_step=10 → acceptable", sanityReject(10) === null);
check("bin_step=200 (== ceil) → acceptable", sanityReject(200) === null);
check("bin_step=201 (> ceil) → REJECT", typeof sanityReject(201) === "string" && /exceeds bluechip ceiling/.test(sanityReject(201)));
check("bin_step=0 → REJECT (not positive)", typeof sanityReject(0) === "string" && /not a positive integer/.test(sanityReject(0)));
check("bin_step=-5 → REJECT (negative)", typeof sanityReject(-5) === "string");
check("bin_step=2.5 → REJECT (non-integer)", typeof sanityReject(2.5) === "string");
check("bin_step=NaN → REJECT (non-finite)", typeof sanityReject(NaN) === "string");
check("bin_step=null → null (caller's null-guard handles)", sanityReject(null) === null);

// ─────────────────────────────────────────────────────────────────────────────
// (3) Full validateDeployPoolThresholds with mocked on-chain detail fetch.
console.log("\n— (3) validateDeployPoolThresholds end-to-end (binStep gate) —");

// Mock global.fetch — fetchFreshPoolDetail reads { data: [detail] }. We return a deep,
// healthy SOL-USDC-shaped detail and vary bin_step + mints per scenario.
const _realFetch = global.fetch;
function mockDetailFetch(detail) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [detail] }),
  });
}
function makeDetail({ binStep, baseMint, quoteMint }) {
  return {
    tvl: 500_000,
    active_tvl: 500_000,
    volatility: 0.5,                       // bluechip low-vol is fine (vol>0 passes the >0 guard)
    fee_active_tvl_ratio: 0.05,
    dlmm_params: { bin_step: binStep },
    token_x: { address: baseMint },
    token_y: { address: quoteMint },
    base: { mint: baseMint },
    quote: { mint: quoteMint },
  };
}

// Healthy non-binStep thresholds so ONLY the binStep branch decides pass/fail.
config.screening.minBinStep = 80;
config.screening.maxBinStep = 200;
config.screening.bluechipMaxBinStep = 200;
config.screening.minTvl = 0;
config.screening.maxTvl = 0;          // 0 = off
config.screening.minFeeActiveTvlRatio = 0;
config.screening.timeframe = "5m";    // == volatility tf → no secondary refetch

// (3a) bluechip ON + SOL-USDC + bin_step=1 → LOLOS (exempt)
config.screening.bluechipModeEnabled = true;
mockDetailFetch(makeDetail({ binStep: 1, baseMint: WSOL, quoteMint: USDC }));
{
  const r = await validateThresholds({ pool_address: "P1", base_mint: WSOL, quote_mint: USDC });
  check("bluechip ON + SOL-USDC bin_step=1 → PASS (exempt)", r.pass === true);
}

// (3a') exempt resolved from DETAIL mints alone (args carry no quote_mint)
mockDetailFetch(makeDetail({ binStep: 1, baseMint: WSOL, quoteMint: USDC }));
{
  const r = await validateThresholds({ pool_address: "P1b", base_mint: WSOL });
  check("bluechip ON + bin_step=1, quote from detail → PASS (exempt)", r.pass === true);
}

// (3b) bluechip ON + NON-whitelist + bin_step=1 → REFUSE (whitelist guard → memecoin floor)
mockDetailFetch(makeDetail({ binStep: 1, baseMint: MEMECOIN, quoteMint: WSOL }));
{
  const r = await validateThresholds({ pool_address: "P2", base_mint: MEMECOIN, quote_mint: WSOL });
  check("bluechip ON + non-whitelist bin_step=1 → REFUSE", r.pass === false && /below configured minBinStep/.test(r.reason));
}

// (3c) bluechip ON + whitelist but bin_step over the bluechip ceiling → REFUSE (sanity bound)
mockDetailFetch(makeDetail({ binStep: 201, baseMint: WSOL, quoteMint: USDC }));
{
  const r = await validateThresholds({ pool_address: "P2c", base_mint: WSOL, quote_mint: USDC });
  check("bluechip ON + SOL-USDC bin_step=201 (>ceil) → REFUSE (sanity)", r.pass === false && /exceeds bluechip ceiling/.test(r.reason));
}

// (3d) memecoin (whitelist FALSE) bin_step=50 → REFUSE (outside [80,200]) — unchanged
mockDetailFetch(makeDetail({ binStep: 50, baseMint: MEMECOIN, quoteMint: WSOL }));
{
  const r = await validateThresholds({ pool_address: "P3", base_mint: MEMECOIN, quote_mint: WSOL });
  check("memecoin bin_step=50 → REFUSE (below minBinStep 80)", r.pass === false && /below configured minBinStep 80/.test(r.reason));
}

// (3e) memecoin bin_step=100 (inside [80,200]) → PASS (sanity check that the floor isn't broken)
mockDetailFetch(makeDetail({ binStep: 100, baseMint: MEMECOIN, quoteMint: WSOL }));
{
  const r = await validateThresholds({ pool_address: "P3b", base_mint: MEMECOIN, quote_mint: WSOL });
  check("memecoin bin_step=100 (in range) → PASS", r.pass === true);
}

// (3f) FLAG OFF + SOL-USDC + bin_step=1 → REFUSE (regression: legacy floor, no exemption)
config.screening.bluechipModeEnabled = false;
mockDetailFetch(makeDetail({ binStep: 1, baseMint: WSOL, quoteMint: USDC }));
{
  const r = await validateThresholds({ pool_address: "P4", base_mint: WSOL, quote_mint: USDC });
  check("FLAG OFF + SOL-USDC bin_step=1 → REFUSE (regression, legacy floor)", r.pass === false && /below configured minBinStep 80/.test(r.reason));
}

// (3g) FLAG OFF + memecoin bin_step=100 → PASS (regression: legacy memecoin path unchanged)
mockDetailFetch(makeDetail({ binStep: 100, baseMint: MEMECOIN, quoteMint: WSOL }));
{
  const r = await validateThresholds({ pool_address: "P4b", base_mint: MEMECOIN, quote_mint: WSOL });
  check("FLAG OFF + memecoin bin_step=100 → PASS (regression)", r.pass === true);
}

global.fetch = _realFetch;
restore();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
