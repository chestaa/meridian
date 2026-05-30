// scripts/test-damm-v2.js
// Vega 🔥 — DAMM v2 idle-reserve parking (item 8) money-logic coverage.
//
// Asserts (no SDK install required — scaffold path):
//   - computeParkableSol: only idle SOL ABOVE gas + LP-committed + LP-headroom
//     is parkable; gas/LP funds are NEVER touched.
//   - HARDCAP: idle > maxParkSol → clamped to maxParkSol.
//   - already-parked headroom: total parked never exceeds maxParkSol.
//   - dust gate: idle below minIdleToPark → no park.
//   - fail-safe: NaN / negative / missing balance → no park.
//   - flag OFF (default) → deployToDammV2 is a no-op (no parking).
//   - DRY_RUN=true → no-op dry_run result, no live send.
//   - deployToDammV2 hardcap clamp: request > maxParkSol → clamped down.
//   - withdraw: DRY_RUN no-op shape; invalid id rejected.
//   - SDK absent → live path fail-safe no-op (sdk_not_installed).

import assert from "node:assert/strict";

const { computeParkableSol, deployToDammV2, withdrawFromDammV2, getDammV2Yield }
  = await import("../tools/damm-v2.js");

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

// Shared config seam: gasReserve 0.2, maxParkSol 0.3, minIdleToPark 0.1.
function cfg(over = {}) {
  return {
    management: { gasReserve: 0.2, ...(over.management || {}) },
    damm: { enabled: false, maxParkSol: 0.3, poolAddress: null, minIdleToPark: 0.1, ...(over.damm || {}) },
  };
}

console.log("\n=== computeParkableSol — idle reserve math ===");

check("only idle above gas reserve is parkable (no LP)", () => {
  // wallet 1.0, gas 0.2, no LP → idle 0.8, clamp to maxParkSol 0.3
  const r = computeParkableSol({ walletSol: 1.0, cfg: cfg() });
  assert.equal(r.reason, "ok");
  assert.equal(r.idle, 0.8);
  assert.equal(r.parkable, 0.3); // HARDCAP clamp
});

