// scripts/test-two-sided-live-build.js
// Vega 🔥 — LIVE two-sided deploy MACHINERY (BUILT, NOT ENABLED).
//
// Proves the three preconditions from Vega's standing VETO list are built + safe,
// AND that live two-sided is STILL hard-refused (build ≠ enable):
//
//   1. Real entry swap + two-sided deposit builds the deposit correctly (mocked).
//   2. Total-notional HARD cap REFUSES when Y + X-in-SOL > MAX_TWO_SIDED_NOTIONAL_SOL.
//   3. Chain assertion REFUSES non-wSOL-quote / non-LST base (fail-closed).
//   4. Stranded-asset detection FIRES on swap-ok / deploy-fail, NO auto-retry.
//   5. LIVE two-sided STILL hard-refused with belts on (outer gate + belt 4).
//   6. Single-side path unchanged (byte-for-byte refuse string; no new caps hit).
//
// Pure functions + orchestration via injected _testHooks. No LLM, RPC, or chain.

import {
  strictNum,
  twoSidedGateDecision,
  resolveTwoSidedMode,
  computeTwoSidedNotionalSol,
  MAX_TWO_SIDED_NOTIONAL_SOL,
  WSOL_MINT,
  resolveTwoSidedNotionalCapSol,
  liveTwoSidedFullyAuthorized,
  assertTwoSidedNotionalCap,
  assertTwoSidedChainLegs,
  computeTwoSidedEntryPlan,
  detectStrandedAsset,
} from "../tools/two-sided.js";
import { isLstMintFreezeExempt } from "../tools/screening.js";
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

const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"; // NOT exempt (fail-closed)
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const ORIGINAL_SINGLE_SIDE_MSG =
  "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.";

function cfg(strategy = {}) {
  return { strategy };
}

// ── constants ────────────────────────────────────────────────────────────────
check("MAX_TWO_SIDED_NOTIONAL_SOL === 0.20 (go-live)", MAX_TWO_SIDED_NOTIONAL_SOL === 0.2, `got ${MAX_TWO_SIDED_NOTIONAL_SOL}`);
check("WSOL_MINT correct", WSOL_MINT === "So11111111111111111111111111111111111111112");

// ── resolveTwoSidedNotionalCapSol (config tightens, never loosens) ─────────────
check("cap: unset → code ceiling 0.20", resolveTwoSidedNotionalCapSol(cfg()) === 0.2);
check("cap: config 0.05 tightens", resolveTwoSidedNotionalCapSol(cfg({ twoSidedNotionalCapSol: 0.05 })) === 0.05);
check("cap: config 0.5 CANNOT exceed ceiling", resolveTwoSidedNotionalCapSol(cfg({ twoSidedNotionalCapSol: 0.5 })) === 0.2);
check("cap: config 0 → code ceiling (fail-closed)", resolveTwoSidedNotionalCapSol(cfg({ twoSidedNotionalCapSol: 0 })) === 0.2);
check("cap: config null → code ceiling", resolveTwoSidedNotionalCapSol(cfg({ twoSidedNotionalCapSol: null })) === 0.2);

// ── liveTwoSidedFullyAuthorized (belt 4 — default OFF) ─────────────────────────
check("belt4: default → false", liveTwoSidedFullyAuthorized(cfg(), "false") === false);
check(
  "belt4: enabled+live+paperOnly=false but NO liveAuthorized → false",
  liveTwoSidedFullyAuthorized(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false }), "false") === false,
);
check(
  "belt4: enabled+live+paperOnly=false+liveAuthorized=true → TRUE",
  liveTwoSidedFullyAuthorized(
    cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false, twoSidedLiveAuthorized: true }),
    "false",
  ) === true,
);
check(
  "belt4: DRY_RUN forces false (never authorizes in paper)",
  liveTwoSidedFullyAuthorized(
    cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false, twoSidedLiveAuthorized: true }),
    "true",
  ) === false,
);
check(
  "belt4: paperOnly TRUE (default) blocks even with liveAuthorized",
  liveTwoSidedFullyAuthorized(cfg({ twoSidedEnabled: true, twoSidedLiveAuthorized: true }), "false") === false,
);

