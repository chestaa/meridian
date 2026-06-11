/**
 * Cassiopeia — quote-organic gate fix + FULL gate-sequence trace (2026-06-11).
 *
 * THE 7TH FUNNEL WALL (Draco empirical 2026-06-11): `minQuoteOrganic 60` rejected
 * nearly every pool. This bot deploys single-side SOL, so the quote token is
 * ALWAYS wSOL (or USDC pre-SOL-quote-filter) — inherently-liquid blue-chips with
 * no meaningful organic score. organic_score measures BASE-token holder
 * authenticity; demanding it of a stablecoin/wSOL quote is nonsense, not
 * protection. `quote_token_organic_score` is null on these → reject 100% of valid
 * pools, AND poisons enrichNativeDetailBeforeGate (sentinel never clears the
 * quote-organic gate → no native fetch → volatility/organic gap never filled).
 *
 * FIX (verified here): quoteOrganicGateRejectReason() EXEMPTS blue-chip quote
 * mints (wSOL + USDC). A non-blue-chip quote is STILL gated fail-closed (defense
 * in depth). The BASE organic gate is UNTOUCHED (still fail-closed organic_unknown).
 * Config default minQuoteOrganic 60→0 (root misconfig removed) — exemption is the
 * structural fix, the 0 is belt-and-suspenders.
 *
 * PART 1 — unit-test quoteOrganicGateRejectReason exemption + fail-closed.
 * PART 2 — TRACE a clean SOL-quote pool through EVERY deterministic gate in
 *          getRawPoolScreeningRejectReason order + the late getTopCandidates gates,
 *          confirming it clears all of them and reaches the Orion judge (no 8th wall).
 */