check("NEVER touches gas reserve", () => {
  // wallet exactly == gas reserve → idle 0 → no park
  const r = computeParkableSol({ walletSol: 0.2, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "no_idle_above_reserves");
});

check("NEVER touches active-LP committed funds", () => {
  // wallet 1.0, gas 0.2, LP committed 0.7 → idle 0.1 (== minIdle) parkable
  const r = computeParkableSol({ walletSol: 1.0, lpCommittedSol: 0.7, cfg: cfg() });
  assert.equal(r.idle, 0.1);
  assert.equal(r.parkable, 0.1); // below cap, full idle parkable
  assert.equal(r.reason, "ok");
});

check("NEVER touches LP deploy headroom", () => {
  // wallet 2.0, gas 0.2, LP committed 0.5, headroom 1.2 → idle 0.1
  const r = computeParkableSol({ walletSol: 2.0, lpCommittedSol: 0.5, lpHeadroomSol: 1.2, cfg: cfg() });
  assert.equal(r.idle, 0.1);
  assert.equal(r.parkable, 0.1);
});

check("LP commit + headroom can fully consume idle → no park", () => {
  const r = computeParkableSol({ walletSol: 1.0, lpCommittedSol: 0.5, lpHeadroomSol: 0.5, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "no_idle_above_reserves");
});

console.log("\n=== HARDCAP ===");

check("idle far above cap → clamped to maxParkSol", () => {
  const r = computeParkableSol({ walletSol: 5.0, cfg: cfg() });
  assert.equal(r.parkable, 0.3);
  assert.ok(r.parkable <= 0.3, "never above cap");
});

check("custom maxParkSol respected", () => {
  const r = computeParkableSol({ walletSol: 5.0, cfg: cfg({ damm: { maxParkSol: 0.15 } }) });
  assert.equal(r.parkable, 0.15);
});

check("already-parked reduces headroom (total never exceeds cap)", () => {
  // 0.25 already parked, cap 0.3 → only 0.05 more parkable even though idle big
  const r = computeParkableSol({ walletSol: 5.0, alreadyParkedSol: 0.25, cfg: cfg() });
  assert.equal(r.parkable, 0.05);
});

check("cap already reached → no further park", () => {
  const r = computeParkableSol({ walletSol: 5.0, alreadyParkedSol: 0.3, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "hardcap_already_reached");
});

check("INVARIANT: parkable <= maxParkSol across a sweep", () => {
  for (const wallet of [0, 0.21, 0.3, 0.5, 1, 3, 10, 100]) {
    for (const parked of [0, 0.1, 0.29, 0.3]) {
      const r = computeParkableSol({ walletSol: wallet, alreadyParkedSol: parked, cfg: cfg() });
      assert.ok(r.parkable <= 0.3 + 1e-9, `parkable ${r.parkable} > cap @ wallet=${wallet} parked=${parked}`);
      assert.ok(r.parkable >= 0, "parkable never negative");
    }
  }
});

console.log("\n=== dust + fail-safe ===");

check("idle below minIdleToPark → no park (dust)", () => {
  // wallet 0.25, gas 0.2 → idle 0.05 < minIdle 0.1
  const r = computeParkableSol({ walletSol: 0.25, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "idle_below_min_threshold");
});

check("NaN wallet → fail-safe no park", () => {
  const r = computeParkableSol({ walletSol: NaN, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "wallet_balance_unknown");
});

check("undefined wallet → fail-safe no park", () => {
  const r = computeParkableSol({ cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "wallet_balance_unknown");
});

check("negative wallet → fail-safe no park", () => {
  const r = computeParkableSol({ walletSol: -1, cfg: cfg() });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "wallet_balance_unknown");
});

check("non-positive maxParkSol → fail-safe no park", () => {
  const r = computeParkableSol({ walletSol: 5, cfg: cfg({ damm: { maxParkSol: 0 } }) });
  assert.equal(r.parkable, 0);
  assert.equal(r.reason, "maxParkSol_not_positive");
});

console.log("\n=== deployToDammV2 — gates ===");

const PREV_DRY = process.env.DRY_RUN;

check("flag OFF (default) → no-op, no parking", async () => {
  // config.damm.enabled defaults false in live config
  const r = await deployToDammV2(0.1, "PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.equal(r.no_op, true);
  assert.equal(r.parked, false);
  assert.equal(r.reason, "damm_disabled");
});

// To exercise deeper gates we need enabled=true. Mutate the live config object
// in place (single-process test) then restore.
const { config: liveConfig } = await import("../config.js");
const savedEnabled = liveConfig.damm.enabled;
const savedPool = liveConfig.damm.poolAddress;

check("enabled + DRY_RUN=true → dry_run no-op (no send)", async () => {
  liveConfig.damm.enabled = true;
  liveConfig.damm.poolAddress = "PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.DRY_RUN = "true";
  const r = await deployToDammV2(0.1);
  assert.equal(r.dry_run, true);
  assert.equal(r.would_park_sol, 0.1);
});

check("enabled + request > maxParkSol → CLAMPED down in dry_run", async () => {
  process.env.DRY_RUN = "true";
  const r = await deployToDammV2(5.0); // way over 0.3 cap
  assert.equal(r.dry_run, true);
  assert.equal(r.would_park_sol, 0.3, "must clamp to hardcap");
});

check("enabled + invalid amount → no-op", async () => {
  process.env.DRY_RUN = "true";
  const r = await deployToDammV2(-1);
  assert.equal(r.no_op, true);
  assert.equal(r.reason, "invalid_amount");
});

check("enabled + no pool → no-op (fail-safe)", async () => {
  liveConfig.damm.poolAddress = null;
  process.env.DRY_RUN = "true";
  const r = await deployToDammV2(0.1);
  assert.equal(r.no_op, true);
  assert.equal(r.reason, "no_pool_configured");
});

check("enabled + DRY_RUN=false + SDK absent → fail-safe no-op (no send)", async () => {
  liveConfig.damm.poolAddress = "PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.DRY_RUN = "false";
  const r = await deployToDammV2(0.1);
  assert.equal(r.no_op, true);
  // SDK is not installed in this repo → must stop here, never reach a send.
  assert.ok(["sdk_not_installed", "scaffold_live_path_not_implemented"].includes(r.reason),
    `expected SDK-absent fail-safe, got ${r.reason}`);
});

// restore
liveConfig.damm.enabled = savedEnabled;
liveConfig.damm.poolAddress = savedPool;

console.log("\n=== withdraw + yield ===");

check("withdraw invalid id → no-op", async () => {
  const r = await withdrawFromDammV2("");
  assert.equal(r.no_op, true);
  assert.equal(r.reason, "invalid_position_id");
});

check("withdraw DRY_RUN=true → dry_run no-op", async () => {
  process.env.DRY_RUN = "true";
  const r = await withdrawFromDammV2("NFTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.equal(r.dry_run, true);
  assert.equal(r.action, "withdraw_from_damm_v2");
});

check("withdraw DRY_RUN=false + SDK absent → fail-safe (recoverable)", async () => {
  process.env.DRY_RUN = "false";
  const r = await withdrawFromDammV2("NFTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.equal(r.no_op, true);
  assert.ok(["sdk_not_installed", "scaffold_live_path_not_implemented"].includes(r.reason));
});

check("getDammV2Yield invalid id → accrued 0, error (never throws)", async () => {
  const r = await getDammV2Yield("");
  assert.equal(r.accrued, 0);
  assert.equal(r.error, "invalid_position_id");
});

check("getDammV2Yield SDK absent → accrued 0, error (never throws)", async () => {
  const r = await getDammV2Yield("NFTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.equal(r.accrued, 0);
  assert.ok(["sdk_not_installed", "scaffold_not_implemented"].includes(r.error));
});

// restore env
if (PREV_DRY === undefined) delete process.env.DRY_RUN;
else process.env.DRY_RUN = PREV_DRY;

console.log(`\n✅ DAMM v2 — ALL ${assertions} assertions PASSED\n`);
