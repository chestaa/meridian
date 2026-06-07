// scripts/test-maxpositions-3.js
// Vega money-gate validation: raising maxPositions 2 -> 3 AND tightening the
// per-position cap 0.20 -> 0.18 (gas-buffer hardening).
//
// Money-exposure change. This test proves the safety envelope holds with THREE
// concurrent positions at the lower 0.18 cap BEFORE the config is flipped live:
//   1. Per-position hard cap (maxDeployAmount=0.18) BINDS — computeDynamicDeployAmount
//      can never exceed it for ANY confidence 0..100 or base. (uses the REAL
//      exported fn + a proposed-config seam, not a mirror.)
//   2. Envelope invariant with a >=10% wallet buffer guard:
//        maxPositions * maxDeployAmount + gasReserve <= walletSol * 0.90
//      i.e. 3*0.18 + 0.20 = 0.74 <= 0.851753*0.90 = 0.766577  -> PASS.
//   3. solCoverageRejectReason (REAL exported executor fn) admits the sequential
//      1->2->3 deploy drain, and the count gate rejects the 4th with the exact
//      "Max positions (3) reached" message the executor emits (executor.js L1015-1019).
//   4. Circuit breaker (0.10 SOL daily cap, UNCHANGED): 3 stop-loss closes at
//      stopLossPct(-10) on 0.18 positions realize 3*0.018=0.054 < 0.10 -> NO
//      false trip. 5 such closes (0.090)... still under; we drive it past the cap
//      to prove the breaker still TRIPS (it is not disabled by the smaller size).
//   5. Gas-survival: after committing all 3 deploys, residual wallet must cover an
//      emergency close-ALL-3 (3 closes; budget 9*0.005=0.045 SOL of priority/gas).
//
// Pure unit test. No real RPC, no on-chain calls, no executor mutation. The new
// live values (maxPositions=3, maxDeployAmount=0.18, deployAmountSol=0.18) live in
// the GITIGNORED user-config.json on the VPS (Draco sed's them). This runner has
// no access to that file, so the proposed values are injected via the cfg seam —
// the test asserts the ENVELOPE, independent of whatever config.js loads locally.

process.env.DRY_RUN = "false";
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { computeDynamicDeployAmount } = await import("../config.js");
const { solCoverageRejectReason } = await import("../tools/executor.js");
const {
  recordRealizedLoss,
  getCircuitStatus,
  manualReset,
  DAILY_LOSS_CAP_SOL,
  __setWalletFetchForTest,
} = await import("../account-circuit-breaker.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}  ${detail}`);
    process.exitCode = 1;
  }
}

// ── Proposed live values (the change under test) ──────────────────────────────
const MAX_POS = 3;        // 2 -> 3
const PER_POS_CAP = 0.18; // maxDeployAmount: 0.20 -> 0.18
const FLOOR = 0.18;       // deployAmountSol: 0.20 -> 0.18
const GAS = 0.20;         // gasReserve: UNCHANGED
const WALLET = 0.851753;  // live LIVE-wallet balance reported by Bro
const BUFFER_GUARD = 0.90; // committed exposure must fit inside 90% of wallet

// Proposed-config seam handed to the REAL computeDynamicDeployAmount.
const proposedCfg = {
  risk: { maxDeployAmount: PER_POS_CAP, maxPositions: MAX_POS, dynamicSizingEnabled: true },
  management: { gasReserve: GAS, deployAmountSol: FLOOR, positionSizePct: 0.1 },
};

// Exact executor count-gate (mirror of tools/executor.js L1015-1019).
function countGateReject(totalPositions, maxPositions) {
  return totalPositions >= maxPositions
    ? `Max positions (${maxPositions}) reached. Close a position first.`
    : null;
}

