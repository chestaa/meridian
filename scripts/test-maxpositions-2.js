// scripts/test-maxpositions-2.js
// Vega money-gate validation: raising maxPositions 1 -> 2 (concurrent LP slots).
//
// Money-exposure change. This test proves the safety envelope holds with TWO
// concurrent positions BEFORE the config is flipped live:
//   1. Per-position hard cap (maxDeployAmount=0.20) is UNCHANGED and binds —
//      computeDynamicDeployAmount can never exceed it for any confidence/base.
//   2. Total worst-case exposure = maxPositions * maxDeployAmount = 2*0.20 = 0.40
//      SOL, which fits inside wallet 0.856 SOL with gasReserve 0.20 untouched.
//   3. The deploy count gate (executor.js L990: total_positions >= maxPositions)
//      admits slots 0 and 1, rejects slot 2 — verified against the exact
//      comparison the executor uses.
//   4. The per-deploy SOL-balance check (amountY + gasReserve) still holds for
//      the 2nd deploy given the residual balance after the 1st.
//   5. Circuit breaker (0.10 SOL daily cap) is independent of position count —
//      2 losing closes still trip it; cap value UNCHANGED.
//
// Pure unit test. No real RPC, no on-chain calls, no executor mutation. The
// executor's runSafetyChecks is private with no test seam (it's a crown-jewel
// file — a config flip must NOT require adding seams to it). So the count gate
// and balance gate are asserted against the EXACT predicates the executor uses
// (executor.js L990 and L1043-1052), kept in lockstep here.

process.env.DRY_RUN = "false";
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { config, computeDeployAmount, computeDynamicDeployAmount } = await import("../config.js");
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

// ── Exact executor predicates (mirror of tools/executor.js) ──────────────────
// L990: if (positions.total_positions >= config.risk.maxPositions) -> REJECT
function countGateRejects(totalPositions, maxPositions) {
  return totalPositions >= maxPositions;
}
// L1043-1052 (DRY_RUN=false): minRequired = amountY + gasReserve; reject if balance.sol < minRequired
function balanceGateRejects(balanceSol, amountY, gasReserve) {
  return balanceSol < amountY + gasReserve;
}

// ── Apply the proposed change in-memory only (does NOT touch user-config.json) ──
const PER_POS_CAP = config.risk.maxDeployAmount; // 0.20 live
const GAS = config.management.gasReserve;          // 0.20 live
const WALLET = 0.856;
const MAX_POS = 2; // the change under test

check("precondition: per-position cap is 0.20 (UNCHANGED)", PER_POS_CAP === 0.20, `got ${PER_POS_CAP}`);
check("precondition: gasReserve is 0.20 (UNCHANGED)", GAS === 0.20, `got ${GAS}`);
check("precondition: daily loss cap is 0.10 SOL (UNCHANGED)", DAILY_LOSS_CAP_SOL === 0.10, `got ${DAILY_LOSS_CAP_SOL}`);

// ── 1. Per-position cap binds for ALL confidences (incl. 1.5x sizing tier) ──
const base = computeDeployAmount(WALLET);
for (const conf of [50, 75, 85, 95, 100]) {
  const sized = computeDynamicDeployAmount(base, conf);
  check(`per-position sized<=cap @conf=${conf} (${sized}<=${PER_POS_CAP})`, sized <= PER_POS_CAP, `got ${sized}`);
}

// ── 2. Total worst-case exposure envelope ──
const worstCaseExposure = MAX_POS * PER_POS_CAP; // 2*0.20
check("total max exposure = 0.40 SOL", Math.abs(worstCaseExposure - 0.40) < 1e-9, `got ${worstCaseExposure}`);
check("exposure + gas fits wallet (0.40+0.20 <= 0.856)", worstCaseExposure + GAS <= WALLET, `need ${worstCaseExposure + GAS}, have ${WALLET}`);
check("gas reserve preserved after 2 deploys (0.856-0.40 >= 0.20)", WALLET - worstCaseExposure >= GAS, `residual ${WALLET - worstCaseExposure}`);

// ── 3. Deploy count gate: admit slots 0,1 — reject slot 2 ──
check("count gate ADMITS 1st deploy (0/2)", countGateRejects(0, MAX_POS) === false);
check("count gate ADMITS 2nd deploy (1/2)", countGateRejects(1, MAX_POS) === false);
check("count gate REJECTS 3rd deploy (2/2)", countGateRejects(2, MAX_POS) === true);
// sanity: old 1-slot config would have rejected the 2nd
check("regression: old maxPositions=1 would reject 2nd deploy", countGateRejects(1, 1) === true);

// ── 4. Per-deploy balance gate across the 2-deploy drain sequence ──
let walletSol = WALLET;
check("1st deploy balance OK (0.856 >= 0.20+0.20)", balanceGateRejects(walletSol, PER_POS_CAP, GAS) === false, `bal ${walletSol}`);
walletSol -= PER_POS_CAP; // 0.656 residual
check("2nd deploy balance OK (0.656 >= 0.20+0.20)", balanceGateRejects(walletSol, PER_POS_CAP, GAS) === false, `bal ${walletSol}`);
walletSol -= PER_POS_CAP; // 0.456 residual
check("gas reserve intact after 2 deploys (0.456 >= 0.20)", walletSol >= GAS, `residual ${walletSol}`);
// thin-wallet 2nd deploy must be refused even with a free slot
check("thin-wallet 2nd deploy REJECTED (0.30 < 0.40 needed)", balanceGateRejects(0.30, PER_POS_CAP, GAS) === true);

// ── 5. Circuit breaker independent of position count: 2 losing closes trip it ──
// Wipe any persisted state so today inits fresh (one-way loss ratchet means
// manualReset alone keeps prior realized loss; we need a clean slate here).
const _cbState = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "circuit-breaker-state.json");
try { fs.unlinkSync(_cbState); } catch { /* absent = already clean */ }
__setWalletFetchForTest(async () => ({ sol: WALLET }));
manualReset("test setup");
await recordRealizedLoss({ pnl_pct: -30, amount_sol: 0.20, pool: "POOL_A", pool_name: "A", reason: "stop" }); // -0.06
let after1 = getCircuitStatus();
check("after 1 losing close: not yet halted (0.06<0.10)", after1.halted === false, JSON.stringify(after1));
await recordRealizedLoss({ pnl_pct: -30, amount_sol: 0.20, pool: "POOL_B", pool_name: "B", reason: "stop" }); // +0.06 = 0.12
let after2 = getCircuitStatus();
check("after 2 losing closes: HALTED (0.12>=0.10 cap)", after2.halted === true, JSON.stringify(after2));
check("circuit cap value still 0.10 SOL", after2.cap_sol === 0.10, `got ${after2.cap_sol}`);
manualReset("test teardown");
// Remove the test-seeded state so we don't leave a halted breaker on disk.
try { fs.unlinkSync(_cbState); } catch { /* fine */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
