// Cassiopeia 👁️ — Two-sided PAPER candidate lane (Track-A paper-soak).
//
// WHAT THIS PROVES:
//   1. LANE ISOLATION — the paper two-sided lane is active ONLY when
//      twoSidedEnabled AND DRY_RUN==="true". In live (DRY_RUN!=="true") OR flag-off,
//      every lane predicate is inert → the live single-side funnel is untouched.
//   2. SURFACING — an LST-SOL / bluechip pair IS a two-sided paper candidate when the
//      lane is active (and wSOL is the quote leg); a memecoin pair or a wSOL-base pool
//      is NOT.
//   3. BASE-LEG SAFETY MATTERS MORE — rug/mint/freeze/dev_sold_all/bot/top10 still
//      REJECT a bad base token in the two-sided path (fail-closed on missing data).
//   4. SYMMETRIC PREFERENCE — LST-SOL pairs rank first via the paper-lane rank bonus;
//      the bonus is 0 in live / flag-off (scoreCandidate ranking unchanged on live).
//
// Run: node scripts/test-two-sided-paper-lane.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  twoSidedPaperLaneActive,
  isLstSolPair,
  isTwoSidedPaperCandidate,
  twoSidedBaseLegGateReason,
  twoSidedPaperRankBonus,
  scoreCandidate,
} = await import("../tools/screening.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1";
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const DEGEN = "Deg3nMemeCoinAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // arbitrary non-bluechip

// LST-SOL pool in the RAW token_x/token_y shape (mint sort → LST=tokenX, wSOL=tokenY).
function lstSolPool(lstMint, name = "LST-SOL") {
  return { name, token_x: { address: lstMint }, token_y: { address: WSOL } };
}
// Condensed base/quote shape.
function condensed(baseMint, quoteMint, extra = {}) {
  return { name: `${baseMint.slice(0, 4)}-${quoteMint.slice(0, 4)}`, base: { mint: baseMint }, quote: { mint: quoteMint }, ...extra };
}

// Config helper: a cfg with a controllable two-sided strategy block.
function cfgWith(twoSidedEnabled, paperOnly = true) {
  return { strategy: { twoSidedEnabled, twoSidedPaperOnly: paperOnly } };
}

// Base-leg gate thresholds mirroring the live defaults.
const S = {
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};
// A CLEAN, fully-audited base leg (all safety data present + passing).
const CLEAN_AUDIT = { audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: false };

console.log("\n— 1. LANE ISOLATION (twoSidedPaperLaneActive) —");
{
  check("flag OFF + dry → lane inactive", twoSidedPaperLaneActive(cfgWith(false), "true") === false);
  check("flag ON + LIVE (DRY_RUN=false) → lane inactive", twoSidedPaperLaneActive(cfgWith(true), "false") === false);
  check("flag ON + DRY_RUN='1' (not exactly 'true') → lane inactive", twoSidedPaperLaneActive(cfgWith(true), "1") === false);
  check("flag ON + DRY_RUN='true' → lane ACTIVE", twoSidedPaperLaneActive(cfgWith(true), "true") === true);
  check("undefined cfg → inactive (fail-safe)", twoSidedPaperLaneActive(undefined, "true") === false);
}

console.log("\n— 2. isLstSolPair (symmetric-payoff identification) —");
{
  check("JitoSOL base + wSOL quote → true", isLstSolPair(JITOSOL, WSOL) === true);
  check("mSOL base + wSOL quote → true", isLstSolPair(MSOL, WSOL) === true);
  check("bSOL base + wSOL quote → true", isLstSolPair(BSOL, WSOL) === true);
  check("jupSOL base + wSOL quote → true", isLstSolPair(JUPSOL, WSOL) === true);
  check("JitoSOL base + USDC quote → false (not SOL-symmetric)", isLstSolPair(JITOSOL, USDC) === false);
  check("wSOL base + JitoSOL quote → false (wSOL not quote)", isLstSolPair(WSOL, JITOSOL) === false);
  check("USDC base + wSOL quote → false (stable, not LST)", isLstSolPair(USDC, WSOL) === false);
  check("missing leg → false", isLstSolPair(JITOSOL, null) === false);
}

console.log("\n— 3. SURFACING (isTwoSidedPaperCandidate) —");
{
  const active = cfgWith(true);
  // LST-SOL raw pool, lane active → candidate.
  check("JitoSOL-SOL, lane active → candidate", isTwoSidedPaperCandidate(lstSolPool(JITOSOL), active, "true") === true);
  check("mSOL-SOL, lane active → candidate", isTwoSidedPaperCandidate(lstSolPool(MSOL), active, "true") === true);
  // Same pool, LIVE → NOT a candidate (isolation).
  check("JitoSOL-SOL, LIVE → NOT candidate (isolation)", isTwoSidedPaperCandidate(lstSolPool(JITOSOL), active, "false") === false);
  // Same pool, flag OFF → NOT a candidate.
  check("JitoSOL-SOL, flag OFF → NOT candidate", isTwoSidedPaperCandidate(lstSolPool(JITOSOL), cfgWith(false), "true") === false);
  // Memecoin pair (random base) → NOT a candidate even when lane active.
  check("DEGEN-SOL, lane active → NOT candidate (not bluechip pair)", isTwoSidedPaperCandidate(condensed(DEGEN, WSOL), active, "true") === false);
  // Bluechip pair but wSOL on the BASE side (SOL-USDC) → NOT deployable → NOT candidate.
  check("SOL-USDC (wSOL=base), lane active → NOT candidate (wSOL not quote)", isTwoSidedPaperCandidate(condensed(WSOL, USDC), active, "true") === false);
  // USDT-USDC bluechip pair but no wSOL leg → NOT candidate.
  check("USDT-USDC (no wSOL leg), lane active → NOT candidate", isTwoSidedPaperCandidate(condensed(USDT, USDC), active, "true") === false);
  // Missing legs → fail-closed NOT candidate.
  check("missing legs, lane active → NOT candidate (fail-closed)", isTwoSidedPaperCandidate({ name: "?" }, active, "true") === false);
}

console.log("\n— 4. BASE-LEG SAFETY enforced on the HELD token (twoSidedBaseLegGateReason) —");
{
  // Clean base leg → passes.
  check("clean audited base leg → null (pass)", twoSidedBaseLegGateReason(CLEAN_AUDIT, S) === null);
  // Mint authority NOT renounced → reject.
  check("mint authority live → mint_authority_not_renounced",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: false, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: false }, S) === "mint_authority_not_renounced");
  // Freeze authority NOT renounced → reject.
  check("freeze authority live → freeze_authority_not_renounced",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: false, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: false }, S) === "freeze_authority_not_renounced");
  // Rugpull flag → reject.
  check("rugpull flag → liquidity_removal_rugpull",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 5 }, is_rugpull: true }, S) === "liquidity_removal_rugpull");
  // MISSING audit entirely → fail-closed reject (anti-pattern #2), NOT default-safe.
  check("missing audit → mint_authority_not_renounced (fail-closed)",
    twoSidedBaseLegGateReason({ is_rugpull: false }, S) === "mint_authority_not_renounced");
  // dev_sold_all + high concentration → reject.
  check("dev_sold_all + top10>cap → dev_sold_all_high_concentration",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 80, bot_holders_pct: 5 }, is_rugpull: false, dev_sold_all: true }, S) === "dev_sold_all_high_concentration");
  // top10 concentration over cap → reject.
  check("top10 82% > 60% cap → top10_pct_above_cap",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 82, bot_holders_pct: 5 }, is_rugpull: false }, S) === "top10_pct_above_cap");
  // bot holders over cap → reject.
  check("bot 55% > 30% cap → bot_holders_pct_above_cap",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: true, top_holders_pct: 20, bot_holders_pct: 55 }, is_rugpull: false }, S) === "bot_holders_pct_above_cap");
  // top10 data missing (gate active) → fail-closed reject.
  check("top10 data missing → top10_data_unavailable (fail-closed)",
    twoSidedBaseLegGateReason({ audit: { mint_disabled: true, freeze_disabled: true, bot_holders_pct: 5 }, is_rugpull: false }, S) === "top10_data_unavailable");
}