// ── PRECONDITION 2: total-notional HARD cap ────────────────────────────────────
{
  // 0.05 Y + 0.05 X-in-SOL = 0.10 total (== cap, allowed).
  const ok = assertTwoSidedNotionalCap({ amountYSol: 0.05, amountXTokens: 5, priceSolPerToken: 0.01, capSol: 0.1 });
  check("cap: 0.05 + 0.05 == 0.10 cap → ALLOWED", ok.ok === true, ok.reason || "");
  check("cap: notional total computed = 0.10", ok.notional?.total_notional_sol === 0.1, JSON.stringify(ok.notional));
}
{
  // 0.08 Y + 0.05 X-in-SOL = 0.13 > 0.10 → refuse.
  const bad = assertTwoSidedNotionalCap({ amountYSol: 0.08, amountXTokens: 5, priceSolPerToken: 0.01, capSol: 0.1 });
  check("cap: 0.13 > 0.10 → REFUSE", bad.ok === false);
  check("cap: refuse reason names exceed", /exceeds_cap/.test(bad.reason || ""), bad.reason || "");
}
{
  // token leg alone blows the cap even with tiny Y (anti-pattern #7 — token can't escape).
  const bad = assertTwoSidedNotionalCap({ amountYSol: 0.01, amountXTokens: 1000, priceSolPerToken: 0.01, capSol: 0.1 });
  check("cap: token leg 10 SOL cannot escape cap → REFUSE", bad.ok === false, bad.reason || "");
}
{
  // fail-closed: unverifiable price → refuse (NOT treat as zero exposure).
  const bad = assertTwoSidedNotionalCap({ amountYSol: 0.05, amountXTokens: 5, priceSolPerToken: null, capSol: 0.1 });
  check("cap: null price → REFUSE (unverifiable, not zero)", bad.ok === false);
  check("cap: unverifiable reason", /unverifiable/.test(bad.reason || ""), bad.reason || "");
}
{
  const bad = assertTwoSidedNotionalCap({ amountYSol: 0.05, amountXTokens: 5, priceSolPerToken: 0.01, capSol: 0 });
  check("cap: invalid cap 0 → REFUSE", bad.ok === false && /cap_invalid/.test(bad.reason || ""), bad.reason || "");
}

