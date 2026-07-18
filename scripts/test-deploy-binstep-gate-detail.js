// Vega 🔥 — Pre-deploy bin_step GATE: authoritative deep-exempt verdict threading.
//
// ROOT-CAUSE REPRO (Draco VPS paper lane, cbBTC-SOL 2026-07-18 @ 6adc72ba):
//   Orion judged cbBTC-SOL ENTER (conf 72). Deploy was blocked by:
//     "[SAFETY_BLOCK] deploy_position blocked: bin_step 2 is outside the allowed range of [80-200]."
//   The pool had ALREADY cleared validateDeployPoolThresholds (its on-chain bin_step 2
//   passed the deep-exempt sanity branch). The SECOND bin_step gate in runSafetyChecks
//   then re-derived the exemption from `args` ALONE — but the agent's deploy call omitted
//   the OPTIONAL base_mint, so the two-sided-paper-institutional exemption fail-closed to
//   FALSE and the MEMECOIN [80-200] range fired. The two checks disagreed only because one
//   got the on-chain `detail` and one did not.
//
//   THE TELL: if the lane had truly been inactive, validateDeployPoolThresholds would have
//   rejected FIRST with "bin_step 2 is below configured minBinStep 80" (a DIFFERENT string).
//   The observed "[80-200] RANGE" message exists ONLY at the runSafetyChecks gate → proof
//   the pool was deep-exempt but the second gate lost that verdict.
//
// FIX PROVEN HERE: validateDeployPoolThresholds returns { pass, isDeepExempt }; the second
//   gate consumes it via the pure deployBinStepGateReason. This test chains the two exactly
//   as runSafetyChecks does — WITHOUT the network-bound getMyPositions/circuit reads — so
//   the exact failing decision path is replicated deterministically.
//
// SCOPE PROOFS: exemption fires ONLY in the two-sided PAPER lane for a curated base;
//   memecoin bin_step 2 STILL rejects; LIVE / flag-off keep the memecoin range; the deep
//   sanity bound (0/neg/non-int/over-ceiling) still bites inside the exempt lane.
//
// Run: node scripts/test-deploy-binstep-gate-detail.js

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

const WSOL    = "So11111111111111111111111111111111111111112";
const USDC    = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const CBBTC   = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"; // Draco on-chain verified
const CBBTC_TYPOSQUAT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMiK";
const DEGEN   = "Deg3nMemeCoinAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ── VPS-matching config (minBinStep 80 / maxBinStep 200 → the "[80-200]" runtime range) ──
config.screening.maxTvl = 150_000;
config.screening.minTvl = 0;
config.screening.minFeeActiveTvlRatio = 0.13;
config.screening.bluechipMinFeeTvlRatio = 0.03;
config.screening.bluechipMaxVolatility = 1.5;
config.screening.bluechipMaxBinStep = 200;
config.screening.minBinStep = 80;
config.screening.maxBinStep = 200;
config.screening.timeframe = "1h";
config.screening.bluechipModeEnabled = false; // isolate: NOT via bluechip income mode

function setPaperLane(on) {
  config.strategy = config.strategy || {};
  config.strategy.twoSidedEnabled = on;
  config.strategy.twoSidedPaperOnly = true; // never authorize live two-sided here
}

function installDetail(detail) {
  executor.__setSnapshotFetchForTests(
    async () => ({ ok: true, json: async () => ({ data: [detail] }) }),
    [0, 0, 0, 0, 0],
  );
}

// EXACT runtime pool: cbBTC = token_x (BASE), wSOL = token_y (QUOTE). tvl $63,382,
// bin_step 2 — the values Draco reported. Small pool (well UNDER maxTvl 150k), calm vol.
function cbbtcSolDetail(overrides = {}) {
  return {
    token_x: { address: CBBTC },
    token_y: { address: WSOL },
    tvl: 63_382,
    fee_active_tvl_ratio: 0.05,
    fee_tvl_ratio: 0.05,
    volatility: 0.3,
    dlmm_params: { bin_step: 2 },
    ...overrides,
  };
}

async function verify(args) {
  return executor.__validateDeployPoolThresholdsForTests(args);
}