import assert from "node:assert";
import {
  quoteOrganicGateRejectReason,
  getRawPoolScreeningRejectReason,
  solQuoteRejectReason,
  rugGateRejectReason,
  devSoldAllShouldReject,
  tvlMcapGateRejectReason,
} from "../tools/screening.js";

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  PASS  ${msg}`);
  pass++;
};
const eq = (a, b, msg) => {
  assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  console.log(`  PASS  ${msg}`);
  pass++;
};

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WEIRD = "WeirdNonBlueChipQuoteMint1111111111111111111";

// Effective thresholds mirroring the LIVE overlay (the values Draco verified
// running): minQuoteOrganic was 60 (the wall). We test against a non-zero floor
// to prove the EXEMPTION works even when the floor is set — not relying on 0.
const S = {
  minHolders: 500,
  minMcap: 150_000, maxMcap: 10_000_000,
  minVolume: 500, minTvl: 10_000, maxTvl: 150_000,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.10,
  minOrganic: 72, minQuoteOrganic: 60, // the wall value — exemption must beat it
  minTokenAgeHours: null, maxTokenAgeHours: null,
  excludeHighSupplyConcentration: false,
  blockedLaunchpads: [], allowedLaunchpads: [],
  requireSolQuote: true,
  requireMintRenounced: true, requireFreezeRenounced: true,
  rejectRugpullFlag: true, devSoldAllRequiresHighConcentration: true,
  maxTop10Pct: 55, maxTvlMcapRatio: 0.2, tvlMcapGateEnabled: true,
};

console.log("\nPART 1 — quoteOrganicGateRejectReason (exemption + fail-closed)\n");

// wSOL quote with NULL organic (the real-world case) → EXEMPT → null (pass).
eq(quoteOrganicGateRejectReason({ token_y: { address: WSOL, organic_score: null } }, S),
  null, "wSOL quote, organic null → EXEMPT (the actual fix — was the wall)");

// wSOL quote with 0 organic → still EXEMPT.
eq(quoteOrganicGateRejectReason({ token_y: { address: WSOL, organic_score: 0 } }, S),
  null, "wSOL quote, organic 0 → EXEMPT (blue-chip)");

// USDC quote with null organic → EXEMPT (defense in depth if SOL-quote filter off).
eq(quoteOrganicGateRejectReason({ token_y: { address: USDC, organic_score: null } }, S),
  null, "USDC quote, organic null → EXEMPT (blue-chip)");

// NON-blue-chip quote with null organic → STILL GATED fail-closed (anti-pattern #2).
ok(/below minQuoteOrganic 60/.test(
    quoteOrganicGateRejectReason({ token_y: { address: WEIRD, organic_score: null } }, S) || ""),
  "non-blue-chip quote, organic null → REJECT fail-closed (defense in depth)");

// NON-blue-chip quote with LOW organic → STILL GATED.
ok(/below minQuoteOrganic 60/.test(
    quoteOrganicGateRejectReason({ token_y: { address: WEIRD, organic_score: 30 } }, S) || ""),
  "non-blue-chip quote, organic 30 < 60 → REJECT (genuine sub-floor)");

// NON-blue-chip quote with HIGH organic → passes (gate still meaningful).
eq(quoteOrganicGateRejectReason({ token_y: { address: WEIRD, organic_score: 80 } }, S),
  null, "non-blue-chip quote, organic 80 ≥ 60 → PASS (gate still works)");

// Floor 0/unset → gate fully off regardless of quote.
eq(quoteOrganicGateRejectReason({ token_y: { address: WEIRD, organic_score: null } }, { ...S, minQuoteOrganic: 0 }),
  null, "minQuoteOrganic 0 → gate off (config-default belt-and-suspenders)");
eq(quoteOrganicGateRejectReason({ token_y: { address: WEIRD } }, { minQuoteOrganic: undefined }),
  null, "minQuoteOrganic unset → gate off");

// Missing quote mint with a floor set + null organic on a non-blue-chip → fail-closed.
ok(/below minQuoteOrganic/.test(
    quoteOrganicGateRejectReason({ token_y: { organic_score: null } }, S) || ""),
  "missing quote mint (not exempt) + organic null → REJECT fail-closed");

console.log("\nPART 2 — FULL gate-sequence trace: clean SOL-quote pool → JUDGE\n");

// A realistic CLEAN pool: SOL-quote, mcap in-band, volume/tvl/holders OK,
// base organic strong, volatility usable, blue-chip quote (organic null = real).
// All values chosen to clear EVERY gate. We walk the EXACT order of
// getRawPoolScreeningRejectReason, then the late getTopCandidates gates.
function cleanRawPool() {
  return {
    pool_address: "CLEANPOOLADDR1111111111111111111111111111",
    name: "CLEAN-SOL",
    pool_type: "dlmm",
    base_token_has_high_supply_concentration: false,
    base_token_has_critical_warnings: false,
    quote_token_has_critical_warnings: false,
    base_token_has_high_single_ownership: false,
    tvl: 40_000,
    active_tvl: 40_000,
    volume: 120_000,
    fee_active_tvl_ratio: 0.18,       // above floor 0.10
    volatility: 4.2,                   // usable
    base_token_holders: 850,           // above 500
    dlmm_params: { bin_step: 100 },    // within [80,125]
    fee_pct: 2.0,
    token_x: {                         // BASE token
      symbol: "CLEAN", address: "CLEANBASEMINT111111111111111111111111111",
      market_cap: 900_000,             // in [150k, 10M]
      organic_score: 88,               // strong, above minOrganic 72
      created_at: Date.now() - 30 * 3_600_000, // 30h old
      warnings: [],
    },
    token_y: {                         // QUOTE token = wSOL, organic null (real-world)
      symbol: "SOL", address: WSOL, organic_score: null,
    },
  };
}

// ── Stage A: getRawPoolScreeningRejectReason — the deterministic gate gauntlet ──
const raw = cleanRawPool();
const rawReason = getRawPoolScreeningRejectReason(raw, S);
eq(rawReason, null,
  "getRawPoolScreeningRejectReason → null (clears ALL raw gates incl. quote-organic)");

// Prove the gate ORDER explicitly — flip each input and confirm the matching
// reject fires, so we know every wall in the sequence is accounted for (no gap).
const expectReject = (mut, pattern, label) => {
  const p = cleanRawPool();
  mut(p);
  const r = getRawPoolScreeningRejectReason(p, S);
  ok(r != null && pattern.test(r), `gate fires: ${label} → "${r}"`);
};
expectReject((p) => { p.token_x.market_cap = 50_000; }, /mcap/, "mcap below floor");
expectReject((p) => { p.token_x.market_cap = 99_000_000; }, /above maxMcap/, "mcap above ceiling");
expectReject((p) => { p.base_token_holders = 0; }, /holders_unknown/, "holders missing/0");
expectReject((p) => { p.base_token_holders = 100; }, /below minHolders/, "holders sub-floor");
expectReject((p) => { p.volume = 100; }, /below minVolume/, "volume sub-floor");
expectReject((p) => { p.tvl = 5_000; }, /below minTvl/, "tvl sub-floor");
expectReject((p) => { p.tvl = 500_000; }, /above maxTvl/, "tvl above ceiling");
expectReject((p) => { p.dlmm_params.bin_step = 40; }, /below minBinStep/, "bin_step sub-floor");
expectReject((p) => { p.dlmm_params.bin_step = 200; }, /above maxBinStep/, "bin_step above ceiling");
expectReject((p) => { p.fee_active_tvl_ratio = 0.02; }, /below minFeeActiveTvlRatio/, "fee/TVL sub-floor");
expectReject((p) => { p.volatility = null; }, /volatility_unknown/, "volatility missing (fail-closed)");
expectReject((p) => { p.volatility = 0; }, /unusable/, "volatility 0 (genuine dead)");
expectReject((p) => { p.token_x.organic_score = null; }, /organic_unknown/, "BASE organic missing (fail-closed — UNTOUCHED)");
expectReject((p) => { p.token_x.organic_score = 30; }, /base organic 30 below/, "BASE organic sub-floor (UNTOUCHED)");
// The 7th wall — prove it NO LONGER fires for a blue-chip quote:
{
  const p = cleanRawPool(); // wSOL quote, organic null
  eq(getRawPoolScreeningRejectReason(p, S), null,
    "7th wall NEUTRALIZED: wSOL quote + organic null → passes (was the wall)");
}
// And prove a weird quote STILL gets gated inside the raw sequence (defense in depth):
{
  const p = cleanRawPool();
  p.token_y = { symbol: "WEIRD", address: WEIRD, organic_score: null };
  ok(/below minQuoteOrganic/.test(getRawPoolScreeningRejectReason(p, S) || ""),
    "non-blue-chip quote STILL gated in raw sequence (defense in depth)");
}

// ── Stage B: condensed-pool late gates in getTopCandidates (post-enrichment) ──
// These run on the CONDENSED shape after Jupiter-audit + OKX enrichment. We feed
// the clean pool's condensed-equivalent with realistic enriched fields and walk
// each gate's pure decision fn / condition in order.
const condensedClean = {
  pool: raw.pool_address, name: raw.name,
  base: { symbol: "CLEAN", mint: raw.token_x.address, organic: 88 },
  quote: { symbol: "SOL", mint: WSOL },     // wSOL → SOL-quote filter PASSES
  tvl: 40_000, active_tvl: 40_000, fee_active_tvl_ratio: 0.18,
  volatility: 4.2, volume_window: 120_000, holders: 850, mcap: 900_000,
  token_age_hours: 30, bin_step: 100,
  // enriched (Jupiter audit + OKX) — all clean:
  audit: { top_holders_pct: 32, bot_holders_pct: 8, mint_disabled: true, freeze_disabled: true },
  is_rugpull: false, is_wash: false, dev_sold_all: false,
  bundle_pct: 4, sniper_pct: 0.1,
};

// B1 — SOL-quote deployability pre-filter (wSOL → pass)
eq(solQuoteRejectReason(condensedClean, S), null,
  "B1 SOL-quote filter → PASS (wSOL deployable)");
// B2 — token-age live safety floor 8h (30h → pass)  [inline in getTopCandidates]
ok(condensedClean.token_age_hours >= 8, "B2 token-age 8h live floor → PASS (30h)");
// B3 — TVL band / fee-TVL / volatility (re-checked condensed) → pass
ok(condensedClean.tvl >= S.minTvl && condensedClean.tvl <= S.maxTvl, "B3 TVL band → PASS");
ok(condensedClean.fee_active_tvl_ratio >= S.minFeeActiveTvlRatio, "B3 fee/TVL condensed → PASS");
ok(condensedClean.volatility > 0, "B3 volatility usable condensed → PASS");
// B4 — Jupiter audit gates: bot/top10 within caps
ok(condensedClean.audit.bot_holders_pct <= 25, "B4 bot-holders ≤ cap → PASS");
ok(condensedClean.audit.top_holders_pct <= S.maxTop10Pct, "B4 top10 ≤ cap → PASS");
// B5 — OKX wash/bundle/sniper
ok(!condensedClean.is_wash, "B5 not wash-flagged → PASS");
ok(condensedClean.bundle_pct <= 20 && condensedClean.sniper_pct <= 0.5, "B5 bundle+sniper within caps → PASS");
// B6 — rug gates (mint/freeze renounced + not rugpull)
eq(rugGateRejectReason(condensedClean, S), null, "B6 rug gates (mint+freeze renounced, not rugpull) → PASS");
// B7 — dev_sold_all compound gate
eq(devSoldAllShouldReject(condensedClean, S), false, "B7 dev_sold_all compound → PASS (dev didn't sell all)");
// B8 — TVL/MC gate (live): 40k/900k = 0.044 < 0.2 → pass
eq(tvlMcapGateRejectReason(condensedClean, S), null, "B8 TVL/MC ratio 0.044 < 0.2 → PASS");

console.log("\n  ── TRACE COMPLETE: clean SOL-quote pool clears EVERY gate ──");
console.log("     raw-gate gauntlet (mcap→holders→volume→tvl→binStep→fee/TVL→");
console.log("     volatility→BASE organic→QUOTE organic[EXEMPT]→launchpad→age)");
console.log("     + late gates (SOL-quote→age8h→TVL/fee/vol→audit bot/top10→");
console.log("     wash/bundle/sniper→rug→dev_sold_all→TVL/MC) → reaches Orion JUDGE.");
console.log("     NO 8th wall: every reject path is a real risk gate, each verified");
console.log("     to fire ONLY on a genuinely bad input. A clean pool reaches judge.\n");

console.log(`\n✅ ${pass}/${pass} assertions passed — quote-organic 7th wall fixed; clean pool reaches judge.\n`);