// ── PRECONDITION 3: chain-leg assertion (fail-closed) ──────────────────────────
{
  const ok = assertTwoSidedChainLegs({ quoteMint: WSOL_MINT, baseMint: JITOSOL, isBaseAllowed: isLstMintFreezeExempt });
  check("legs: wSOL quote + JitoSOL base → OK", ok.ok === true, ok.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({ quoteMint: USDC, baseMint: JITOSOL, isBaseAllowed: isLstMintFreezeExempt });
  check("legs: non-wSOL quote (USDC) → REFUSE", bad.ok === false && /quote_not_wsol/.test(bad.reason || ""), bad.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({ quoteMint: WSOL_MINT, baseMint: MEME, isBaseAllowed: isLstMintFreezeExempt });
  check("legs: non-LST base (memecoin) → REFUSE", bad.ok === false && /not_curated_lst/.test(bad.reason || ""), bad.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({ quoteMint: WSOL_MINT, baseMint: BSOL, isBaseAllowed: isLstMintFreezeExempt });
  check("legs: bSOL base (not in probed set) → REFUSE (fail-closed)", bad.ok === false, bad.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({ quoteMint: null, baseMint: JITOSOL, isBaseAllowed: isLstMintFreezeExempt });
  check("legs: missing quote → REFUSE", bad.ok === false && /quote_mint_missing/.test(bad.reason || ""), bad.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({ quoteMint: WSOL_MINT, baseMint: JITOSOL, isBaseAllowed: null });
  check("legs: missing predicate → REFUSE", bad.ok === false && /predicate_missing/.test(bad.reason || ""), bad.reason || "");
}
{
  const bad = assertTwoSidedChainLegs({
    quoteMint: WSOL_MINT,
    baseMint: JITOSOL,
    isBaseAllowed: () => {
      throw new Error("boom");
    },
  });
  check("legs: predicate throws → REFUSE", bad.ok === false && /predicate_threw/.test(bad.reason || ""), bad.reason || "");
}

// ── computeTwoSidedEntryPlan ───────────────────────────────────────────────────
{
  const plan = computeTwoSidedEntryPlan({ totalNotionalSol: 0.1, xSharePct: 0.5, priceSolPerToken: 0.02 });
  check("plan: 0.5 split → y 0.05 / x 0.05", plan.y_leg_sol === 0.05 && plan.x_leg_sol === 0.05, JSON.stringify(plan));
  check("plan: token target = xLeg/price = 2.5", plan.token_x_target === 2.5, JSON.stringify(plan));
}
check("plan: share 0 → null", computeTwoSidedEntryPlan({ totalNotionalSol: 0.1, xSharePct: 0, priceSolPerToken: 0.02 }) === null);
check("plan: share 1 → null (not two-sided)", computeTwoSidedEntryPlan({ totalNotionalSol: 0.1, xSharePct: 1, priceSolPerToken: 0.02 }) === null);
check("plan: price 0 → null", computeTwoSidedEntryPlan({ totalNotionalSol: 0.1, xSharePct: 0.5, priceSolPerToken: 0 }) === null);
check("plan: null total → null", computeTwoSidedEntryPlan({ totalNotionalSol: null, xSharePct: 0.5, priceSolPerToken: 0.02 }) === null);

// ── PRECONDITION (stranded): detectStrandedAsset ───────────────────────────────
{
  const s = detectStrandedAsset({ swapSucceeded: true, tokenXReceived: 5, depositSucceeded: false });
  check("stranded: swap-ok + deposit-fail → STRANDED", s.stranded === true);
  check("stranded: NO auto-retry", s.retry === false);
  check("stranded: alert present", typeof s.alert === "string" && /STRANDED/.test(s.alert));
  check("stranded: tokenXAmount reported", s.tokenXAmount === 5);
}
{
  const s = detectStrandedAsset({ swapSucceeded: true, tokenXReceived: 5, depositSucceeded: true });
  check("stranded: swap-ok + deposit-ok → NOT stranded", s.stranded === false);
}
{
  const s = detectStrandedAsset({ swapSucceeded: false, tokenXReceived: null, depositSucceeded: false });
  check("stranded: no swap → NOT stranded", s.stranded === false);
}
{
  const s = detectStrandedAsset({ swapSucceeded: true, tokenXReceived: 0, depositSucceeded: false });
  check("stranded: swap 'ok' but 0 token → NOT stranded (nothing to strand)", s.stranded === false);
}

// ── PRECONDITION 5: LIVE two-sided STILL hard-refused (belts on) ───────────────
{
  // Outer gate: flag OFF (default) → byte-for-byte original single-side message.
  const g = twoSidedGateDecision(cfg(), "false");
  check("gate: flag OFF live → refuse", g.allowed === false);
  check("gate: flag OFF msg BYTE-UNCHANGED", g.refuseReason === ORIGINAL_SINGLE_SIDE_MSG, g.refuseReason);
}
{
  // Outer gate: flag ON + LIVE + paperOnly default TRUE → paper-only belt refusal.
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "false");
  check("gate: flag ON live paperOnly=true → REFUSE (belt 2)", g.allowed === false && /paper simulation only/.test(g.refuseReason));
}
{
  // Outer gate: even paperOnly=false → belt 3 not-authorized refusal.
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true, twoSidedPaperOnly: false }), "false");
  check("gate: flag ON live paperOnly=false → REFUSE (belt 3)", g.allowed === false && /not implemented\/authorized/.test(g.refuseReason));
}
{
  // Paper still allowed (the lane we DO run).
  const g = twoSidedGateDecision(cfg({ twoSidedEnabled: true }), "true");
  check("gate: flag ON + DRY_RUN → ALLOWED (paper lane)", g.allowed === true);
}

// ── PRECONDITION 1 + orchestration: executeTwoSidedLiveDeposit (mocked) ─────────
// We authorize belt 4 for the orchestration test ONLY by mutating the shared config
// object in-process (NEVER touches user-config.json / DRY_RUN). Restored after.
const _saved = { ...config.strategy };
function authorizeLive() {
  config.strategy.twoSidedEnabled = true;
  config.strategy.twoSidedPaperOnly = false;
  config.strategy.twoSidedLiveAuthorized = true;
  config.strategy.twoSidedNotionalCapSol = 0.1;
  process.env.DRY_RUN = "false";
}
function restore() {
  config.strategy = { ..._saved };
  dlmm.__resetTests();
}

const baseCtx = {
  pool: {},
  pool_address: "PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  pool_name: "JitoSOL-SOL",
  baseMint: JITOSOL,
  quoteMint: WSOL_MINT,
  activeBin: { binId: 1000 },
  activePrice: 0.01, // SOL per token
  actualBinStep: 20,
  activeStrategy: "spot",
  strategyType: 0,
  finalAmountX: 5, // 5 token-X * 0.01 = 0.05 SOL X-leg
  finalAmountY: 0.05, // 0.05 SOL Y-leg → total 0.10 == cap
  activeBinsBelow: 30,
  activeBinsAbove: 30,
  bin_step: 20,
  normalizedVolatility: 3.5,
  fee_tvl_ratio: 0.1,
  organic_score: 80,
  initial_value_usd: 10,
  entryFeatures: {},
};

// (1a) happy path: swap ok + deposit ok → builds deposit correctly.
{
  authorizeLive();
  let swapArgs = null;
  let depositArgs = null;
  dlmm.__setForTests({
    swapToken: async (a) => {
      swapArgs = a;
      return { success: true, tx: "SWAPTX", amount_out: 5, amount_in: 0.05 };
    },
    depositTwoSidedSdk: async (a) => {
      depositArgs = a;
      return { success: true, position: "POS1", txs: ["DEPTX"] };
    },
    notifyStranded: async () => {},
  });
  const res = await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx });
  check("orch: happy path → success", res.success === true, JSON.stringify(res));
  check("orch: swap called wSOL→base for X-leg SOL 0.05", swapArgs?.input_mint === WSOL_MINT && swapArgs?.output_mint === JITOSOL && swapArgs?.amount === 0.05, JSON.stringify(swapArgs));
  check("orch: deposit got correct bins (970→1030)", depositArgs?.minBinId === 970 && depositArgs?.maxBinId === 1030, JSON.stringify({ min: depositArgs?.minBinId, max: depositArgs?.maxBinId }));
  check("orch: deposit got Y-leg 0.05 + token 5", depositArgs?.amountYSol === 0.05 && depositArgs?.tokenXReceived === 5, JSON.stringify(depositArgs));
  check("orch: returns notional total 0.10", res.notional?.total_notional_sol === 0.1, JSON.stringify(res.notional));
  check("orch: position tracked", res.position === "POS1");
  restore();
}

