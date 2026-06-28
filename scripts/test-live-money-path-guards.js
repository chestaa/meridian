// Vega go-live money-path guards (2026-06-28) — self-check for the two NEW
// invariants closed for the Phase 0 -> Phase 1 transition:
//   1. wSOL-leg chain-side assertion: single-side SOL deploy REFUSED when the
//      pool's tokenY (quote) mint is not wSOL.
//   2. Phase-1 hard cap: live memecoin position size capped at MAX_LIVE_POSITION_SOL
//      regardless of config.risk.maxDeployAmount.
//
// These exercise deployPosition's LIVE path WITHOUT sending a TX: we inject a fake
// pool via the dlmm test hook and let the guards throw BEFORE any sendAndConfirm.
// Run: node scripts/test-live-money-path-guards.js   (expects DRY_RUN unset/false)

import assert from "node:assert";

// Force live path for the guards under test; restore at end.
const prevDryRun = process.env.DRY_RUN;
process.env.DRY_RUN = "false";
// Avoid wallet-loader hard refuse (needs BURNER_WALLET_KEY when live): the guards
// we test throw before getWallet() is reached, so a dummy burner key is enough to
// not trip unrelated init. We never sign/broadcast.
if (!process.env.BURNER_WALLET_KEY) process.env.BURNER_WALLET_KEY = "test-not-used";

const dlmm = await import("../tools/dlmm.js");
const { deployPosition, MAX_LIVE_POSITION_SOL, __setForTests, __resetTests } = dlmm;

assert.strictEqual(MAX_LIVE_POSITION_SOL, 0.05, "Phase-1 cap must be hard-pinned at 0.05 SOL");

const WSOL = "So11111111111111111111111111111111111111112";
const NOT_WSOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC (bluechip)
// A non-bluechip memecoin base so the pool takes the MEMECOIN lane (Phase-1 cap),
// not the bluechip lane. Random non-whitelisted mint.
const MEMECOIN = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9D";

// Minimal fake pool: only the fields the guards read before any TX. baseMint
// non-bluechip → memecoin lane; tokenY (quote) controls the wSOL-leg guard.
function fakePool(tokenYMint, baseMint = MEMECOIN) {
  return {
    lbPair: {
      tokenXMint: { toString: () => baseMint },
      tokenYMint: { toString: () => tokenYMint },
      binStep: 100,
      parameters: { baseFactor: 10000 },
    },
    getActiveBin: async () => ({ binId: 1000 }),
  };
}

assert.strictEqual(typeof __setForTests, "function", "dlmm must export __setForTests hook");

// ── 1. wSOL-leg assertion: tokenY != wSOL must REFUSE (caught as thrown error) ──
// Use a within-cap amount so the cap check passes and the wSOL guard is what fires.
__setForTests({ getPool: async () => fakePool(NOT_WSOL) });
let r1;
try { r1 = await deployPosition({ pool_address: "PoolNonWsol", amount_y: 0.04, bins_below: 35 }); }
catch (e) { r1 = { success: false, error: e.message }; }
assert.strictEqual(r1.success, false, "non-wSOL Y leg must be refused");
assert.ok(/not wSOL|wSOL.*Y leg/i.test(r1.error || ""), `expected wSOL refusal, got: ${r1.error}`);

// ── 2. Phase-1 cap: amount above 0.05 on a wSOL pool must REFUSE ──
__setForTests({ getPool: async () => fakePool(WSOL) });
let r2;
try { r2 = await deployPosition({ pool_address: "PoolWsol", amount_y: 0.2, bins_below: 35 }); }
catch (e) { r2 = { success: false, error: e.message }; }
assert.strictEqual(r2.success, false, "0.2 SOL must exceed the 0.05 Phase-1 cap");
assert.ok(/Phase-1 per-position cap|hard belt/i.test(r2.error || ""), `expected cap refusal, got: ${r2.error}`);

__resetTests();

process.env.DRY_RUN = prevDryRun;
console.log("PASS: live money-path guards (wSOL-leg refusal + Phase-1 0.05 cap)");
