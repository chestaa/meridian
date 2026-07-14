// Cassiopeia 👁️ — Curated LST mint/freeze-authority exemption (Bro decision Option A).
//
// WHAT THIS PROVES (final Track-A paper-soak unblock):
//   1. THE EXEMPTION — a curated stake-pool LST (JitoSOL/mSOL/jupSOL) base leg with a
//      LIVE mint authority (mint_disabled:false) and/or LIVE freeze authority now PASSES
//      twoSidedBaseLegGateReason when the two-sided PAPER lane is active. Draco's on-chain
//      probe confirmed these mints are off-curve stake-pool PDAs (1:1 vs SOL, no rug).
//   2. NARROW SCOPE — the exemption clears ONLY mint + freeze. A rug-flagged, bundler-,
//      bot-, top10-, or dev_sold_all-tripping curated LST is STILL rejected.
//   3. NON-EXEMPT MINTS — bSOL (not probe-confirmed), a non-LST memecoin, and USDC/USDT
//      stables STILL reject on live mint authority. NOT a global requireMintRenounced off.
//   4. LANE ISOLATION — in LIVE (DRY_RUN!=='true') or flag-off, the exemption NEVER fires:
//      a curated LST with live mint authority is rejected exactly like the memecoin funnel.
//
// Run: node scripts/test-lst-mint-freeze-exempt.js

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  isLstMintFreezeExempt,
  twoSidedBaseLegGateReason,
} = await import("../tools/screening.js");
const { config } = await import("../config.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"; // in LST set but NOT probe-confirmed
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const DEGEN = "Deg3nMemeCoinAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const S = {
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};

// A base leg whose stake-pool mint AND freeze authority are BOTH live (as an LST reports),
// but which is otherwise clean (no rug, low concentration, no dev-sold, low bots).
function leg(baseMint, audit = {}, extra = {}) {
  return {
    name: `${baseMint.slice(0, 4)}-SOL`,
    token_x: { address: baseMint },
    token_y: { address: WSOL },
    audit: { mint_disabled: false, freeze_disabled: false, top_holders_pct: 20, bot_holders_pct: 5, ...audit },
    is_rugpull: false,
    ...extra,
  };
}

console.log("\n— 0. isLstMintFreezeExempt (curated allow-set) —");
{
  check("JitoSOL → exempt", isLstMintFreezeExempt(JITOSOL) === true);
  check("mSOL → exempt", isLstMintFreezeExempt(MSOL) === true);
  check("jupSOL → exempt", isLstMintFreezeExempt(JUPSOL) === true);
  check("bSOL → NOT exempt (not probe-confirmed)", isLstMintFreezeExempt(BSOL) === false);
  check("USDC → NOT exempt (stable, not LST)", isLstMintFreezeExempt(USDC) === false);
  check("USDT → NOT exempt (stable, not LST)", isLstMintFreezeExempt(USDT) === false);
  check("memecoin → NOT exempt", isLstMintFreezeExempt(DEGEN) === false);
  check("missing mint → false (fail-closed)", isLstMintFreezeExempt(null) === false);
}

console.log("\n— 1. LANE ACTIVE: curated LST mint/freeze EXEMPTED —");
{
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "true";

  check("JitoSOL base, mint+freeze LIVE → PASS (exempt)", twoSidedBaseLegGateReason(leg(JITOSOL), S) === null);
  check("mSOL base, mint+freeze LIVE → PASS (exempt)", twoSidedBaseLegGateReason(leg(MSOL), S) === null);
  check("jupSOL base, mint+freeze LIVE → PASS (exempt)", twoSidedBaseLegGateReason(leg(JUPSOL), S) === null);
  check("JitoSOL base, mint LIVE + freeze renounced → PASS", twoSidedBaseLegGateReason(leg(JITOSOL, { freeze_disabled: true }), S) === null);
}

console.log("\n— 2. NARROW SCOPE: exemption clears ONLY mint/freeze on curated LST —");
{
  // rug flag on the curated LST → STILL rejected.
  check("JitoSOL + rugpull flag → STILL liquidity_removal_rugpull",
    twoSidedBaseLegGateReason(leg(JITOSOL, {}, { is_rugpull: true }), S) === "liquidity_removal_rugpull");
  // top10 over cap → STILL rejected.
  check("JitoSOL + top10 82% > 60% → STILL top10_pct_above_cap",
    twoSidedBaseLegGateReason(leg(JITOSOL, { top_holders_pct: 82 }), S) === "top10_pct_above_cap");
  // bot holders over cap → STILL rejected.
  check("JitoSOL + bot 55% > 30% → STILL bot_holders_pct_above_cap",
    twoSidedBaseLegGateReason(leg(JITOSOL, { bot_holders_pct: 55 }), S) === "bot_holders_pct_above_cap");
  // dev_sold_all + high concentration → STILL rejected.
  check("JitoSOL + dev_sold_all + top10>cap → STILL dev_sold_all_high_concentration",
    twoSidedBaseLegGateReason(leg(JITOSOL, { top_holders_pct: 80 }, { dev_sold_all: true }), S) === "dev_sold_all_high_concentration");
  // top10 data missing (gate active) → STILL fail-closed reject (exemption doesn't touch it).
  check("JitoSOL + top10 data missing → STILL top10_data_unavailable (fail-closed)",
    twoSidedBaseLegGateReason(leg(JITOSOL, { top_holders_pct: undefined }), S) === "top10_data_unavailable");
}

console.log("\n— 3. NON-EXEMPT MINTS still reject on live mint authority —");
{
  check("bSOL (not probe-confirmed) + mint LIVE → mint_authority_not_renounced",
    twoSidedBaseLegGateReason(leg(BSOL), S) === "mint_authority_not_renounced");
  check("memecoin (BONK/WIF-style) + mint LIVE → mint_authority_not_renounced",
    twoSidedBaseLegGateReason(leg(DEGEN), S) === "mint_authority_not_renounced");
  check("USDC base + mint LIVE → mint_authority_not_renounced (stable not exempt)",
    twoSidedBaseLegGateReason(leg(USDC), S) === "mint_authority_not_renounced");
  check("USDT base + mint renounced, freeze LIVE → freeze_authority_not_renounced (stable not exempt)",
    twoSidedBaseLegGateReason(leg(USDT, { mint_disabled: true }), S) === "freeze_authority_not_renounced");
}

console.log("\n— 4. LANE ISOLATION: no exemption in LIVE / flag-off —");
{
  // LIVE (DRY_RUN=false) — curated LST mint-live STILL rejected (single-side funnel untouched).
  config.strategy.twoSidedEnabled = true;
  process.env.DRY_RUN = "false";
  check("JitoSOL, LIVE → mint_authority_not_renounced (no exemption in live)",
    twoSidedBaseLegGateReason(leg(JITOSOL), S) === "mint_authority_not_renounced");

  // flag OFF + DRY_RUN — lane inactive → curated LST mint-live STILL rejected.
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
  check("JitoSOL, flag OFF → mint_authority_not_renounced (no exemption when lane off)",
    twoSidedBaseLegGateReason(leg(JITOSOL), S) === "mint_authority_not_renounced");

  // restore defaults
  config.strategy.twoSidedEnabled = false;
  process.env.DRY_RUN = "true";
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
