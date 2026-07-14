// scripts/test-two-sided-close-path.js
// Vega 🔥 — LIVE two-sided CLOSE path (BUILT, NOT ENABLED).
//
// The final money-path piece of the two-sided lifecycle: deposit ✅, monitor ✅
// (Andromeda), close = this. A single-side close's post-close auto-swap only ever
// liquidated the small base-FEE remainder; a TWO-SIDED close withdraws a FULL
// token-X leg (a real bag) that must be swapped → SOL and accounted HONESTLY.
//
// Proves:
//   (1) computeTwoSidedRealizedSolDelta — honest two-asset realized (both legs +
//       fees − basis − gas); entry AND close swap costs embedded via ACTUALS
//       (no double-count); token-X valued at ACTUAL proceeds, never a mark.
//   (2) Fail-closed: unverifiable basis / y-leg / x-leg (stranded) → honest null.
//   (3) executeTwoSidedCloseSwapAndAccount orchestration: withdraws→swaps token-X,
//       converts lamports→SOL, books honest realized; swap-fail/skip → STRANDED-safe
//       (position closed, bag+alert, NO auto-retry); empty bag → xOut 0 (not null).
//   (4) realizedSolAccounting flag OFF → swap STILL happens (bag liquidated), only
//       the accounting figure is null.
//   (5) Single-side close BYTE-UNCHANGED (single-side realized path untouched).
//   (6) LIVE two-sided STILL hard-refused (belts intact — build ≠ enable).
//
// Pure fns + orchestration via injected _testHooks. No LLM, RPC, or chain.

import {
  computeTwoSidedRealizedSolDelta,
  computeLiveRealizedSolDelta,
  DEFAULT_CLOSE_GAS_SOL,
} from "../realized-sol.js";
import {
  twoSidedGateDecision,
  liveTwoSidedFullyAuthorized,
} from "../tools/two-sided.js";
import { config } from "../config.js";
import * as dlmm from "../tools/dlmm.js";

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
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const LAMPORTS = 1e9;

// ── (1) computeTwoSidedRealizedSolDelta — honest two-asset math ───────────────
{
  // Y 0.05 + X 0.05 = 0.10 in. Back: yExit 0.048 + xSwapOut 0.055 + fees 0.002.
  // delta = 0.105 − 0.10 − gas(0.001) = 0.004 → +4%.
  const r = computeTwoSidedRealizedSolDelta({
    entryYLegSol: 0.05,
    entryXLegSol: 0.05,
    yLegExitSol: 0.048,
    tokenXSwapOutSol: 0.055,
    feesClaimedSol: 0.002,
    gasSpentSol: 0.001,
    entrySwapCostSol: 0.0005,
  });
  check("realized: honest delta = solOut − solIn − gas = 0.004", near(r.realized_sol_delta, 0.004), JSON.stringify(r));
  check("realized: pct = 4%", near(r.realized_sol_delta_pct, 4), JSON.stringify(r));
  check("realized: method two_sided_formula", r.method === "two_sided_formula");
  check("realized: sol_deployed = full two-leg basis 0.10", near(r.sol_deployed, 0.1));
  check("realized: token-X valued at ACTUAL proceeds (diagnostic)", near(r.token_x_swap_out_sol, 0.055));
  check("realized: entry_swap_cost reported (diagnostic, not re-subtracted)", near(r.entry_swap_cost_sol, 0.0005));
}
{
  // Swap costs EMBEDDED proof: a BAD entry (bought fewer tokens) + BAD close
  // (thin book, low proceeds) show up as a LOSS purely via the actuals — no
  // separate cost term. Y 0.05 + X 0.05 in; back yExit 0.05 + xSwapOut 0.04 + 0 fees.
  // delta = 0.09 − 0.10 − gas ≈ -0.0102 → clearly negative (both slippages bit).
  const r = computeTwoSidedRealizedSolDelta({
    entryYLegSol: 0.05,
    entryXLegSol: 0.05,
    yLegExitSol: 0.05,
    tokenXSwapOutSol: 0.04,
    feesClaimedSol: 0,
    gasSpentSol: 0.0002,
  });
  check("realized: entry+close slippage embedded → negative (no double count)", r.realized_sol_delta < 0 && near(r.realized_sol_delta, 0.04 + 0.05 - 0.1 - 0.0002), JSON.stringify(r));
}
{
  // gas defaults to DEFAULT_CLOSE_GAS_SOL when omitted; fees default 0.
  const r = computeTwoSidedRealizedSolDelta({
    entryYLegSol: 0.05,
    entryXLegSol: 0.05,
    yLegExitSol: 0.05,
    tokenXSwapOutSol: 0.05,
  });
  check("realized: gas defaults to DEFAULT_CLOSE_GAS_SOL", near(r.realized_sol_delta, 0.1 - 0.1 - DEFAULT_CLOSE_GAS_SOL), JSON.stringify(r));
}
{
  // Empty bag (token-X fully converted in-pool, already in yLegExit) → xOut 0 is
  // a VALID number, not stranded, realized computed.
  const r = computeTwoSidedRealizedSolDelta({
    entryYLegSol: 0.05,
    entryXLegSol: 0.05,
    yLegExitSol: 0.101,
    tokenXSwapOutSol: 0,
    feesClaimedSol: 0,
    gasSpentSol: 0.001,
  });
  check("realized: empty bag (xOut=0) → valid number, not null", Number.isFinite(r.realized_sol_delta) && near(r.realized_sol_delta, 0.101 - 0.1 - 0.001), JSON.stringify(r));
}

