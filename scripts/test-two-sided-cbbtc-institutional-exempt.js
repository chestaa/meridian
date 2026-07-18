// Vega 🔥 — Two-sided PAPER-lane cbBTC INSTITUTIONAL-ISSUER mint/freeze exemption.
//           (Bro decision Option (b), 2026-07-18 — curated issuer exemption, PAPER lane only.)
//
// CONTEXT: cbBTC (Coinbase-wrapped BTC) holds a LIVE mint authority AND a LIVE freeze
// authority — BOTH ACTIVE, ON-CURVE Coinbase keypairs (Draco on-chain probe 2026-07-18).
// The memecoin-calibrated mint/freeze gates flag it as `mint_authority_not_renounced` /
// `freeze_authority_not_renounced`, blocking the two-sided PAPER lane. This is NOT a
// mechanism-safe PDA (that's the LST case) — it is a TRUST decision: we exempt cbBTC only
// because we trust Coinbase, and the worst case (custodian freeze → token-X leg stranded)
// is BOUNDED to the token-leg notional (~0.1 SOL).
//
// WHAT THIS SUITE PROVES (per Vega's 5 VETO conditions):
//   1. NEW SET is SEPARATE from LST. isInstitutionalIssuerMintFreezeExempt fires ONLY for the
//      EXACT cbBTC mint; JLP (deferred), USDC/USDT, LST mints, memecoins, typosquats, null →
//      NOT exempt. isLstMintFreezeExempt is UNCHANGED (cbBTC not in it; LST mints still in it).
//   2. SCREENING base-leg gate — cbBTC with live mint+freeze PASSES twoSidedBaseLegGateReason
//      in the paper lane; rug/bot/top10/dev_sold_all STILL enforced (narrow scope).
//   3. EXACT MINT MATCH (typosquat guard) — a lookalike mint is NOT exempt (fail-closed).
//   4. LIVE PATH UNAFFECTED — LIVE (DRY_RUN!=='true') / flag-off never exempts cbBTC; the
//      live two-sided chain-leg allow-list stays LST-only (cbBTC live still refused).
//   5. EXECUTOR deploy thresholds — deep cbBTC-SOL clears maxTvl/fee/vol/binStep in the paper
//      lane; LIVE / flag-off / non-curated bases keep the memecoin gates byte-for-byte.
//   6. MEMECOIN LANE byte-unchanged.
//
// Run: node scripts/test-two-sided-cbbtc-institutional-exempt.js

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
process.env.DRY_RUN = "true";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  isInstitutionalIssuerMintFreezeExempt,
  isLstMintFreezeExempt,
  twoSidedBaseLegGateReason,
} = await import("../tools/screening.js");
const executor = await import("../tools/executor.js");
const { config } = await import("../config.js");

// ── Canonical mints ──────────────────────────────────────────────────────────
const WSOL   = "So11111111111111111111111111111111111111112";
const USDC   = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT   = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL   = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const JLP    = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"; // DEFERRED — must NOT be exempt
const CBBTC  = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"; // on-chain verified (Draco 2026-07-18)
const CBBTC_TYPOSQUAT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMiK"; // last char differs
const DEGEN  = "Deg3nMemeCoinAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const S = {
  requireMintRenounced: true,
  requireFreezeRenounced: true,
  rejectRugpullFlag: true,
  devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};

// A base leg whose mint AND freeze authority are BOTH live (as cbBTC reports on-chain),
// otherwise clean (no rug, low concentration, no dev-sold, low bots).
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

function setPaperLane(on) {
  config.strategy = config.strategy || {};
  config.strategy.twoSidedEnabled = on;
  config.strategy.twoSidedPaperOnly = true; // NEVER authorize live two-sided in this suite
}

// ── 0. Pure predicate — SEPARATE set, EXACT match, fail-closed ────────────────
console.log("\n— 0. isInstitutionalIssuerMintFreezeExempt (curated, exact, separate) —");
check("cbBTC (exact) → exempt", isInstitutionalIssuerMintFreezeExempt(CBBTC) === true);
check("cbBTC typosquat (1 char off) → NOT exempt (exact-match guard)",
  isInstitutionalIssuerMintFreezeExempt(CBBTC_TYPOSQUAT) === false);
check("JLP → NOT exempt (DEFERRED — VETO 4)", isInstitutionalIssuerMintFreezeExempt(JLP) === false);
check("USDC → NOT exempt", isInstitutionalIssuerMintFreezeExempt(USDC) === false);
check("USDT → NOT exempt", isInstitutionalIssuerMintFreezeExempt(USDT) === false);
check("JitoSOL → NOT institutional-exempt (it's LST, different set)",
  isInstitutionalIssuerMintFreezeExempt(JITOSOL) === false);