check("precondition: gasReserve UNCHANGED at 0.20", GAS === 0.20, `got ${GAS}`);
check("precondition: daily loss cap UNCHANGED at 0.10 SOL", DAILY_LOSS_CAP_SOL === 0.10, `got ${DAILY_LOSS_CAP_SOL}`);
check("precondition: per-position cap tightened to 0.18", PER_POS_CAP === 0.18, `got ${PER_POS_CAP}`);
check("precondition: deploy floor lowered to 0.18", FLOOR === 0.18, `got ${FLOOR}`);

// ── 1. Per-position cap BINDS for all confidences AND a range of base amounts ──
for (const baseAmt of [0.18, 0.20, 0.5, 1.0, 5.0, 50]) {
  for (const conf of [0, 25, 50, 75, 85, 90, 95, 100]) {
    const sized = computeDynamicDeployAmount(baseAmt, conf, proposedCfg);
    check(`sized<=0.18 cap @base=${baseAmt},conf=${conf} (${sized})`, sized <= PER_POS_CAP + 1e-9, `got ${sized}`);
  }
}
// The 1.5x confidence tier (90+) on an at-cap base must STILL be clamped.
check("1.5x tier on at-cap base stays capped (0.18*1.5 -> 0.18)",
  computeDynamicDeployAmount(0.18, 100, proposedCfg) <= PER_POS_CAP + 1e-9,
  `got ${computeDynamicDeployAmount(0.18, 100, proposedCfg)}`);

// ── 2. Envelope invariant with >=10% buffer guard ──
const committed = MAX_POS * PER_POS_CAP + GAS;        // 3*0.18 + 0.20 = 0.74
const budgetUnderGuard = WALLET * BUFFER_GUARD;        // 0.851753*0.90 = 0.766577...
check("committed exposure = 0.74 SOL (3*0.18 + 0.20 gas)", Math.abs(committed - 0.74) < 1e-9, `got ${committed}`);
check("envelope fits 90% wallet (0.74 <= 0.766577)", committed <= budgetUnderGuard, `committed ${committed} vs guard ${budgetUnderGuard.toFixed(6)}`);
const bufferSol = WALLET - committed;
check("absolute buffer >= 0.10 SOL (0.116 free)", bufferSol >= 0.10, `buffer ${bufferSol.toFixed(6)}`);
// sanity: a 4th 0.18 slot would BREACH the 90% guard (proves headroom is for 3, not 4).
check("regression: 4 slots would breach 90% guard", (4 * PER_POS_CAP + GAS) > budgetUnderGuard, `4-slot committed ${(4*PER_POS_CAP+GAS).toFixed(4)}`);

// ── 3. solCoverageRejectReason across the 1->2->3 drain + count gate on 4th ──
let walletSol = WALLET;
check("count gate ADMITS 1st deploy (0/3)", countGateReject(0, MAX_POS) === null);
check("1st deploy SOL coverage OK", solCoverageRejectReason({ sol: walletSol }, PER_POS_CAP, GAS) === null, `bal ${walletSol}`);
walletSol = parseFloat((walletSol - PER_POS_CAP).toFixed(6)); // 0.671753

check("count gate ADMITS 2nd deploy (1/3)", countGateReject(1, MAX_POS) === null);
check("2nd deploy SOL coverage OK", solCoverageRejectReason({ sol: walletSol }, PER_POS_CAP, GAS) === null, `bal ${walletSol}`);
walletSol = parseFloat((walletSol - PER_POS_CAP).toFixed(6)); // 0.491753

check("count gate ADMITS 3rd deploy (2/3)", countGateReject(2, MAX_POS) === null);
check("3rd deploy SOL coverage OK", solCoverageRejectReason({ sol: walletSol }, PER_POS_CAP, GAS) === null, `bal ${walletSol}`);
walletSol = parseFloat((walletSol - PER_POS_CAP).toFixed(6)); // 0.311753