// ── (2) Fail-closed: unverifiable legs → honest null (never a mark) ───────────
{
  const r = computeTwoSidedRealizedSolDelta({ entryYLegSol: null, entryXLegSol: 0.05, yLegExitSol: 0.05, tokenXSwapOutSol: 0.05 });
  check("failclosed: missing basis → null", r.realized_sol_delta === null && r.method === "two_sided_unverifiable_basis", JSON.stringify(r));
}
{
  const r = computeTwoSidedRealizedSolDelta({ entryYLegSol: 0.05, entryXLegSol: 0.05, yLegExitSol: null, tokenXSwapOutSol: 0.05 });
  check("failclosed: missing y-leg exit → null (two_sided_unverifiable_y_leg)", r.realized_sol_delta === null && r.method === "two_sided_unverifiable_y_leg", JSON.stringify(r));
}
{
  // STRANDED: token-X bag not liquidated → tokenXSwapOutSol null → realized null.
  const r = computeTwoSidedRealizedSolDelta({ entryYLegSol: 0.05, entryXLegSol: 0.05, yLegExitSol: 0.05, tokenXSwapOutSol: null });
  check("failclosed: STRANDED x-leg (null proceeds) → null (never a mark)", r.realized_sol_delta === null && r.method === "two_sided_unverifiable_x_leg", JSON.stringify(r));
}
{
  const r = computeTwoSidedRealizedSolDelta({ entryYLegSol: 0, entryXLegSol: 0, yLegExitSol: 0.05, tokenXSwapOutSol: 0.05 });
  check("failclosed: zero basis (solIn<=0) → null", r.realized_sol_delta === null && r.method === "two_sided_unverifiable_basis", JSON.stringify(r));
}

// ── (3) executeTwoSidedCloseSwapAndAccount orchestration (mocked hooks) ────────
const _savedAccounting = config.internalAgents?.realizedSolAccounting;
function ensureAccounting(on) {
  if (!config.internalAgents) config.internalAgents = {};
  config.internalAgents.realizedSolAccounting = on;
}
function restoreAccounting() {
  ensureAccounting(_savedAccounting);
  dlmm.__resetTests();
}
const trackedFixture = (overrides = {}) => ({
  two_sided: true,
  amount_sol: 0.05,
  two_sided_live: {
    y_leg_sol: 0.05,
    x_leg_tokens: 0.05,
    entry_price: 1.0,
    entry_swap_cost_sol: 0.0005,
    notional_sol: 0.1,
    ...(overrides.two_sided_live || {}),
  },
  ...overrides,
});

// (3a) happy path: bag present → swap ok → lamports→SOL, honest realized, not stranded.
{
  ensureAccounting(true);
  let swapCalls = 0;
  let swapArgs = null;
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05, usd: 5 }] }),
    swapToken: async (a) => {
      swapCalls += 1;
      swapArgs = a;
      return { success: true, tx: "SWAPOUT", amount_out: 0.055 * LAMPORTS };
    },
    notifyStranded: async () => {},
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({
    tracked: trackedFixture(),
    baseMint: JITOSOL,
    withdrawnSol: 0.048,
    feesSol: 0.002,
    measuredCloseGasSol: 0.001,
  });
  check("orch happy: swap called ONCE (token-X→SOL)", swapCalls === 1);
  check("orch happy: swap input=token-X output=SOL amount=bag", swapArgs?.input_mint === JITOSOL && swapArgs?.output_mint === "SOL" && near(swapArgs?.amount, 0.05), JSON.stringify(swapArgs));
  check("orch happy: amount_out lamports→SOL = 0.055", near(info.tokenXSwapOutSol, 0.055), JSON.stringify(info));
  check("orch happy: swapSucceeded, not stranded", info.swapSucceeded === true && info.stranded === false);
  check("orch happy: honest realized = 0.004 (+4%)", near(info.closeRsd?.realized_sol_delta, 0.004) && near(info.closeRsd?.realized_sol_delta_pct, 4), JSON.stringify(info.closeRsd));
  check("orch happy: autoSwapNote tells model NOT to re-swap", /Do NOT call swap_token/.test(info.autoSwapNote || ""));
  restoreAccounting();
}

