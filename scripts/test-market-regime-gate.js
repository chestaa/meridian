// Cassiopeia — Market-regime gate tests (STOP BLEED T3).
//
// ROOT CAUSE of T3 bleed (-$4.67): memecoin narrow-range pools deployed into a
// FALLING market get stopped out repeatedly. FIX: pause memecoin deploys on a
// CONFIRMED SOL downtrend; exempt blue-chip profiles (symmetric payoff, fine in a
// downtrend — Phase 1 ready). NOT a loosening — this only ADDS a pause.
//
// Covers:
//   classifyRegime (pure):
//     - SOL 24h <= downtrend threshold  → DOWNTREND
//     - SOL 24h >= uptrend threshold     → UPTREND
//     - SOL 24h in neutral band          → NEUTRAL
//     - threshold boundary (exactly at)  → inclusive DOWNTREND/UPTREND
//     - threshold written as +5 or -5     → treated identically (defensive abs)
//     - missing/non-finite change         → NEUTRAL (fail-safe, anti-pattern #2)
//   marketRegimeGateRejectReason (pure):
//     - DOWNTREND + memecoin pool         → paused (reject reason)
//     - DOWNTREND + blue-chip base        → exempt (null)
//     - NEUTRAL/UPTREND + memecoin        → deploy (null) — anti-dormancy
//     - missing regime (NEUTRAL)          → deploy (null) — fail-safe
//     - gate flag OFF                      → no-op (null) even in DOWNTREND
//   isMemecoinNarrowProfile (pure):
//     - random memecoin mint               → true (pausable)
//     - wSOL / USDC / USDT base             → false (exempt)
//   detectMarketRegime (integration, mocked fetch):
//     - CoinGecko downtrend payload         → DOWNTREND
//     - all sources fail                    → NEUTRAL (fail-safe), changePct null
//
// Run: node scripts/test-market-regime-gate.js

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
  classifyRegime,
  marketRegimeGateRejectReason,
  isMemecoinNarrowProfile,
  detectMarketRegime,
  _resetMarketRegimeCache,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MEME = "MEMExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const S = { regimeDowntrendThresholdPct: -5, regimeUptrendThresholdPct: 5 };

// ─── classifyRegime ────────────────────────────────────────────────
console.log("\nclassifyRegime (pure):");

check("SOL -7% → DOWNTREND", classifyRegime(-7, S).regime === "DOWNTREND");
check("SOL -5% (exact threshold) → DOWNTREND (inclusive)", classifyRegime(-5, S).regime === "DOWNTREND");
check("SOL -4.9% (just inside band) → NEUTRAL", classifyRegime(-4.9, S).regime === "NEUTRAL");
check("SOL 0% → NEUTRAL", classifyRegime(0, S).regime === "NEUTRAL");
check("SOL +3% → NEUTRAL", classifyRegime(3, S).regime === "NEUTRAL");
check("SOL +5% (exact threshold) → UPTREND (inclusive)", classifyRegime(5, S).regime === "UPTREND");
check("SOL +12% → UPTREND", classifyRegime(12, S).regime === "UPTREND");

// Defensive abs: threshold written as +5 should behave the same as -5 for downtrend.
check("downtrend threshold written +5 → still -5% downtrend", classifyRegime(-6, { regimeDowntrendThresholdPct: 5 }).regime === "DOWNTREND");
check("downtrend threshold written +5 → -3% still NEUTRAL", classifyRegime(-3, { regimeDowntrendThresholdPct: 5 }).regime === "NEUTRAL");

// FAIL-SAFE (anti-pattern #2): missing / non-finite → NEUTRAL, never DOWNTREND.
check("null change → NEUTRAL (fail-safe)", classifyRegime(null, S).regime === "NEUTRAL");
check("undefined change → NEUTRAL (fail-safe)", classifyRegime(undefined, S).regime === "NEUTRAL");
check("NaN change → NEUTRAL (fail-safe)", classifyRegime(NaN, S).regime === "NEUTRAL");
check("null change reasoning mentions data missing", /missing/i.test(classifyRegime(null, S).reasoning));

// Default thresholds when unset (-5 / +5).
check("no thresholds set → -6% DOWNTREND (default -5)", classifyRegime(-6, {}).regime === "DOWNTREND");
check("no thresholds set → +6% UPTREND (default +5)", classifyRegime(6, {}).regime === "UPTREND");

// ─── isMemecoinNarrowProfile ───────────────────────────────────────
console.log("\nisMemecoinNarrowProfile (pure):");

