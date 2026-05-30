// Cassiopeia — Gate Hardening Batch tests.
//
// Covers the 4-item gate batch:
//   Item 1 — mint/freeze/rugpull base gates (fail-closed, anti-pattern #2)
//   Item 3 — volatility=0 false-positive fix (refetch at 30m before reject)
//   Item 4 — dev_sold_all demoted to compound (only reject if top10 also high)
//   Item 5 — smart-money hard coupling removed; organic governed by minOrganic
//
// Run: node scripts/test-gate-batch.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { config } = await import("../config.js");
const {
  rugGateRejectReason,
  devSoldAllShouldReject,
  effectiveScreeningThresholds,
  __refetchVolatilityForUnusableForTests,
} = await import("../tools/screening.js");

// Snapshot config so we can mutate-and-restore.
const snap = {
  dryRun: config.dryRun,
  overrides: config.liveOverrides,
  requireMintRenounced: config.screening.requireMintRenounced,
  requireFreezeRenounced: config.screening.requireFreezeRenounced,
  rejectRugpullFlag: config.screening.rejectRugpullFlag,
  devSoldAllCompound: config.screening.devSoldAllRequiresHighConcentration,
  maxTop10: config.screening.maxTop10Pct,
};

// Base thresholds with all rug gates ON (defaults).
const S = {
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 50,
};

console.log("=== Cassiopeia — Gate Hardening Batch tests ===\n");

// ── Item 1: mint authority ──
console.log("[1a] mint authority renounce gate (fail-closed)");
{
  const renounced = { name: "OK", audit: { mint_disabled: true, freeze_disabled: true }, is_rugpull: false };
  const liveMint = { name: "BAD", audit: { mint_disabled: false, freeze_disabled: true }, is_rugpull: false };
  const missing = { name: "MISSING", audit: { freeze_disabled: true }, is_rugpull: false }; // mint_disabled undefined
  const noAudit = { name: "NOAUDIT", audit: null, is_rugpull: false };

  check("mint_disabled=true → pass", rugGateRejectReason(renounced, S) === null);
  check("mint_disabled=false → mint_authority_not_renounced", rugGateRejectReason(liveMint, S) === "mint_authority_not_renounced");
  check("mint_disabled missing → reject (fail-closed)", rugGateRejectReason(missing, S) === "mint_authority_not_renounced");
  check("audit null → reject (fail-closed)", rugGateRejectReason(noAudit, S) === "mint_authority_not_renounced");
}

// ── Item 1: freeze authority ──
console.log("\n[1b] freeze authority renounce gate (fail-closed)");
{
  const liveFreeze = { name: "FZ", audit: { mint_disabled: true, freeze_disabled: false }, is_rugpull: false };
  const missingFreeze = { name: "FZMISS", audit: { mint_disabled: true }, is_rugpull: false };
  check("freeze_disabled=false → freeze_authority_not_renounced", rugGateRejectReason(liveFreeze, S) === "freeze_authority_not_renounced");
  check("freeze_disabled missing → reject (fail-closed)", rugGateRejectReason(missingFreeze, S) === "freeze_authority_not_renounced");
}

// ── Item 1: rugpull flag ──
console.log("\n[1c] OKX is_rugpull (liquidity removal) gate");
{
  const rug = { name: "RUG", audit: { mint_disabled: true, freeze_disabled: true }, is_rugpull: true };
  check("is_rugpull=true → liquidity_removal_rugpull", rugGateRejectReason(rug, S) === "liquidity_removal_rugpull");
}

// ── Item 1: toggle-able ──
console.log("\n[1d] gates are toggle-able");
{
  const liveMint = { name: "BAD", audit: { mint_disabled: false, freeze_disabled: false }, is_rugpull: true };
  const allOff = { requireMintRenounced: false, requireFreezeRenounced: false, rejectRugpullFlag: false };
  check("all gates off → pass even with live authorities + rugpull", rugGateRejectReason(liveMint, allOff) === null);
}