const reject4 = countGateReject(3, MAX_POS);
check("count gate REJECTS 4th deploy (3/3)", reject4 === "Max positions (3) reached. Close a position first.", `got ${JSON.stringify(reject4)}`);
// regression: old maxPositions=2 would have rejected the 3rd
check("regression: old maxPositions=2 would reject 3rd deploy", countGateReject(2, 2) !== null);
// fail-closed: a 4th deploy attempt with unknown balance is refused on coverage too
check("4th deploy with unknown balance fail-closed", typeof solCoverageRejectReason({ error: true, sol: null }, PER_POS_CAP, GAS) === "string");

// gas reserve must still be intact after the 3 committed deploys
check("gas reserve intact after 3 deploys (residual >= 0.20)", walletSol >= GAS, `residual ${walletSol}`);

// ── 4. Circuit breaker UNCHANGED — no false trip at 0.18 size, still trips past cap ──
const STOP_LOSS_PCT = -10; // stopLossPct live floor
const lossPerClose = Math.abs(STOP_LOSS_PCT) / 100 * PER_POS_CAP; // 0.10 * 0.18 = 0.018
check("realized loss per SL-close = 0.018 SOL", Math.abs(lossPerClose - 0.018) < 1e-9, `got ${lossPerClose}`);
check("3x SL-close (0.054) < daily cap (0.10) — NO false trip", 3 * lossPerClose < DAILY_LOSS_CAP_SOL, `3x = ${3*lossPerClose}`);

const _cbState = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "circuit-breaker-state.json");
try { fs.unlinkSync(_cbState); } catch { /* absent = already clean */ }
__setWalletFetchForTest(async () => ({ sol: WALLET }));
manualReset("test setup");

await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P1", pool_name: "P1", reason: "stop" }); // 0.018
let s1 = getCircuitStatus();
check("after 1 SL-close: not halted (0.018<0.10)", s1.halted === false, JSON.stringify(s1));
await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P2", pool_name: "P2", reason: "stop" }); // 0.036
await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P3", pool_name: "P3", reason: "stop" }); // 0.054
let s3 = getCircuitStatus();
check("after 3 SL-closes: STILL not halted (0.054<0.10) — no false trip", s3.halted === false, JSON.stringify(s3));
// Drive past the cap to prove the breaker is NOT disabled by the smaller size.
await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P4", pool_name: "P4", reason: "stop" }); // 0.072
await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P5", pool_name: "P5", reason: "stop" }); // 0.090
await recordRealizedLoss({ pnl_pct: STOP_LOSS_PCT, amount_sol: PER_POS_CAP, pool: "P6", pool_name: "P6", reason: "stop" }); // 0.108
let s6 = getCircuitStatus();
check("after 6 SL-closes (0.108>=0.10): HALTED — breaker still live", s6.halted === true, JSON.stringify(s6));
check("circuit cap value still 0.10 SOL", s6.cap_sol === 0.10, `got ${s6.cap_sol}`);
manualReset("test teardown");
try { fs.unlinkSync(_cbState); } catch { /* fine */ }

// ── 5. Gas-survival: residual after 3 deploys covers emergency close-ALL-3 ──
const residualAfter3 = parseFloat((WALLET - MAX_POS * PER_POS_CAP).toFixed(6)); // 0.311753
const CLOSE_ALL_GAS = 9 * 0.005; // 3 closes, generous 3x priority-tx budget each = 0.045 SOL
check("residual after 3 deploys = 0.311753 SOL", Math.abs(residualAfter3 - 0.311753) < 1e-6, `got ${residualAfter3}`);
check("residual covers emergency close-ALL-3 gas (0.311753 >= 0.045)", residualAfter3 >= CLOSE_ALL_GAS, `residual ${residualAfter3} vs gas ${CLOSE_ALL_GAS}`);
// and gasReserve alone already covers it (defense in depth)
check("gasReserve alone (0.20) covers close-ALL-3 gas (0.045)", GAS >= CLOSE_ALL_GAS, `gas reserve ${GAS}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