check("random meme base → memecoin (pausable)", isMemecoinNarrowProfile({ base: { mint: MEME } }) === true);
check("wSOL base → blue-chip (exempt)", isMemecoinNarrowProfile({ base: { mint: WSOL } }) === false);
check("USDC base → blue-chip (exempt)", isMemecoinNarrowProfile({ base: { mint: USDC } }) === false);
check("USDT base → blue-chip (exempt)", isMemecoinNarrowProfile({ base: { mint: USDT } }) === false);
check("missing base mint → memecoin (pausable, conservative)", isMemecoinNarrowProfile({ base: {} }) === true);

// ─── marketRegimeGateRejectReason ──────────────────────────────────
console.log("\nmarketRegimeGateRejectReason (pure):");

const S_ON = { ...S, marketRegimeGateEnabled: true };
const S_OFF = { ...S, marketRegimeGateEnabled: false };
const memePool = { name: "MEME-SOL", base: { mint: MEME } };
const bluePool = { name: "wSOL-USDC", base: { mint: WSOL } };

const DOWN = { regime: "DOWNTREND", reasoning: "SOL -7%" };
const NEU = { regime: "NEUTRAL", reasoning: "SOL -2%" };
const UP = { regime: "UPTREND", reasoning: "SOL +8%" };

check("DOWNTREND + memecoin → paused",
  marketRegimeGateRejectReason(memePool, DOWN, S_ON) === "market_regime_downtrend_memecoin_paused");
check("DOWNTREND + blue-chip base → exempt (null)",
  marketRegimeGateRejectReason(bluePool, DOWN, S_ON) === null);
check("NEUTRAL + memecoin → deploy (null) [anti-dormancy]",
  marketRegimeGateRejectReason(memePool, NEU, S_ON) === null);
check("UPTREND + memecoin → deploy (null) [anti-dormancy]",
  marketRegimeGateRejectReason(memePool, UP, S_ON) === null);
check("missing regime obj → deploy (null) [fail-safe]",
  marketRegimeGateRejectReason(memePool, null, S_ON) === null);
check("regime missing field → deploy (null) [fail-safe]",
  marketRegimeGateRejectReason(memePool, { regime: undefined }, S_ON) === null);
check("gate OFF + DOWNTREND + memecoin → no-op (null)",
  marketRegimeGateRejectReason(memePool, DOWN, S_OFF) === null);
check("gate flag absent → no-op (null) [opt-in safety]",
  marketRegimeGateRejectReason(memePool, DOWN, S) === null);

// ─── detectMarketRegime (integration, mocked fetch) ────────────────
console.log("\ndetectMarketRegime (mocked fetch):");

const realFetch = globalThis.fetch;

// Mock 1: CoinGecko returns a -8% 24h change → DOWNTREND.
globalThis.fetch = async (url) => {
  if (String(url).includes("coingecko")) {
    return { ok: true, json: async () => ({ solana: { usd: 140, usd_24h_change: -8.3 } }) };
  }
  return { ok: false, json: async () => ({}) };
};
_resetMarketRegimeCache();
const downResult = await detectMarketRegime({ s: S_ON, force: true });
check("CoinGecko -8.3% → regime DOWNTREND", downResult.regime === "DOWNTREND");
check("CoinGecko -8.3% → sol24hChangePct captured", Math.abs(downResult.sol24hChangePct - (-8.3)) < 1e-9);
check("CoinGecko source tagged", downResult.source === "coingecko");

// Mock 2: all sources fail → fail-safe NEUTRAL, changePct null.
globalThis.fetch = async () => { throw new Error("network down"); };
_resetMarketRegimeCache();
const failResult = await detectMarketRegime({ s: S_ON, force: true });
check("all sources fail → regime NEUTRAL (fail-safe)", failResult.regime === "NEUTRAL");
check("all sources fail → changePct null", failResult.sol24hChangePct === null);
check("all sources fail → source null", failResult.source === null);

// Mock 3: cache works — second call within TTL does NOT refetch.
let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount++;
  if (String(url).includes("coingecko")) {
    return { ok: true, json: async () => ({ solana: { usd: 150, usd_24h_change: 2.0 } }) };
  }
  return { ok: false, json: async () => ({}) };
};
_resetMarketRegimeCache();
await detectMarketRegime({ s: S_ON, force: true });
const countAfterFirst = fetchCount;
await detectMarketRegime({ s: S_ON }); // no force → should hit cache
check("regime cached within TTL (no refetch on 2nd call)", fetchCount === countAfterFirst);

globalThis.fetch = realFetch;

// ─── Summary ───────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
