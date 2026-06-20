// Vega — Bluechip income-engine DEPLOY-PATH tests (Opsi B, money-path).
//
// Opsi B = single-side SOL with a WIDE range (large bins_below), bins_above STAYS 0,
// amount_x STAYS 0 (two-sided / amount_x>0 is Opsi A / Phase 2 — NOT this). The
// deploy money path lives in tools/dlmm.deployPosition. This suite drives it through
// the DRY_RUN early-return (no on-chain TX) using the __setForTests getPool seam, so
// every guard below the seam runs against a controllable mock pool.
//
// Covers (the strict checklist from the roadmap):
//   (a) bluechip mode + whitelist pool  → wide deploy ALLOWED (bins_below > 69)
//   (b) bluechip mode + non-whitelist   → wide deploy REFUSED (whitelist privilege gate)
//   (c) flag OFF                        → memecoin path unchanged (no new ceiling, wide
//                                          deploy that was allowed before is STILL allowed)
//   (d) amount_x > 0                    → REFUSED (Opsi B never opens two-sided)
//   (e) MAX_BLUECHIP cap                → bluechip deploy above cap REFUSED; memecoin
//                                          uses its own (larger) maxDeployAmount
//   + whitelist predicate unit checks (pure isBluechipMintPair)
//   + bins_above must stay 0 for single-side (Opsi B invariant)
//
// Run: node scripts/test-bluechip-deploy.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
process.env.DRY_RUN = "true"; // no on-chain TX — we exercise guards then the dry_run return

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { isBluechipMintPair } = await import("../tools/screening.js");
const dlmm = await import("../tools/dlmm.js");
const { config } = await import("../config.js");

// ── Mints (mirror Cassiopeia BLUECHIP_INCOME_MINTS) ──
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMECOIN = "9xyzMEMEcoinMintAddressNotWhitelistedDEADBEEF11"; // not in whitelist

// ── Mock pool factory (only the fields deployPosition reads pre-DRY_RUN return) ──
// Active bin id 0 keeps getPriceOfBinByBinId well-defined; binStep small.
function makeMockPool(baseMint, quoteMint) {
  return {
    lbPair: {
      tokenXMint: { toString: () => baseMint },
      tokenYMint: { toString: () => quoteMint },
      binStep: 20,
      parameters: { baseFactor: 10000 },
    },
    getActiveBin: async () => ({ binId: 0, price: "1" }),
  };
}

function installPool(baseMint, quoteMint) {
  dlmm.__setForTests({ getPool: async () => makeMockPool(baseMint, quoteMint) });
}