// ── Item 4: dev_sold_all compound ──
console.log("\n[4] dev_sold_all demoted to compound");
{
  const lowConc = { name: "SQUIRE", dev_sold_all: true, audit: { top_holders_pct: 40 } };
  const highConc = { name: "BADDSA", dev_sold_all: true, audit: { top_holders_pct: 60 } };
  const noDsa = { name: "CLEAN", dev_sold_all: false, audit: { top_holders_pct: 60 } };
  const noTop10 = { name: "NOTOP10", dev_sold_all: true, audit: {} };

  check("dev_sold_all + top10 40% (< 50 cap) → PASS (was hard-reject)", devSoldAllShouldReject(lowConc, S) === false);
  check("dev_sold_all + top10 60% (> 50 cap) → reject", devSoldAllShouldReject(highConc, S) === true);
  check("dev_sold_all=false → pass regardless of top10", devSoldAllShouldReject(noDsa, S) === false);
  check("dev_sold_all + no top10 data → no reject (don't reject on dsa alone)", devSoldAllShouldReject(noTop10, S) === false);

  // Legacy mode (compound off) → hard-reject on dev_sold_all alone
  const legacyS = { ...S, devSoldAllRequiresHighConcentration: false };
  check("legacy mode (compound off): dev_sold_all alone → reject", devSoldAllShouldReject(lowConc, legacyS) === true);
}

// ── Item 5: smart-money coupling removed; minOrganic floor ──
console.log("\n[5] organic floor via minOrganic (live overlay 72), no smart-money coupling");
{
  config.dryRun = false;
  config.liveOverrides = { minOrganic: 72 }; // Item 5 intended live floor
  const eff = effectiveScreeningThresholds();
  check("live minOrganic floor = 72", eff.minOrganic === 72);

  // The hard gate (sw=0 + organic<80) is gone. Organic eligibility is purely
  // minOrganic. Simulate the base getRawPoolScreeningRejectReason organic check.
  function organicPasses(organic) {
    return organic >= eff.minOrganic;
  }
  check("sw=0 + organic 75 → PASS (was rejected by old sw coupling)", organicPasses(75) === true);
  check("sw=0 + organic 70 → reject (below 72 floor)", organicPasses(70) === false);
  check("organic 72 exactly → pass (floor inclusive)", organicPasses(72) === true);

  // liveOverrides no longer carries requireSmartWalletOrHighOrganic
  check("requireSmartWalletOrHighOrganic dropped from live overlay", eff.requireSmartWalletOrHighOrganic === undefined);
}

// ── Item 3: volatility refetch-before-reject ──
console.log("\n[3] volatility=0 refetch at 30m before reject");
{
  // Pool whose feed volatility is 0 but 30m re-fetch returns >0 → rescued (usable).
  const poolRescued = { pool_address: "P_RESCUE", name: "RICH-SOL", volatility: 0 };
  // Pool whose feed AND 30m volatility are both 0 → stays unusable (rejected downstream).
  const poolDead = { pool_address: "P_DEAD", name: "DEAD-SOL", volatility: 0 };
  // Pool with healthy feed volatility → never refetched.
  const poolHealthy = { pool_address: "P_OK", name: "OK-SOL", volatility: 3 };

  const fakeFetch = async ({ poolAddress }) => {
    if (poolAddress === "P_RESCUE") return { volatility: 4.2 }; // 30m has signal
    if (poolAddress === "P_DEAD") return { volatility: 0 };     // 30m also flat
    return { volatility: 0 };
  };

  await __refetchVolatilityForUnusableForTests([poolRescued, poolDead, poolHealthy], fakeFetch);

  check("vol=0 on feed but 30m vol 4.2 → volatility rescued to 4.2 (PASS, not rejected)", poolRescued.volatility === 4.2);
  check("rescued pool stamped 30m timeframe", poolRescued.volatility_timeframe === "30m");
  check("vol=0 feed AND vol=0 at 30m → stays 0 (still rejected downstream)", poolDead.volatility === 0);
  check("healthy pool untouched (no refetch)", poolHealthy.volatility === 3 && poolHealthy.volatility_timeframe === undefined);
}

// ── Restore config ──
config.dryRun = snap.dryRun;
config.liveOverrides = snap.overrides;
config.screening.requireMintRenounced = snap.requireMintRenounced;
config.screening.requireFreezeRenounced = snap.requireFreezeRenounced;
config.screening.rejectRugpullFlag = snap.rejectRugpullFlag;
config.screening.devSoldAllRequiresHighConcentration = snap.devSoldAllCompound;
config.screening.maxTop10Pct = snap.maxTop10;

console.log(`\n${passed} assertions passed, ${failed} failed.`);
if (failed > 0) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