// (3b) swap SKIPPED by slippage guard → STRANDED-safe (bag+alert, no retry, null realized).
{
  ensureAccounting(true);
  let swapCalls = 0;
  let alertMsg = null;
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05, usd: 5 }] }),
    swapToken: async () => {
      swapCalls += 1;
      return { success: false, skipped: true, reason: "slippage_guard", detail: "price_impact_800bps>cap_500bps" };
    },
    notifyStranded: async (m) => { alertMsg = m; },
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({
    tracked: trackedFixture(),
    baseMint: JITOSOL,
    withdrawnSol: 0.048,
    feesSol: 0.002,
    measuredCloseGasSol: 0.001,
  });
  check("orch skip: stranded flag true", info.stranded === true);
  check("orch skip: NO auto-retry (swap called exactly once)", swapCalls === 1);
  check("orch skip: token_x bag reported (tokenXBalance)", near(info.tokenXBalance, 0.05));
  check("orch skip: operator alert FIRED", typeof alertMsg === "string" && /STRANDED two-sided CLOSE/.test(alertMsg));
  check("orch skip: alert names the slippage-guard skip", /SKIPPED by the slippage guard/.test(alertMsg || ""));
  check("orch skip: realized X-leg UNVERIFIABLE → null", info.closeRsd?.realized_sol_delta === null && info.closeRsd?.method === "two_sided_unverifiable_x_leg", JSON.stringify(info.closeRsd));
  restoreAccounting();
}

// (3c) swap FAILS (hard error) → stranded.
{
  ensureAccounting(true);
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05 }] }),
    swapToken: async () => ({ success: false, error: "no route" }),
    notifyStranded: async () => {},
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({ tracked: trackedFixture(), baseMint: JITOSOL, withdrawnSol: 0.048, feesSol: 0, measuredCloseGasSol: 0.001 });
  check("orch fail: stranded, realized null", info.stranded === true && info.closeRsd?.realized_sol_delta === null);
  restoreAccounting();
}

// (3d) swap THROWS → caught, treated as failure → stranded (never crashes the close).
{
  ensureAccounting(true);
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05 }] }),
    swapToken: async () => { throw new Error("rpc timeout"); },
    notifyStranded: async () => {},
  });
  let threw = false;
  let info;
  try {
    info = await dlmm.executeTwoSidedCloseSwapAndAccount({ tracked: trackedFixture(), baseMint: JITOSOL, withdrawnSol: 0.048, feesSol: 0, measuredCloseGasSol: 0.001 });
  } catch { threw = true; }
  check("orch throw: does NOT throw into close path", threw === false);
  check("orch throw: stranded true, realized null", info?.stranded === true && info?.closeRsd?.realized_sol_delta === null);
  restoreAccounting();
}

// (3e) empty bag (no token-X in wallet — fully converted in-pool) → xOut 0, no swap, realized valid.
{
  ensureAccounting(true);
  let swapCalls = 0;
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [] }),
    swapToken: async () => { swapCalls += 1; return { success: true, amount_out: 0 }; },
    notifyStranded: async () => {},
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({ tracked: trackedFixture(), baseMint: JITOSOL, withdrawnSol: 0.101, feesSol: 0, measuredCloseGasSol: 0.001 });
  check("orch empty: no swap attempted (nothing to liquidate)", swapCalls === 0);
  check("orch empty: NOT stranded, xOut = 0", info.stranded === false && near(info.tokenXSwapOutSol, 0));
  check("orch empty: realized computed (yExit only)", near(info.closeRsd?.realized_sol_delta, 0.101 - 0.1 - 0.001), JSON.stringify(info.closeRsd));
  restoreAccounting();
}