async function tryDeploy(args) {
  try {
    const r = await dlmm.deployPosition(args);
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Save original config knobs so each scenario is isolated.
const ORIG = {
  bluechipModeEnabled: config.screening.bluechipModeEnabled,
  bluechipMaxBinsBelow: config.strategy.bluechipMaxBinsBelow,
  maxBluechipPositionSol: config.risk.maxBluechipPositionSol,
  maxBinsBelow: config.strategy.maxBinsBelow,
  minBinsBelow: config.strategy.minBinsBelow,
  maxDeployAmount: config.risk.maxDeployAmount,
};

function restoreConfig() {
  config.screening.bluechipModeEnabled = ORIG.bluechipModeEnabled;
  config.strategy.bluechipMaxBinsBelow = ORIG.bluechipMaxBinsBelow;
  config.risk.maxBluechipPositionSol = ORIG.maxBluechipPositionSol;
  config.strategy.maxBinsBelow = ORIG.maxBinsBelow;
  config.strategy.minBinsBelow = ORIG.minBinsBelow;
  config.risk.maxDeployAmount = ORIG.maxDeployAmount;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n— isBluechipMintPair (pure whitelist predicate) —");
check("SOL/USDC → bluechip pair", isBluechipMintPair(WSOL, USDC) === true);
check("USDC/SOL → bluechip pair (order-independent)", isBluechipMintPair(USDC, WSOL) === true);
check("MEMECOIN/SOL → NOT bluechip (one leg off-list)", isBluechipMintPair(MEMECOIN, WSOL) === false);
check("MEMECOIN/USDC → NOT bluechip", isBluechipMintPair(MEMECOIN, USDC) === false);
check("missing base → fail-closed false", isBluechipMintPair(null, USDC) === false);
check("missing quote → fail-closed false", isBluechipMintPair(WSOL, undefined) === false);
check("both missing → false", isBluechipMintPair("", "") === false);

// ─────────────────────────────────────────────────────────────────────────────
// (a) bluechip mode + whitelist pool → WIDE deploy allowed (bins_below > 69)
console.log("\n— (a) bluechip mode + whitelist pool → wide deploy ALLOWED —");
config.screening.bluechipModeEnabled = true;
config.strategy.bluechipMaxBinsBelow = 250;
config.strategy.maxBinsBelow = 69;
config.strategy.minBinsBelow = 35;
config.risk.maxBluechipPositionSol = 0.45;
installPool(WSOL, USDC);
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.4, bins_below: 200, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("wide bluechip (bins_below=200) accepted", r.ok && r.result?.dry_run === true);
  check("dry-run reports wide_range=true", r.ok && r.result?.would_deploy?.wide_range === true);
  check("dry-run bins_below preserved (200)", r.ok && r.result?.would_deploy?.bins_below === 200);
  check("dry-run bins_above stayed 0 (Opsi B single-side)", r.ok && r.result?.would_deploy?.bins_above === 0);
}
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.4, bins_below: 251, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("bluechip ABOVE bluechipMaxBinsBelow (251>250) refused", !r.ok && /exceeds bluechip ceiling/.test(r.error));
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) bluechip mode + non-whitelist mint → wide deploy REFUSED
console.log("\n— (b) bluechip mode + non-whitelist → wide deploy REFUSED —");
installPool(MEMECOIN, WSOL);
{
  const r = await tryDeploy({ pool_address: "PoolMeme222", amount_y: 0.4, bins_below: 200, bins_above: 0, strategy: "spot", volatility: 4.0 });
  check("non-whitelist wide (bins_below=200) refused", !r.ok && /exceeds memecoin ceiling/.test(r.error));
  check("refusal cites whitelist-only", !r.ok && /bluechip-whitelist only/.test(r.error));
}
{
  // a non-whitelist pool may STILL deploy a normal memecoin range (≤ maxBinsBelow) while bluechip mode is on
  const r = await tryDeploy({ pool_address: "PoolMeme222", amount_y: 0.4, bins_below: 60, bins_above: 0, strategy: "spot", volatility: 4.0 });
  check("non-whitelist NORMAL range (bins_below=60) still allowed in bluechip mode", r.ok && r.result?.dry_run === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) flag OFF → memecoin path unchanged (no new ceiling; prior-allowed wide still allowed)
console.log("\n— (c) flag OFF → memecoin path unchanged (regression) —");
config.screening.bluechipModeEnabled = false;
installPool(WSOL, USDC); // even a bluechip-LOOKING pool gets NO bluechip treatment when flag off
{
  // With the flag OFF there is NO bins ceiling (legacy behavior) — a wide deploy that
  // the legacy path accepted is STILL accepted byte-for-byte.
  const r = await tryDeploy({ pool_address: "PoolAny333", amount_y: 0.4, bins_below: 200, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("flag OFF: wide deploy accepted (no new ceiling = unchanged)", r.ok && r.result?.dry_run === true);
}
{
  // And the bluechip cap is NOT applied when the flag is off — a larger amount is
  // governed only by memecoin maxDeployAmount (the executor layer), not the 0.45 belt.
  const r = await tryDeploy({ pool_address: "PoolAny333", amount_y: 2.0, bins_below: 50, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("flag OFF: amount 2.0 SOL not blocked by bluechip cap", r.ok && r.result?.dry_run === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) amount_x > 0 → REFUSED regardless of mode (Opsi B never opens two-sided)
console.log("\n— (d) amount_x > 0 → REFUSED (Opsi B keeps single-side) —");
config.screening.bluechipModeEnabled = true;
installPool(WSOL, USDC);
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.4, amount_x: 0.1, bins_below: 200, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("bluechip + amount_x>0 refused", !r.ok && /single-side SOL/.test(r.error));
}
config.screening.bluechipModeEnabled = false;
installPool(MEMECOIN, WSOL);
{
  const r = await tryDeploy({ pool_address: "PoolMeme222", amount_y: 0.4, amount_x: 0.1, bins_below: 50, bins_above: 0, strategy: "spot", volatility: 4.0 });
  check("memecoin + amount_x>0 refused (unchanged)", !r.ok && /single-side SOL/.test(r.error));
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) MAX_BLUECHIP cap enforced; memecoin uses its own larger limit
console.log("\n— (e) MAX_BLUECHIP_POSITION_SOL cap enforced —");
config.screening.bluechipModeEnabled = true;
config.risk.maxBluechipPositionSol = 0.45;
installPool(WSOL, USDC);
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.46, bins_below: 100, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("bluechip 0.46 SOL (>0.45 cap) refused", !r.ok && /exceeds the bluechip cap/.test(r.error));
}
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.45, bins_below: 100, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("bluechip exactly 0.45 SOL (== cap) accepted", r.ok && r.result?.dry_run === true);
}
{
  // config tunable can TIGHTEN below the belt — set 0.30, expect 0.40 refused
  config.risk.maxBluechipPositionSol = 0.30;
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.40, bins_below: 100, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("config tightens cap to 0.30 → 0.40 refused", !r.ok && /exceeds the bluechip cap 0.3/.test(r.error));
}
{
  // config CANNOT loosen above the hard belt — set 5.0, belt still caps at 0.45
  config.risk.maxBluechipPositionSol = 5.0;
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.5, bins_below: 100, bins_above: 0, strategy: "spot", volatility: 0.1 });
  check("config 5.0 cannot exceed hard belt → 0.5 still refused", !r.ok && /exceeds the bluechip cap 0.45/.test(r.error));
}
config.risk.maxBluechipPositionSol = 0.45;
{
  // memecoin (flag still on, non-whitelist pool) is NOT subject to the bluechip cap —
  // a 1.0 SOL memecoin deploy passes the dlmm path (memecoin maxDeployAmount governs).
  installPool(MEMECOIN, WSOL);
  const r = await tryDeploy({ pool_address: "PoolMeme222", amount_y: 1.0, bins_below: 50, bins_above: 0, strategy: "spot", volatility: 4.0 });
  check("memecoin 1.0 SOL not blocked by bluechip cap (own limit applies)", r.ok && r.result?.dry_run === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// bins_above invariant (Opsi B single-side must keep bins_above=0)
console.log("\n— Opsi B invariant: bins_above must stay 0 for single-side —");
config.screening.bluechipModeEnabled = true;
installPool(WSOL, USDC);
{
  const r = await tryDeploy({ pool_address: "PoolBluechip111", amount_y: 0.4, bins_below: 100, bins_above: 10, strategy: "spot", volatility: 0.1 });
  check("bluechip + bins_above>0 refused (single-side only)", !r.ok && /cannot use bins_above/.test(r.error));
}

// ── teardown ──
dlmm.__resetTests();
restoreConfig();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