// Replicate the EXACT runSafetyChecks binStep decision: resolve the lane verdict via
// validateDeployPoolThresholds (with on-chain detail), then run the pure gate on the
// LLM-supplied args — chained precisely as executor.js:1552 now does.
async function runtimeBinStepDecision(args) {
  const t = await verify(args);
  if (!t.pass) return { blockedByThresholds: true, reason: t.reason };
  const reason = executor.deployBinStepGateReason(
    args, t.isDeepExempt, config.screening.minBinStep, config.screening.maxBinStep,
  );
  return { blockedByThresholds: false, isDeepExempt: t.isDeepExempt, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. RUNTIME REPRO — cbBTC-SOL, bin_step 2, NO base_mint (the exact failing args) ===\n");
setPaperLane(true);
process.env.DRY_RUN = "true";

installDetail(cbbtcSolDetail());
{
  // The agent/judge deploy call as it actually arrived: pool_address + bin_step, NO base_mint.
  const args = { pool_address: "CBBTC_SOL", bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("validateDeployPoolThresholds passes cbBTC-SOL as DEEP-EXEMPT (on-chain legs)", d.isDeepExempt === true);
  check("POST-FIX: bin_step 2 + no base_mint → binStep gate PASS (no false [80-200] block)", d.reason === null);
}

// The pre-fix behavior, isolated: deriving the exemption from args ALONE (no detail) →
// fail-closed FALSE → the memecoin range fires. This is the bug the fix removes.
check("BUG WITNESS: args-only exemption (no base_mint, no detail) → FALSE (why it broke)",
  executor.__isTwoSidedPaperExemptForTests({ pool_address: "CBBTC_SOL", bin_step: 2 }) === false);
check("BUG WITNESS: memecoin-range gate on a FALSE verdict reproduces the exact block string",
  executor.deployBinStepGateReason({ bin_step: 2 }, false, 80, 200)
    === "bin_step 2 is outside the allowed range of [80-200].");

// base_mint PRESENT should of course also pass (belt): verdict true either way.
installDetail(cbbtcSolDetail());
{
  const args = { pool_address: "CBBTC_SOL", base_mint: CBBTC, bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("cbBTC-SOL WITH base_mint → deep-exempt + binStep PASS", d.isDeepExempt === true && d.reason === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 2. MEMECOIN bin_step 2 STILL REJECTS (scope: memecoin path byte-unchanged) ===\n");
installDetail(cbbtcSolDetail({ token_x: { address: DEGEN }, fee_active_tvl_ratio: 0.15, fee_tvl_ratio: 0.15, volatility: 4.0 }));
{
  // A memecoin base with bin_step 2 — the deep-exempt lane does NOT apply. Threshold verify
  // rejects on the ON-CHAIN bin_step first (below minBinStep 80); prove the DIFFERENT string.
  const args = { pool_address: "MEME_SOL", base_mint: DEGEN, bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("memecoin on-chain bin_step 2 → threshold verify REJECT (below minBinStep, NOT range)",
    d.blockedByThresholds === true && /below configured minBinStep/.test(d.reason));
}
// Direct gate proof: FALSE verdict + LLM bin_step 2 → memecoin [80-200] range reject.
check("deployBinStepGateReason(memecoin verdict=false, bin_step 2) → [80-200] reject",
  executor.deployBinStepGateReason({ bin_step: 2 }, false, 80, 200)
    === "bin_step 2 is outside the allowed range of [80-200].");
check("deployBinStepGateReason(memecoin verdict=false, bin_step 100 in-range) → null (pass)",
  executor.deployBinStepGateReason({ bin_step: 100 }, false, 80, 200) === null);
check("deployBinStepGateReason(memecoin verdict=false, bin_step 250 over-range) → reject",
  executor.deployBinStepGateReason({ bin_step: 250 }, false, 80, 200)
    === "bin_step 250 is outside the allowed range of [80-200].");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 3. DEEP-EXEMPT SANITY BOUND still bites (exemption ≠ no-check) ===\n");
check("deep-exempt + bin_step 2 → null (fine step passes)",
  executor.deployBinStepGateReason({ bin_step: 2 }, true, 80, 200) === null);
check("deep-exempt + bin_step 1 → null (SOL-USDC fine step)",
  executor.deployBinStepGateReason({ bin_step: 1 }, true, 80, 200) === null);
check("deep-exempt + bin_step 0 → REJECT (not a positive integer)",
  /not a positive integer/.test(executor.deployBinStepGateReason({ bin_step: 0 }, true, 80, 200) || ""));
check("deep-exempt + bin_step -2 → REJECT (negative)",
  /not a positive integer/.test(executor.deployBinStepGateReason({ bin_step: -2 }, true, 80, 200) || ""));
check("deep-exempt + bin_step 2.5 → REJECT (non-integer)",
  /not a positive integer/.test(executor.deployBinStepGateReason({ bin_step: 2.5 }, true, 80, 200) || ""));
check("deep-exempt + bin_step 999 → REJECT (over bluechip ceiling)",
  /exceeds bluechip ceiling/.test(executor.deployBinStepGateReason({ bin_step: 999 }, true, 80, 200) || ""));
check("deep-exempt + bin_step MISSING → null (caller's null-guard owns unknown step)",
  executor.deployBinStepGateReason({}, true, 80, 200) === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. FAIL-CLOSED verdict — non-true isDeepExempt → memecoin range (never a skip) ===\n");
check("verdict undefined → memecoin range (bin_step 2 → reject)",
  executor.deployBinStepGateReason({ bin_step: 2 }, undefined, 80, 200)
    === "bin_step 2 is outside the allowed range of [80-200].");
check("verdict null → memecoin range",
  executor.deployBinStepGateReason({ bin_step: 2 }, null, 80, 200)
    === "bin_step 2 is outside the allowed range of [80-200].");
check("verdict 'true' (string, not boolean) → memecoin range (strict === true only)",
  executor.deployBinStepGateReason({ bin_step: 2 }, "true", 80, 200)
    === "bin_step 2 is outside the allowed range of [80-200].");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 5. LANE ISOLATION — LIVE / flag-off → cbBTC NOT deep-exempt → memecoin range ===\n");
// Clear the memecoin fee/vol floors (fee 0.15 > 0.13, vol 4.0 > 0) and stay under maxTvl
// so the ON-CHAIN bin_step (2 < minBinStep 80) is the ISOLATED rejecter — proving the lane
// is NOT exempt in live/flag-off (an exempt lane would pass bin_step 2 via the sanity bound).
function cbbtcSolMemecoinFeeOk(overrides = {}) {
  return cbbtcSolDetail({ fee_active_tvl_ratio: 0.15, fee_tvl_ratio: 0.15, volatility: 4.0, ...overrides });
}
process.env.DRY_RUN = "false";
installDetail(cbbtcSolMemecoinFeeOk());
{
  const args = { pool_address: "CBBTC_SOL", base_mint: CBBTC, bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("LIVE: cbBTC-SOL NOT deep-exempt → threshold verify REJECT (below minBinStep 80)",
    d.blockedByThresholds === true && /below configured minBinStep/.test(d.reason));
}
process.env.DRY_RUN = "true";
setPaperLane(false);
installDetail(cbbtcSolMemecoinFeeOk());
{
  const args = { pool_address: "CBBTC_SOL", base_mint: CBBTC, bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("flag OFF: cbBTC-SOL NOT deep-exempt → threshold verify REJECT (below minBinStep 80)",
    d.blockedByThresholds === true && /below configured minBinStep/.test(d.reason));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 6. TYPOSQUAT / non-curated base → NOT deep-exempt (fail-closed identity) ===\n");
setPaperLane(true);
installDetail(cbbtcSolDetail({ token_x: { address: CBBTC_TYPOSQUAT }, fee_active_tvl_ratio: 0.15, fee_tvl_ratio: 0.15, volatility: 4.0 }));
{
  const args = { pool_address: "CBBTC_TYPO_SOL", base_mint: CBBTC_TYPOSQUAT, bin_step: 2, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("cbBTC typosquat base (1 char off) → NOT deep-exempt → threshold REJECT (below minBinStep)",
    d.blockedByThresholds === true && /below configured minBinStep/.test(d.reason));
}
// LST curated base is ALSO deep-exempt in the paper lane (regression: LST lane intact).
installDetail(cbbtcSolDetail({ token_x: { address: JITOSOL }, dlmm_params: { bin_step: 4 } }));
{
  const args = { pool_address: "JITOSOL_SOL", bin_step: 4, amount_y: 0.2, bins_below: 69, bins_above: 0 };
  const d = await runtimeBinStepDecision(args);
  check("LST JitoSOL-SOL (no base_mint, legs from detail) → deep-exempt + binStep PASS",
    d.isDeepExempt === true && d.reason === null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 7. VOLATILITY GATE — same fix class: deep stable pair reads ~0 (GOOD), not 'unusable' ===\n");
// MEMECOIN lane: vol > 0 FLOOR (byte-unchanged) — 0 / negative / garbage refused.
check("memecoin verdict=false + vol 0 → REJECT (memecoin >0 floor unchanged)",
  /volatility 0 is invalid/.test(executor.deployVolatilityGateReason({ volatility: 0 }, false) || ""));
check("memecoin verdict=false + vol -1 → REJECT",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: -1 }, false) || ""));
check("memecoin verdict=false + vol NaN → REJECT",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: NaN }, false) || ""));
check("memecoin verdict=false + vol 4.0 → null (healthy memecoin passes)",
  executor.deployVolatilityGateReason({ volatility: 4.0 }, false) === null);
// DEEP-EXEMPT lane: vol is a CEILING (enforced on-chain) — a stable ~0 read is GOOD.
check("deep-exempt + vol 0 → null (stable pair reads ~0, GOOD — NOT a false 'unusable' block)",
  executor.deployVolatilityGateReason({ volatility: 0 }, true) === null);
check("deep-exempt + vol 0.3 (cbBTC calm) → null",
  executor.deployVolatilityGateReason({ volatility: 0.3 }, true) === null);
check("deep-exempt + vol -1 → REJECT (negative is still garbage, fail-closed)",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: -1 }, true) || ""));
check("deep-exempt + vol NaN → REJECT (non-finite garbage, fail-closed)",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: NaN }, true) || ""));
// Absent volatility → the caller's other guards own it (null here, not a block).
check("vol absent (deep) → null", executor.deployVolatilityGateReason({}, true) === null);
check("vol absent (memecoin) → null", executor.deployVolatilityGateReason({}, false) === null);
// FAIL-CLOSED: non-true verdict falls back to the memecoin >0 floor.
check("verdict undefined + vol 0 → REJECT (fail-closed to memecoin floor)",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: 0 }, undefined) || ""));
check("verdict 'true' string + vol 0 → REJECT (strict === true only)",
  /is invalid/.test(executor.deployVolatilityGateReason({ volatility: 0 }, "true") || ""));

executor.__resetSnapshotFetchForTests();
setPaperLane(false);
process.env.DRY_RUN = "true";

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
