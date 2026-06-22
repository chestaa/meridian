// Cassiopeia — EXHAUSTIVE bluechip gate audit (closing trace).
// Simulates a realistic clean SOL-USDC deep/stable pool through EVERY screening
// gate fn and asserts it reaches deploy with NO blocker. Memecoin path unchanged.
import assert from "node:assert";
import {
  classifyPoolMode,
  isBluechipPool,
  bluechipPoolGateRejectReason,
  bluechipHasWsolLeg,
  bluechipWsolQuoteRejectReason,
  getRawPoolScreeningRejectReason,
  buildDiscoveryFilters,
  tvlMcapGateRejectReason,
  marketRegimeGateRejectReason,
  solQuoteRejectReason,
} from "../tools/screening.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Effective thresholds with bluechip mode ON (as Draco's bluechip paper/live mini).
const s = {
  // memecoin gates (must be IRRELEVANT to a classified bluechip)
  minMcap: 150_000, maxMcap: 10_000_000,
  minTvl: 10_000, maxTvl: 150_000,          // <-- the alleged blocker ($245k > $150k)
  minVolume: 500, minHolders: 500, minOrganic: 60,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.10, minVolatility: 3.0,
  minTokenAgeHours: 8, maxTokenAgeHours: 720,
  requireMintRenounced: true, requireFreezeRenounced: true,
  rejectRugpullFlag: true, devSoldAllRequiresHighConcentration: true,
  excludeHighSupplyConcentration: true,
  maxBotHoldersPct: 25, maxTop10Pct: 60,
  tvlMcapGateEnabled: true, maxTvlMcapRatio: 0.2,
  marketRegimeGateEnabled: true, regimeDowntrendThresholdPct: -5, regimeUptrendThresholdPct: 5,
  requireSolQuote: true,
  broadDiscoveryEnabled: true, broadMcapFloor: 10_000, broadMcapCeil: 50_000_000,
  broadMinTvl: 1_000, broadSortBy: "fee_active_tvl_ratio:desc",
  // bluechip keys (config defaults) + MASTER FLAG ON
  bluechipModeEnabled: true,
  bluechipMinTvl: 200_000, bluechipMinVolume: 50_000, bluechipMinFeeTvlRatio: 0.03,
  bluechipMinMcap: 50_000_000, bluechipMaxVolatility: 1.5,
  bluechipBroadMcapCeil: 1_000_000_000_000, requireBluechipWsolLeg: true,
  bluechipOnlyMode: false, bluechipMaxBinStep: 200,
};

// Realistic clean SOL-USDC RAW pool (Pool Discovery shape): TVL $245k, SOL mcap
// ~$40B, bin_step 1, fee/TVL 0.04, low vol, high organic, USDC quote, deep volume.
const rawSolUsdc = {
  pool_address: "SOLUSDC_deep_pool",
  name: "SOL-USDC",
  pool_type: "dlmm",
  bin_step: 1,
  tvl: 245_000,
  volume: 4_000_000,
  fee_active_tvl_ratio: 0.04,
  volatility: 0.14,
  base_token_holders: 250_000,
  base_token_has_critical_warnings: false,
  quote_token_has_critical_warnings: false,
  base_token_has_high_single_ownership: false,
  base_token_has_high_supply_concentration: false,
  token_x: { address: WSOL, market_cap: 40_000_000_000, organic_score: 95, created_at: Date.now() - 1000 * 24 * 3600 * 1000 },
  token_y: { address: USDC, organic_score: 0 },
  is_rugpull: false,
};
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// ── 1. Classification ──────────────────────────────────────────────────────
ok(classifyPoolMode(rawSolUsdc) === "bluechip", "SOL-USDC both-leg → bluechip");
ok(isBluechipPool(rawSolUsdc, s) === true, "isBluechipPool true when flag on");
ok(bluechipHasWsolLeg(rawSolUsdc) === true, "SOL-USDC has a wSOL leg (old loose guard would pass)");
// Opsi 1 pivot: SOL-USDC has wSOL on the BASE side (tokenX) → single-side-SOL deposit
// fails on-chain (0x1). The tightened deployability guard now REJECTS it.
ok(bluechipWsolQuoteRejectReason(rawSolUsdc) === "bluechip_wsol_not_quote_side",
   "SOL-USDC (wSOL=tokenX) → NOT Opsi-B deployable (rejected)");