// (1b) stranded path: swap ok + deposit FAIL → stranded, alert fired, no retry.
{
  authorizeLive();
  let alertMsg = null;
  dlmm.__setForTests({
    swapToken: async () => ({ success: true, tx: "SWAPTX", amount_out: 5 }),
    depositTwoSidedSdk: async () => ({ success: false, error: "deposit reverted" }),
    notifyStranded: async (m) => {
      alertMsg = m;
    },
  });
  const res = await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx });
  check("orch: swap-ok/deposit-fail → success=false", res.success === false);
  check("orch: stranded flag true", res.stranded === true);
  check("orch: retry=false (anti-pattern #4)", res.retry === false);
  check("orch: token_x_stranded reported", res.token_x_stranded === 5);
  check("orch: operator alert fired", typeof alertMsg === "string" && /STRANDED/.test(alertMsg || ""));
  restore();
}

// (1c) deposit throws → treated as failure + stranded (swap already filled).
{
  authorizeLive();
  dlmm.__setForTests({
    swapToken: async () => ({ success: true, tx: "SWAPTX", amount_out: 5 }),
    depositTwoSidedSdk: async () => {
      throw new Error("rpc timeout");
    },
    notifyStranded: async () => {},
  });
  const res = await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx });
  check("orch: deposit throws + swap filled → stranded", res.stranded === true && res.success === false);
  restore();
}

