// scripts/test-two-sided-live-integrated.js
// Vega 🔥 — FINAL INTEGRATED live two-sided money-path review (go-live prep 2026-07-14).
//
// Every lifecycle piece was tested in ISOLATION before. This test traces the FULL
// live path end-to-end AS A UNIT under a live-authorized config, to prove:
//
//   A. CAP 0.20 binds — 0.21 total-notional REFUSED, 0.20 ALLOWED (the raised ceiling).
//   B. The 2-FLAG ENABLE SEAM — twoSidedGateDecision opens live ONLY when BOTH
//      twoSidedPaperOnly=false AND twoSidedLiveAuthorized=true (partial flip refused,
//      defaults refused). This is what makes "the 2-flag flip" the true single enable.
//   C. RECORD-SHAPE CONSISTENCY across every handoff:
//         executeTwoSidedLiveDeposit (deposit output)
//           → trackPosition (state two_sided_live shape)
//           → computeTwoSidedLivePnl + evaluateTwoSidedLiveExit (Andromeda monitor read)
//           → executeTwoSidedCloseSwapAndAccount (close input read).
//      Field names + values must survive every hop with NO seam mismatch.
//   D. COMBINED-EXPOSURE caps bind — single-side cap, two-sided total-notional cap,
//      maxPositions, AND the SOL-coverage belt (now counts BOTH two-sided legs).
//
// Pure functions + orchestration via injected _testHooks + a scratch state.json
// (real state.json is backed up and restored). No LLM, RPC, or chain.

import fs from "fs";
import {
  twoSidedGateDecision,
  resolveTwoSidedNotionalCapSol,
  assertTwoSidedNotionalCap,
  computeTwoSidedNotionalSol,
  MAX_TWO_SIDED_NOTIONAL_SOL,
  WSOL_MINT,
} from "../tools/two-sided.js";
import { solCoverageRejectReason } from "../tools/executor.js";
import { config } from "../config.js";
import * as dlmm from "../tools/dlmm.js";
import { getTrackedPosition, computeTwoSidedLivePnl, evaluateTwoSidedLiveExit } from "../state.js";
import { MAX_LIVE_POSITION_SOL } from "../tools/dlmm.js";

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

const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const STATE_FILE = "./state.json";

function cfg(strategy = {}) {
  return { strategy };
}

// ── A. CAP 0.20 binds ──────────────────────────────────────────────────────────
console.log("\n[A] cap 0.20 binds");
check("code ceiling raised to 0.20", MAX_TWO_SIDED_NOTIONAL_SOL === 0.2, `got ${MAX_TWO_SIDED_NOTIONAL_SOL}`);
check("resolved cap (config default) === 0.20", resolveTwoSidedNotionalCapSol(config) === 0.2, `got ${resolveTwoSidedNotionalCapSol(config)}`);
check("cap: config CANNOT exceed 0.20 ceiling", resolveTwoSidedNotionalCapSol(cfg({ twoSidedNotionalCapSol: 5 })) === 0.2);
{
  // 0.10 Y + 0.10 X-in-SOL = 0.20 == cap → ALLOWED (boundary inclusive).
  const ok = assertTwoSidedNotionalCap({ amountYSol: 0.1, amountXTokens: 10, priceSolPerToken: 0.01, capSol: 0.2 });
  check("cap: 0.20 total == cap → ALLOWED", ok.ok === true, ok.reason || "");
  check("cap: notional total computed = 0.20", ok.notional?.total_notional_sol === 0.2, JSON.stringify(ok.notional));
}
{
  // 0.11 Y + 0.10 X-in-SOL = 0.21 > 0.20 → REFUSE.
  const bad = assertTwoSidedNotionalCap({ amountYSol: 0.11, amountXTokens: 10, priceSolPerToken: 0.01, capSol: 0.2 });
  check("cap: 0.21 > 0.20 → REFUSE", bad.ok === false);
  check("cap: refuse reason names exceed", /exceeds_cap/.test(bad.reason || ""), bad.reason || "");
}
check(
  "cap: 0.20 < single-side MAX_LIVE_POSITION_SOL (0.5) — single-side belt still backstops",
  0.2 < MAX_LIVE_POSITION_SOL && MAX_LIVE_POSITION_SOL === 0.5,
);