console.log("\n— 5. SYMMETRIC PREFERENCE + live isolation (twoSidedPaperRankBonus / scoreCandidate) —");
{
  const lst = lstSolPool(JITOSOL);
  const bcOther = condensed(USDT, WSOL);   // bluechip two-sided (USDT-SOL), not LST
  const meme = condensed(DEGEN, WSOL);

  // --- lane OFF (flag off) → bonus 0, scoreCandidate unaffected ---
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
  check("flag OFF → LST-SOL rank bonus 0", twoSidedPaperRankBonus(lst) === 0);

  // --- lane ON but LIVE → bonus 0 (live isolation of ranking) ---
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "false";
  check("flag ON + LIVE → LST-SOL rank bonus 0 (live ranking untouched)", twoSidedPaperRankBonus(lst) === 0);
  const liveScoreLst = scoreCandidate(lst, {});
  const liveScoreMeme = scoreCandidate(meme, {});
  check("LIVE: scoreCandidate carries NO two-sided bonus (lst==meme baseline)", liveScoreLst === liveScoreMeme);

  // --- lane ON + DRY_RUN → LST-SOL first, other bluechip second, memecoin none ---
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "true";
  check("PAPER: LST-SOL rank bonus = 100000 (first)", twoSidedPaperRankBonus(lst) === 100000);
  check("PAPER: other bluechip two-sided bonus = 50000 (second)", twoSidedPaperRankBonus(bcOther) === 50000);
  check("PAPER: memecoin pair bonus = 0", twoSidedPaperRankBonus(meme) === 0);
  check("PAPER: scoreCandidate(LST) > scoreCandidate(bluechip) > scoreCandidate(meme)",
    scoreCandidate(lst, {}) > scoreCandidate(bcOther, {}) && scoreCandidate(bcOther, {}) > scoreCandidate(meme, {}));

  // restore defaults
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
