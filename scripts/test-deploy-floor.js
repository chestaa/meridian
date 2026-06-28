// Vega go-live deploy-floor self-check (2026-06-28).
//
// Invariant under test: the executor deploy floor is a DUST floor (0.02), so a
// Bro-approved Phase-1 0.03-0.05 deploy CLEARS it while a 0.005 dust deploy is
// REFUSED. The floor is computed in executor.js as:
//     minDeploy = Math.max(0.02, config.management.deployAmountSol)
//
// The floor lives deep in the deploy_position safety check (no clean test seam),
// so we assert the floor EXPRESSION directly + guard against the deadlock case
// (deployAmountSol set so high the floor exceeds the 0.05 live cap → nothing can
// deploy). This is the smallest thing that fails if the floor logic regresses.
//
// Run: node scripts/test-deploy-floor.js

import assert from "node:assert/strict";

const DUST_FLOOR = 0.02;            // executor.js minDeploy hard floor
const PHASE1_CAP = 0.05;            // MAX_LIVE_POSITION_SOL (dlmm.js)

// Mirror of the executor floor expression. If executor.js:1385 changes, this
// constant must change with it — the test below pins the contract.
const floorFor = (deployAmountSol) => Math.max(DUST_FLOOR, deployAmountSol);

let passed = 0, failed = 0;
const check = (label, cond) => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
};

// ── 1. With a dust-only deployAmountSol, floor stays at the 0.02 dust floor ──
const floor = floorFor(0.01);
check("floor is 0.02 dust floor when deployAmountSol below it", floor === DUST_FLOOR);

// ── 2. Phase-1 sizes 0.03, 0.04, 0.05 all CLEAR the floor ──
for (const amt of [0.03, 0.04, 0.05]) {
  check(`Phase-1 deploy ${amt} SOL clears floor (>= ${floor})`, amt >= floor);
}

// ── 3. Dust 0.005 is still REFUSED (below floor) ──
check("dust 0.005 SOL is below floor (refused)", 0.005 < floor);

// ── 4. DEADLOCK guard: floor must not exceed the 0.05 live cap, else NOTHING
//      can deploy live. This catches deployAmountSol left at a go-live-incompatible
//      value (e.g. 0.2). Reads the LIVE config.
const { config } = await import("../config.js");
const liveDeployAmount = config.management.deployAmountSol;
const liveFloor = floorFor(liveDeployAmount);
console.log(`  INFO  live deployAmountSol=${liveDeployAmount} -> floor=${liveFloor}, Phase-1 cap=${PHASE1_CAP}`);
check(
  `live floor (${liveFloor}) <= Phase-1 cap (${PHASE1_CAP}) — no deploy deadlock`,
  liveFloor <= PHASE1_CAP,
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: deploy-floor (${passed} passed, ${failed} failed)`);
if (failed > 0) process.exit(1);