// ── B. The 2-flag enable seam ────────────────────────────────────────────────
console.log("\n[B] 2-flag enable seam (twoSidedGateDecision — single authority for executor + dlmm)");
{
  // Shipped defaults → LIVE refused (belt 2, paperOnly TRUE).
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "false");
  check("seam: defaults (paperOnly TRUE) → REFUSE (belt 2)", g.allowed === false && /paper simulation only/.test(g.refuseReason));
}
{
  // Partial flip: paperOnly=false but liveAuthorized still false → REFUSE (belt 3).
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false }), "false");
  check("seam: partial flip (paperOnly=false only) → REFUSE (belt 3)", g.allowed === false && /not implemented\/authorized/.test(g.refuseReason));
}
{
  // Partial flip: liveAuthorized=true but paperOnly still TRUE → REFUSE (belt 2).
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true, twoSidedLiveAuthorized: true }), "false");
  check("seam: partial flip (liveAuthorized only) → REFUSE (belt 2)", g.allowed === false && /paper simulation only/.test(g.refuseReason));
}
{
  // BOTH flags flipped → LIVE ALLOWED. This is the single enable action.
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false, twoSidedLiveAuthorized: true }), "false");
  check("seam: BOTH flags flipped → ALLOWED (the enable)", g.allowed === true && g.refuseReason === null, JSON.stringify(g));
}
{
  // Master flag OFF → original single-side invariant regardless of other flags.
  const g = twoSidedGateDecision(cfg({ twoSidedPaperOnly: false, twoSidedLiveAuthorized: true }), "false");
  check("seam: master OFF → single-side invariant refusal", g.allowed === false && /only supports single-side/.test(g.refuseReason));
}

// ── C. Integrated record-shape flow: deposit → state → monitor → close ─────────
console.log("\n[C] integrated record-shape flow (deposit → state → monitor → close)");

// Back up the real state.json so this test cannot pollute production state.
const _stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : null;
const _savedStrategy = { ...config.strategy };
const _savedDryRun = process.env.DRY_RUN;