check("mSOL → NOT institutional-exempt", isInstitutionalIssuerMintFreezeExempt(MSOL) === false);
check("memecoin → NOT exempt", isInstitutionalIssuerMintFreezeExempt(DEGEN) === false);
check("null → false (fail-closed)", isInstitutionalIssuerMintFreezeExempt(null) === false);
check("undefined → false (fail-closed)", isInstitutionalIssuerMintFreezeExempt(undefined) === false);
check("empty string → false (fail-closed)", isInstitutionalIssuerMintFreezeExempt("") === false);
check("non-string (object) → false (fail-closed)", isInstitutionalIssuerMintFreezeExempt({}) === false);

console.log("\n— 0b. LST set UNCHANGED (regression — sets are disjoint) —");
check("cbBTC → NOT LST-exempt (not in LST set)", isLstMintFreezeExempt(CBBTC) === false);
check("JitoSOL → STILL LST-exempt", isLstMintFreezeExempt(JITOSOL) === true);
check("mSOL → STILL LST-exempt", isLstMintFreezeExempt(MSOL) === true);
check("JLP → NOT LST-exempt", isLstMintFreezeExempt(JLP) === false);

// ── 1. SCREENING base-leg gate: cbBTC PASSES in paper lane ────────────────────
console.log("\n— 1. LANE ACTIVE: cbBTC mint+freeze EXEMPTED (screening) —");
setPaperLane(true);
process.env.DRY_RUN = "true";
check("cbBTC base, mint+freeze LIVE → PASS (institutional exempt)",
  twoSidedBaseLegGateReason(leg(CBBTC), S) === null);
check("cbBTC base, mint LIVE + freeze renounced → PASS",
  twoSidedBaseLegGateReason(leg(CBBTC, { freeze_disabled: true }), S) === null);
check("JitoSOL base still PASS (LST lane unbroken by the new OR branch)",
  twoSidedBaseLegGateReason(leg(JITOSOL), S) === null);

// ── 2. NARROW SCOPE: only mint/freeze cleared on cbBTC ────────────────────────
console.log("\n— 2. NARROW SCOPE: exemption clears ONLY mint/freeze on cbBTC —");
check("cbBTC + rugpull flag → STILL liquidity_removal_rugpull",
  twoSidedBaseLegGateReason(leg(CBBTC, {}, { is_rugpull: true }), S) === "liquidity_removal_rugpull");
check("cbBTC + top10 82% > 60% → STILL top10_pct_above_cap",
  twoSidedBaseLegGateReason(leg(CBBTC, { top_holders_pct: 82 }), S) === "top10_pct_above_cap");
check("cbBTC + bot 55% > 30% → STILL bot_holders_pct_above_cap",
  twoSidedBaseLegGateReason(leg(CBBTC, { bot_holders_pct: 55 }), S) === "bot_holders_pct_above_cap");
check("cbBTC + dev_sold_all + top10>cap → STILL dev_sold_all_high_concentration",
  twoSidedBaseLegGateReason(leg(CBBTC, { top_holders_pct: 80 }, { dev_sold_all: true }), S) === "dev_sold_all_high_concentration");
check("cbBTC + top10 data missing → STILL top10_data_unavailable (fail-closed)",
  twoSidedBaseLegGateReason(leg(CBBTC, { top_holders_pct: undefined }), S) === "top10_data_unavailable");

// ── 3. NON-EXEMPT / typosquat bases still reject on live authority ────────────
console.log("\n— 3. non-exempt bases (incl. typosquat) still reject on live mint —");
check("cbBTC typosquat + mint LIVE → mint_authority_not_renounced (exact-match guard)",
  twoSidedBaseLegGateReason(leg(CBBTC_TYPOSQUAT), S) === "mint_authority_not_renounced");
check("JLP (deferred) + mint LIVE → mint_authority_not_renounced",
  twoSidedBaseLegGateReason(leg(JLP), S) === "mint_authority_not_renounced");
check("USDC + mint LIVE → mint_authority_not_renounced",
  twoSidedBaseLegGateReason(leg(USDC), S) === "mint_authority_not_renounced");
check("memecoin + mint LIVE → mint_authority_not_renounced",
  twoSidedBaseLegGateReason(leg(DEGEN), S) === "mint_authority_not_renounced");

// ── 4. LANE ISOLATION: no exemption in LIVE / flag-off ────────────────────────
console.log("\n— 4. LANE ISOLATION: cbBTC NOT exempt in LIVE / flag-off —");
config.strategy.twoSidedEnabled = true;
process.env.DRY_RUN = "false";
check("cbBTC, LIVE → mint_authority_not_renounced (no exemption in live)",
  twoSidedBaseLegGateReason(leg(CBBTC), S) === "mint_authority_not_renounced");