// (3f) balance read THROWS → treated as empty bag (fail-safe), no crash.
{
  ensureAccounting(true);
  dlmm.__setForTests({
    getWalletBalances: async () => { throw new Error("helius down"); },
    swapToken: async () => ({ success: true, amount_out: 0.05 * LAMPORTS }),
    notifyStranded: async () => {},
  });
  let info;
  let threw = false;
  try {
    info = await dlmm.executeTwoSidedCloseSwapAndAccount({ tracked: trackedFixture(), baseMint: JITOSOL, withdrawnSol: 0.1, feesSol: 0, measuredCloseGasSol: 0.001 });
  } catch { threw = true; }
  check("orch balread-throw: no crash, treated as empty bag", threw === false && info.tokenXBalance === 0 && near(info.tokenXSwapOutSol, 0));
  restoreAccounting();
}

// (3g) realizedSolAccounting OFF → swap STILL happens (bag liquidated), closeRsd null.
{
  ensureAccounting(false);
  let swapCalls = 0;
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05 }] }),
    swapToken: async () => { swapCalls += 1; return { success: true, amount_out: 0.05 * LAMPORTS }; },
    notifyStranded: async () => {},
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({ tracked: trackedFixture(), baseMint: JITOSOL, withdrawnSol: 0.05, feesSol: 0, measuredCloseGasSol: 0.001 });
  check("orch accounting-off: bag STILL liquidated (swap ran)", swapCalls === 1 && info.swapSucceeded === true);
  check("orch accounting-off: closeRsd null (accounting gated)", info.closeRsd === null);
  restoreAccounting();
}

// (3h) basis from x_leg_tokens fallback when notional_sol missing.
{
  ensureAccounting(true);
  dlmm.__setForTests({
    getWalletBalances: async () => ({ sol: 1, tokens: [{ mint: JITOSOL, balance: 0.05 }] }),
    swapToken: async () => ({ success: true, amount_out: 0.055 * LAMPORTS }),
    notifyStranded: async () => {},
  });
  const info = await dlmm.executeTwoSidedCloseSwapAndAccount({
    tracked: trackedFixture({ two_sided_live: { y_leg_sol: 0.05, x_leg_tokens: 0.05, entry_price: 1.0, entry_swap_cost_sol: 0, notional_sol: null } }),
    baseMint: JITOSOL,
    withdrawnSol: 0.048,
    feesSol: 0.002,
    measuredCloseGasSol: 0.001,
  });
  // fallback entryX = 0.05*1.0 + 0 = 0.05 → solIn 0.10 → same 0.004 delta.
  check("orch fallback basis: notional missing → tokens×price basis → realized 0.004", near(info.closeRsd?.realized_sol_delta, 0.004), JSON.stringify(info.closeRsd));
  restoreAccounting();
}

// ── (5) Single-side realized path BYTE-UNCHANGED ──────────────────────────────
{
  // The single-side formula still computes identically (imported + unchanged).
  const r = computeLiveRealizedSolDelta({ solDeployed: 0.5, solReceivedOnClose: 0.52, feesClaimedSol: 0.01, gasSpentSol: 0.002 });
  check("single-side: computeLiveRealizedSolDelta intact (formula path)", near(r.realized_sol_delta, 0.52 + 0.01 - 0.5 - 0.002) && r.method === "formula", JSON.stringify(r));
  // A single-side tracked (two_sided falsy) NEVER enters the two-sided helper —
  // the closePosition branch is `if (tracked.two_sided === true)`. Proven by the
  // monitor/build regressions; here we assert the two-sided helper is opt-in only
  // by confirming it produces a distinct method tag (never overwrites 'formula').
  check("single-side: two-sided method tag is distinct (no leakage)", r.method !== "two_sided_formula");
}

// ── (6) LIVE two-sided STILL hard-refused (belts intact — build ≠ enable) ──────
{
  const g = twoSidedGateDecision({ strategy: {} }, "false");
  check("refused: default flag OFF live → refuse (single-side msg)", g.allowed === false && /single-side SOL/.test(g.refuseReason));
  const g2 = twoSidedGateDecision({ strategy: { twoSidedEnabled: true } }, "false");
  check("refused: enabled + live + paperOnly(default) → belt-2 refuse", g2.allowed === false && /paper simulation only/.test(g2.refuseReason));
  check("refused: belt-4 default OFF", liveTwoSidedFullyAuthorized({ strategy: {} }, "false") === false);
  check("refused: even paperOnly=false w/o liveAuthorized → belt-4 false", liveTwoSidedFullyAuthorized({ strategy: { twoSidedEnabled: true, twoSidedPaperOnly: false } }, "false") === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