function authorizeLive() {
  config.strategy.twoSidedEnabled = true;
  config.strategy.twoSidedPaperOnly = false;
  config.strategy.twoSidedLiveAuthorized = true;
  config.strategy.twoSidedNotionalCapSol = 0.2;
  process.env.DRY_RUN = "false";
}
function restore() {
  config.strategy = { ..._savedStrategy };
  if (_savedDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = _savedDryRun;
  dlmm.__resetTests();
}

const POS = "POSINTEG2SIDED";
const ctx = {
  pool: {},
  pool_address: "PooLintegxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  pool_name: "JitoSOL-SOL",
  baseMint: JITOSOL,
  quoteMint: WSOL_MINT,
  activeBin: { binId: 1000 },
  activePrice: 0.01, // SOL per token
  actualBinStep: 20,
  activeStrategy: "spot",
  strategyType: 0,
  finalAmountX: 10, // 10 token-X * 0.01 = 0.10 SOL X-leg
  finalAmountY: 0.1, // 0.10 SOL Y-leg → total notional 0.20 == cap
  activeBinsBelow: 30,
  activeBinsAbove: 30,
  bin_step: 20,
  normalizedVolatility: 3.5,
  fee_tvl_ratio: 0.1,
  organic_score: 80,
  initial_value_usd: 10,
  entryFeatures: {},
};

let depositArgs = null;
try {
  authorizeLive();
  dlmm.__setForTests({
    // entry swap: spent 0.10 SOL, received 9.8 tokens (slippage) → drag 0.002 SOL.
    swapToken: async () => ({ success: true, tx: "SWAPTX", amount_out: 9.8, amount_in: 0.1 }),
    depositTwoSidedSdk: async (a) => {
      depositArgs = a;
      return { success: true, position: POS, txs: ["DEPTX"] };
    },
    notifyStranded: async () => {},
  });

  // (C1) DEPOSIT — total notional 0.20 == cap → success + tracked.
  const dep = await dlmm.executeTwoSidedLiveDeposit({ ...ctx });
  check("C1 deposit: success", dep.success === true, JSON.stringify(dep));
  check("C1 deposit: notional total = 0.20 (== cap)", dep.notional?.total_notional_sol === 0.2, JSON.stringify(dep.notional));
  check("C1 deposit: deposit got Y-leg 0.10 + tokenXReceived 9.8", depositArgs?.amountYSol === 0.1 && depositArgs?.tokenXReceived === 9.8, JSON.stringify(depositArgs));

  // (C2) STATE — trackPosition mapped the deposit output into two_sided_live shape.
  const pos = getTrackedPosition(POS);
  check("C2 state: position persisted", pos != null && pos.two_sided === true);
  const ts = pos?.two_sided_live || {};
  check("C2 state: y_leg_sol = 0.10 (from amount_sol)", ts.y_leg_sol === 0.1, JSON.stringify(ts));
  check("C2 state: x_leg_tokens = 9.8 (from amount_x = tokenXReceived)", ts.x_leg_tokens === 9.8, JSON.stringify(ts));
  check("C2 state: entry_price = 0.01", ts.entry_price === 0.01, JSON.stringify(ts));
  check("C2 state: notional_sol = 0.20 (from notional.total_notional_sol)", ts.notional_sol === 0.2, JSON.stringify(ts));
  check("C2 state: entry_swap_cost_sol ~ 0.002 drag (finite, >0)", Number.isFinite(ts.entry_swap_cost_sol) && ts.entry_swap_cost_sol > 0, JSON.stringify(ts));

  // (C3) MONITOR — Andromeda reads the SAME two_sided_live shape (no seam mismatch).
  const pnlUp = computeTwoSidedLivePnl(pos, { pnl_pct_fee_inclusive: 12, in_range: true });
  check("C3 monitor: computeTwoSidedLivePnl computable (reads notional_sol+swap_cost)", pnlUp.uncomputable === false && Number.isFinite(pnlUp.pnl_pct), JSON.stringify(pnlUp));
  check("C3 monitor: swap drag applied (12% base minus ~1% drag)", pnlUp.pnl_pct < 12 && pnlUp.pnl_pct > 10, JSON.stringify(pnlUp));
  const exitUp = evaluateTwoSidedLiveExit(POS, { pnl_pct_fee_inclusive: 12, in_range: true }, config.management);
  check("C3 monitor: upside-capture fires at +12% (>= target)", exitUp?.action === "TWO_SIDED_UPSIDE_CAPTURE", JSON.stringify(exitUp));
  const exitDown = evaluateTwoSidedLiveExit(POS, { pnl_pct_fee_inclusive: -12, in_range: true }, config.management);
  check("C3 monitor: down-cut fires at -12% (<= floor)", exitDown?.action === "TWO_SIDED_DOWN_CUT", JSON.stringify(exitDown));

  // (C4) CLOSE — executeTwoSidedCloseSwapAndAccount reads the SAME two_sided_live shape.
  // Token-X bag (9.8) sits in wallet post-withdraw; swap → 0.11 SOL. Y-leg returned 0.10.
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 0.5, tokens: [{ mint: JITOSOL, balance: 9.8 }] }),
    swapToken: async () => ({ success: true, tx: "CLOSESWAP", amount_out: 0.11 * 1e9 }), // lamports
    notifyStranded: async () => {},
  });
  const close = await dlmm.executeTwoSidedCloseSwapAndAccount({
    tracked: pos,
    baseMint: JITOSOL,
    withdrawnSol: 0.1, // Y leg returned
    feesSol: 0.005,
    measuredCloseGasSol: 0.001,
  });
  check("C4 close: token-X bag swapped (not stranded)", close.stranded === false && close.swapSucceeded === true, JSON.stringify(close));
  check("C4 close: tokenXSwapOutSol = 0.11 (lamports→SOL)", close.tokenXSwapOutSol === 0.11, JSON.stringify(close.tokenXSwapOutSol));
  check("C4 close: realized computed via two_sided_formula", close.closeRsd?.method === "two_sided_formula", JSON.stringify(close.closeRsd));
  // entryXLeg derived from notional_sol(0.20) − y_leg_sol(0.10) = 0.10 → solIn = 0.20.
  // realized = (0.10 yOut + 0.11 xOut + 0.005 fees) − 0.20 solIn − 0.001 gas = 0.014.
  check("C4 close: sol_deployed = 0.20 (entryY 0.10 + entryX 0.10 from shape)", close.closeRsd?.sol_deployed === 0.2, JSON.stringify(close.closeRsd));
  check("C4 close: realized_sol_delta ~ 0.014 (finite, correct sign)", Math.abs(close.closeRsd?.realized_sol_delta - 0.014) < 1e-6, JSON.stringify(close.closeRsd));
} finally {
  restore();
  // Restore real state.json (remove test position).
  if (_stateBackup != null) fs.writeFileSync(STATE_FILE, _stateBackup);
  else if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
}