config.strategy.twoSidedEnabled = false;
process.env.DRY_RUN = "true";
check("cbBTC, flag OFF → mint_authority_not_renounced (lane inactive)",
  twoSidedBaseLegGateReason(leg(CBBTC), S) === "mint_authority_not_renounced");

// ── 5. EXECUTOR pure predicate matrix ─────────────────────────────────────────
console.log("\n— 5. isTwoSidedPaperInstitutionalExempt / isTwoSidedPaperExempt (executor) —");
setPaperLane(true);
process.env.DRY_RUN = "true";
check("paper lane + cbBTC base → institutional-exempt",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: CBBTC }) === true);
check("paper lane + cbBTC base → combined paper-exempt",
  executor.__isTwoSidedPaperExemptForTests({ base_mint: CBBTC }) === true);
check("paper lane + JitoSOL base → NOT institutional-exempt (but LST-exempt)",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: JITOSOL }) === false &&
  executor.__isTwoSidedPaperLstExemptForTests({ base_mint: JITOSOL }) === true &&
  executor.__isTwoSidedPaperExemptForTests({ base_mint: JITOSOL }) === true);
check("paper lane + typosquat base → NOT exempt",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: CBBTC_TYPOSQUAT }) === false);
check("paper lane + JLP base → NOT exempt (deferred)",
  executor.__isTwoSidedPaperExemptForTests({ base_mint: JLP }) === false);
check("paper lane + no base + detail token_x=cbBTC → exempt (legs from detail)",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({}, { token_x: { address: CBBTC }, token_y: { address: WSOL } }) === true);
check("paper lane + base_mint=WSOL but detail token_x=cbBTC → exempt (authoritative leg)",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: WSOL }, { token_x: { address: CBBTC }, token_y: { address: WSOL } }) === true);
setPaperLane(false);
check("flag OFF + cbBTC → NOT exempt (lane inactive)",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: CBBTC }) === false);
check("flag OFF + cbBTC → combined NOT exempt",
  executor.__isTwoSidedPaperExemptForTests({ base_mint: CBBTC }) === false);
setPaperLane(true);
process.env.DRY_RUN = "false";
check("LIVE (DRY_RUN=false) + cbBTC → NOT exempt (lane inactive)",
  executor.__isTwoSidedPaperInstitutionalExemptForTests({ base_mint: CBBTC }) === false);
process.env.DRY_RUN = "true";

// ── 6. EXECUTOR deploy thresholds — deep cbBTC-SOL clears the memecoin gates ──
console.log("\n— 6. deep cbBTC-SOL clears maxTvl/fee/vol/binStep (paper lane) —");
config.screening.maxTvl = 150_000;
config.screening.minTvl = 0;
config.screening.minFeeActiveTvlRatio = 0.10;
config.screening.bluechipMinFeeTvlRatio = 0.03;
config.screening.bluechipMaxVolatility = 1.5;
config.screening.bluechipMaxBinStep = 200;
config.screening.minBinStep = 80;
config.screening.maxBinStep = 125;
config.screening.timeframe = "5m";
config.screening.bluechipModeEnabled = false; // independence: NOT via bluechip income mode

function installDetail(detail) {
  executor.__setSnapshotFetchForTests(
    async () => ({ ok: true, json: async () => ({ data: [detail] }) }),
    [0, 0, 0, 0, 0],
  );
}
// Deep cbBTC-SOL: cbBTC = token_x (BASE), wSOL = token_y (QUOTE). $8M TVL (a BTC pool is
// deep), low fee/TVL, calm vol, fine bin_step 4 — the profile the memecoin gates mis-target.
function cbbtcSolDetail(overrides = {}) {
  return {
    token_x: { address: CBBTC },
    token_y: { address: WSOL },
    tvl: 8_000_000,
    fee_active_tvl_ratio: 0.004,
    fee_tvl_ratio: 0.004,
    volatility: 0.3,
    dlmm_params: { bin_step: 4 },
    ...overrides,
  };
}
function nonCuratedDeepDetail(baseMint = DEGEN, overrides = {}) {
  return {
    token_x: { address: baseMint },
    token_y: { address: WSOL },
    tvl: 8_000_000,
    fee_active_tvl_ratio: 0.15,
    fee_tvl_ratio: 0.15,
    volatility: 4.0,
    dlmm_params: { bin_step: 100 },
    ...overrides,
  };
}
async function verify(args) {
  return executor.__validateDeployPoolThresholdsForTests(args);
}