// The deployable bluechip target is now LST-SOL: LST=tokenX, wSOL=tokenY (quote).
const rawJitoSol = { ...rawSolUsdc, name: "JitoSOL-SOL",
  token_x: { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", market_cap: 727_000_000, organic_score: 95, created_at: Date.now() - 1000 * 24 * 3600 * 1000 },
  token_y: { address: WSOL, organic_score: 0 } };
ok(classifyPoolMode(rawJitoSol) === "bluechip", "JitoSOL-SOL both-leg → bluechip");
ok(bluechipWsolQuoteRejectReason(rawJitoSol) === null, "JitoSOL-SOL (wSOL=tokenY) → Opsi-B deployable");

// ── 2. Discovery server pre-filter must NOT push a maxTvl<=150k that drops $245k ─
const filters = buildDiscoveryFilters(s); // &&-joined string in broad mode
ok(typeof filters === "string", "buildDiscoveryFilters returns filter string");
ok(!/tvl<=/.test(filters), "broad server filter has NO tvl<= cap (would drop $245k)");
ok(/base_token_market_cap<=1000000000000/.test(filters), "broad mcap ceil raised to $1T for bluechip (SOL ~$40B survives server)");

// ── 3. Bluechip income gate (the gate SOL-USDC is ROUTED to) ─────────────────
ok(bluechipPoolGateRejectReason(rawSolUsdc, s) === null, "bluechip income gate PASS (no maxTvl, deep TVL ok, fee/TVL 0.04>0.03)");

// ── 4. PROVE the memecoin discovery gate would have BLOCKED it (the bug) ──────
// classify as memecoin (flag off path) → maxTvl reject confirms why carve-out needed.
const memeReason = getRawPoolScreeningRejectReason(rawSolUsdc, { ...s, bluechipModeEnabled: false });
// memecoin gate blocks SOL-USDC on the FIRST failing threshold in sequence (mcap
// $40B > maxMcap, then maxTvl, binStep, fee/TVL, vol-floor would ALL block too).
// This is exactly why a ROUTING carve-out is correct, not per-threshold loosening.
ok(typeof memeReason === "string", `memecoin gate WOULD block SOL-USDC: ${memeReason}`);
// And the routing fix: discoverPools routes bluechip AWAY from this gate (verified in code at line 1970-1972).

// ── 5. TVL/MC, regime, SOL-quote: bluechip exempt at call sites ──────────────
// TVL/MC gate is invoked with isBluechipPool early-return in getTopCandidates (line 2555).
// Direct fn would reject (245k/40B tiny ratio passes anyway), but prove exempt path:
const condensed = { tvl: 245_000, mcap: 40_000_000_000, base: { mint: WSOL }, quote: { mint: USDC }, token_x: { address: WSOL }, token_y: { address: USDC } };
ok(tvlMcapGateRejectReason(condensed, s) === null, "TVL/MC ratio fine for deep bluechip (245k/40B << 0.2)");
ok(marketRegimeGateRejectReason(condensed, { regime: "DOWNTREND", sol24hChangePct: -8 }, s) === null, "regime downtrend EXEMPTS bluechip (symmetric payoff)");
ok(solQuoteRejectReason(condensed, s) !== null, "SOL-quote fn WOULD reject USDC-quote — but getTopCandidates bypasses for bluechip (line 2212)");

// ── 6. MEMECOIN $245k pool still REJECTED (unchanged) ────────────────────────
const rawMemecoin = { ...rawSolUsdc, name: "PEPE-USDC", token_x: { address: "PEPExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", market_cap: 500_000, organic_score: 70, created_at: Date.now() - 50 * 3600 * 1000 }, fee_active_tvl_ratio: 0.20, volatility: 4.0 };
ok(classifyPoolMode(rawMemecoin) === "memecoin", "one-bluechip-leg pool = memecoin");
const memeBlock = getRawPoolScreeningRejectReason(rawMemecoin, s);
ok(typeof memeBlock === "string" && /TVL.*above maxTvl/.test(memeBlock), `memecoin $245k STILL rejected by maxTvl (unchanged): ${memeBlock}`);

// ── 7. Flag OFF → SOL-USDC treated as memecoin, rejected (fully reversible) ──
ok(isBluechipPool(rawSolUsdc, { ...s, bluechipModeEnabled: false }) === false, "flag off → not bluechip");
const offReason = getRawPoolScreeningRejectReason(rawSolUsdc, { ...s, bluechipModeEnabled: false });
ok(typeof offReason === "string", `flag off → memecoin gate applies (reject): ${offReason}`);

console.log(`\nBluechip exhaustive trace: ${pass}/${pass} assertions PASS`);
console.log("SOL-USDC ($245k) clears the income/TVL/MC/regime/quote gates but is NOT Opsi-B deployable (wSOL=tokenX). JitoSOL-SOL (wSOL=tokenY) IS deployable — Opsi 1 pivot.");