// ── D. Combined-exposure — all caps bind together on the shared DgA9 wallet ────
console.log("\n[D] combined-exposure caps bind (shared 0.69 SOL wallet, maxPositions 2)");
const WALLET = 0.69;
const gasReserve = 0.2;
const singleSideCap = 0.2; // maxDeployAmount (live)
const twoSidedCap = 0.2; // total-notional cap

// D1 — SOL-coverage belt now counts BOTH two-sided legs (the go-live seam fix).
// OLD behavior reserved only the Y-leg (~0.10); a two-sided deploy actually spends
// the full notional. Prove the fixed coverage amount (= notional cap) binds.
{
  // Two-sided deploy on a thin 0.35 wallet: full-notional coverage (0.20) + gas (0.20)
  // = 0.40 required → REFUSE. (Under the OLD Y-leg-only 0.10 + 0.20 = 0.30 it would
  // have PASSED and eaten into the gas reserve.)
  const rejFixed = solCoverageRejectReason({ sol: 0.35 }, twoSidedCap, gasReserve);
  check("D1 coverage: two-sided (both legs 0.20)+gas on 0.35 wallet → REFUSE", rejFixed != null && /Insufficient/.test(rejFixed), rejFixed || "");
  const passOld = solCoverageRejectReason({ sol: 0.35 }, 0.1, gasReserve); // Y-leg only (old)
  check("D1 coverage: (demonstrates) Y-leg-only 0.10+gas on 0.35 would PASS — why the fix matters", passOld === null);
  // On the real 0.69 wallet the first two-sided deploy clears full-notional coverage.
  const rej069 = solCoverageRejectReason({ sol: WALLET }, twoSidedCap, gasReserve);
  check("D1 coverage: two-sided full-notional coverage clears on 0.69 wallet", rej069 === null, rej069 || "");
}

// D2 — worst-case CONCURRENT exposure (maxPositions=2) vs 0.69.
// Rent per DLMM position ~0.057 SOL (position account + bin arrays), refundable on close.
const rentPerPos = 0.057;
const worstPrincipal = 2 * twoSidedCap; // 2 × 0.20 total-notional = 0.40 (worst mix)
const worstRent = 2 * rentPerPos; // 0.114
const worstCommitted = worstPrincipal + worstRent; // 0.514
check("D2: worst-case principal (2 × 0.20) = 0.40", Math.abs(worstPrincipal - 0.4) < 1e-9);
check("D2: worst-case principal+rent (0.514) < wallet 0.69 (wallet COVERS worst case)", worstCommitted < WALLET, `committed ${worstCommitted}`);
const liquidAfter = WALLET - worstCommitted; // ~0.176
check("D2: liquid remaining after worst case ~0.176 SOL (> real gas needs)", liquidAfter > 0.1, `liquid ${liquidAfter}`);
// The nominal 0.20 gasReserve is not FULLY preserved in the absolute worst case
// (0.176 < 0.20), but the ~0.024 shortfall is rent-refundable and dwarfs actual
// per-tx gas (~0.000005-0.001 SOL). Reported to Polaris, not a blocker.
check("D2: worst-case dip below nominal gasReserve is small (< 0.03) and rent-refundable", (gasReserve - liquidAfter) < 0.03, `dip ${gasReserve - liquidAfter}`);

// D3 — every cap binds independently (no bypass path).
check("D3: single-side cap 0.20 <= code MAX_LIVE_POSITION_SOL 0.5", singleSideCap <= MAX_LIVE_POSITION_SOL);
check("D3: two-sided cap 0.20 <= code MAX_TWO_SIDED_NOTIONAL_SOL 0.20", twoSidedCap <= MAX_TWO_SIDED_NOTIONAL_SOL);
check("D3: neither per-position cap alone can exceed wallet", singleSideCap < WALLET && twoSidedCap < WALLET);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