setPaperLane(true);
process.env.DRY_RUN = "true";
installDetail(cbbtcSolDetail());
{
  const r = await verify({ pool_address: "CBBTC_SOL", base_mint: CBBTC });
  check("cbBTC-SOL $8M (base_mint=cbBTC) → PASS (maxTvl exempt, fee dropped, binStep exempt)", r.pass === true);
}
installDetail(cbbtcSolDetail());
{
  const r = await verify({ pool_address: "CBBTC_SOL", base_mint: WSOL });
  check("cbBTC-SOL $8M (base_mint=WSOL, cbBTC on detail token_x) → PASS (authoritative leg)", r.pass === true);
}
installDetail(cbbtcSolDetail());
{
  const r = await verify({ pool_address: "CBBTC_SOL" });
  check("cbBTC-SOL $8M (no base_mint, legs from detail) → PASS", r.pass === true);
}
installDetail(cbbtcSolDetail({ fee_active_tvl_ratio: 0.0001, fee_tvl_ratio: 0.0001 }));
{
  const r = await verify({ pool_address: "CBBTC_SOL_LOWFEE", base_mint: CBBTC });
  check("cbBTC-SOL fee/TVL 0.0001 (below 0.03 & 0.10) → PASS (floor dropped)", r.pass === true);
}
installDetail(cbbtcSolDetail({ volatility: 2.5 }));
{
  const r = await verify({ pool_address: "CBBTC_SOL_VOLWILD", base_mint: CBBTC });
  check("cbBTC-SOL vol 2.5 > bluechipMaxVolatility 1.5 → REJECT (ceiling preserved)",
    r.pass === false && /bluechipMaxVolatility/.test(r.reason));
}
installDetail(cbbtcSolDetail({ dlmm_params: { bin_step: 0 } }));
{
  const r = await verify({ pool_address: "CBBTC_SOL_STEP0", base_mint: CBBTC });
  check("cbBTC-SOL bin_step 0 → REJECT (sanity bound, exemption ≠ no-check)",
    r.pass === false && /not a positive integer/.test(r.reason));
}
installDetail(cbbtcSolDetail({ tvl: null }));
{
  const r = await verify({ pool_address: "CBBTC_SOL_NOTVL", base_mint: CBBTC });
  check("cbBTC-SOL TVL UNKNOWN → REJECT (fail-closed, TVL read unconditional)",
    r.pass === false && /Could not verify pool TVL/.test(r.reason));
}

// ── 7. HARD ISOLATION — LIVE / flag-off / non-curated keep memecoin maxTvl ────
console.log("\n— 7. HARD ISOLATION — memecoin maxTvl still bites off the paper lane —");
process.env.DRY_RUN = "false";
installDetail(cbbtcSolDetail());
{
  const r = await verify({ pool_address: "CBBTC_SOL", base_mint: CBBTC });
  check("SAME cbBTC-SOL $8M in LIVE → REJECT (maxTvl, lane inactive → byte-unchanged)",
    r.pass === false && /maxTvl/.test(r.reason));
}
process.env.DRY_RUN = "true";
setPaperLane(false);
installDetail(cbbtcSolDetail());
{
  const r = await verify({ pool_address: "CBBTC_SOL", base_mint: CBBTC });
  check("cbBTC-SOL $8M, twoSidedEnabled=false → REJECT (maxTvl, lane inactive)",
    r.pass === false && /maxTvl/.test(r.reason));
}
setPaperLane(true);
installDetail(nonCuratedDeepDetail(JLP));
{
  const r = await verify({ pool_address: "JLP_SOL_DEEP", base_mint: JLP });
  check("deep JLP-SOL $8M (paper lane) → REJECT (JLP deferred, not curated → maxTvl bites)",
    r.pass === false && /maxTvl/.test(r.reason));
}
installDetail(nonCuratedDeepDetail(DEGEN));
{
  const r = await verify({ pool_address: "MEME_SOL_DEEP", base_mint: DEGEN });
  check("deep memecoin-SOL $8M (paper lane) → REJECT (not curated → maxTvl bites)",
    r.pass === false && /maxTvl/.test(r.reason));
}

// ── 8. MEMECOIN lane byte-unchanged ───────────────────────────────────────────
console.log("\n— 8. memecoin normal pool unaffected —");
installDetail(nonCuratedDeepDetail(DEGEN, { tvl: 80_000 }));
{
  const r = await verify({ pool_address: "MEME_OK", base_mint: DEGEN });
  check("memecoin normal (TVL 80k, fee 0.15, vol 4, bin_step 100) → PASS (unchanged)", r.pass === true);
}

executor.__resetSnapshotFetchForTests();
setPaperLane(false);
process.env.DRY_RUN = "true";

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