// (1d) swap fails (no fill) → clean failure, NOT stranded, no deposit attempted.
{
  authorizeLive();
  let depositCalled = false;
  dlmm.__setForTests({
    swapToken: async () => ({ success: false, error: "no route" }),
    depositTwoSidedSdk: async () => {
      depositCalled = true;
      return { success: true };
    },
    notifyStranded: async () => {},
  });
  const res = await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx });
  check("orch: swap-fail → success=false, NOT stranded", res.success === false && res.stranded === false);
  check("orch: deposit NEVER attempted after swap fail", depositCalled === false);
  restore();
}

// (1e) belt 4 OFF → refuses before any swap (build ≠ enable).
{
  config.strategy.twoSidedEnabled = true;
  config.strategy.twoSidedPaperOnly = true; // belt 2 up
  config.strategy.twoSidedLiveAuthorized = false;
  process.env.DRY_RUN = "false";
  let swapCalled = false;
  dlmm.__setForTests({
    swapToken: async () => {
      swapCalled = true;
      return { success: true, amount_out: 5 };
    },
  });
  let threw = false;
  try {
    await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx });
  } catch (e) {
    threw = /not fully authorized/.test(e.message);
  }
  check("orch: belt4 OFF → THROWS refusal", threw === true);
  check("orch: belt4 OFF → swap NEVER called", swapCalled === false);
  restore();
}

// (1f) cap exceeded → refuses before any swap.
{
  authorizeLive();
  let swapCalled = false;
  dlmm.__setForTests({
    swapToken: async () => {
      swapCalled = true;
      return { success: true, amount_out: 5 };
    },
  });
  let threw = false;
  try {
    await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx, finalAmountY: 0.2 }); // 0.2 + 0.05 = 0.25 > 0.10
  } catch (e) {
    threw = /notional cap/.test(e.message);
  }
  check("orch: cap exceeded → THROWS before swap", threw === true);
  check("orch: cap exceeded → swap NEVER called", swapCalled === false);
  restore();
}

// (1g) non-wSOL quote → refuses before any swap.
{
  authorizeLive();
  let swapCalled = false;
  dlmm.__setForTests({ swapToken: async () => { swapCalled = true; return { success: true, amount_out: 5 }; } });
  let threw = false;
  try {
    await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx, quoteMint: USDC });
  } catch (e) {
    threw = /chain legs/.test(e.message);
  }
  check("orch: non-wSOL quote → THROWS before swap", threw === true);
  check("orch: non-wSOL quote → swap NEVER called", swapCalled === false);
  restore();
}

// (1h) non-LST base → refuses before any swap.
{
  authorizeLive();
  let swapCalled = false;
  dlmm.__setForTests({ swapToken: async () => { swapCalled = true; return { success: true, amount_out: 5 }; } });
  let threw = false;
  try {
    await dlmm.executeTwoSidedLiveDeposit({ ...baseCtx, baseMint: MEME });
  } catch (e) {
    threw = /chain legs/.test(e.message);
  }
  check("orch: non-LST base → THROWS before swap", threw === true);
  check("orch: non-LST base → swap NEVER called", swapCalled === false);
  restore();
}

// ── PRECONDITION 6: single-side untouched by all new machinery ─────────────────
{
  // Single-side means amount_x=0 → twoSidedGateDecision never consulted; but if the
  // LLM ever passes amount_x>0 with the flag off, the ORIGINAL message is returned.
  const g = twoSidedGateDecision(cfg(), "false");
  check("single-side invariant: flag-off refuse is the ORIGINAL string", g.refuseReason === ORIGINAL_SINGLE_SIDE_MSG);
  // resolveTwoSidedMode with default config → nothing enabled, live not allowed.
  const m = resolveTwoSidedMode(cfg(), "false");
  check("single-side invariant: default mode enabled=false", m.enabled === false);
  check("single-side invariant: default liveTwoSidedAllowed=false", m.liveTwoSidedAllowed === false);
}

// ── restore env ────────────────────────────────────────────────────────────────
delete process.env.DRY_RUN;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
