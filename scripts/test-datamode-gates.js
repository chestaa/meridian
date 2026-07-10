// Cassiopeia 👁️ — DATA-COLLECTION-MODE gate set + entry_features passthrough tests.
//
// Validates the proposed live overlay (breadth loosening) AND the entry_features
// handoff Vega persists at deploy. Confirms:
//   - effectiveScreeningThresholds() surfaces the proposed floors in live
//     (minVolatility 2.5, minFeeActiveTvlRatio 0.10, minOrganic 60)
//   - orionMinConfidence 55 flows through liveOverlay()
//   - getRawPoolScreeningRejectReason honors the LOOSENED floors (a pool that failed
//     the PRIOR set now passes) while the NEVER-TOUCH gates stay strict
//   - buildEntryFeatures shapes full inputs, and records null (never fabricated) on
//     missing regime / flow / mcap (telemetry, not a gate → null is the honest value)
//
// Run: node scripts/test-datamode-gates.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { config } = await import("../config.js");
const { effectiveScreeningThresholds, liveOverlay, getRawPoolScreeningRejectReason, buildEntryFeatures } =
  await import("../tools/screening.js");

const originalDryRun = config.dryRun;
const originalOverrides = config.liveOverrides;

// The PROPOSED data-collection-mode overlay (loosened breadth gates only; the
// never-touch gates are kept at their strict values).
const PROPOSED = {
  minOrganic: 60,             // 72 → 60
  minVolatility: 2.5,         // 3.0 → 2.5
  maxBotHoldersPct: 25,       // NEVER TOUCH
  minFeeActiveTvlRatio: 0.10, // 0.15 → 0.10
  maxTop10Pct: 55,            // NEVER TOUCH
  orionMinConfidence: 55,     // 70 → 55
  tvlMcapGateEnabled: true,   // NEVER TOUCH
  maxTvlMcapRatio: 0.2,       // NEVER TOUCH
};

const WSOL = "So11111111111111111111111111111111111111112";

console.log("=== Cassiopeia — DATA-MODE gate set + entry_features tests ===\n");

// ── 1. Overlay surfaces the proposed floors in live ──
console.log("[1] effectiveScreeningThresholds() — proposed floors active in live");
{
  config.dryRun = false;
  config.liveOverrides = PROPOSED;
  const eff = effectiveScreeningThresholds();
  check("minVolatility = 2.5", eff.minVolatility === 2.5);
  check("minFeeActiveTvlRatio = 0.10", eff.minFeeActiveTvlRatio === 0.10);
  check("minOrganic = 60", eff.minOrganic === 60);
  check("liveOverlay().orionMinConfidence = 55", liveOverlay().orionMinConfidence === 55);
  // Never-touch: overlay carries the strict caps unchanged.
  check("maxBotHoldersPct kept 25", eff.maxBotHoldersPct === 25);
  check("maxTop10Pct kept 55", eff.maxTop10Pct === 55);
  check("maxTvlMcapRatio kept 0.2", eff.maxTvlMcapRatio === 0.2);
  check("tvlMcapGateEnabled kept true", eff.tvlMcapGateEnabled === true);
  // Never-touch base gates NOT in overlay → base values preserved.
  check("minMcap base preserved", eff.minMcap === config.screening.minMcap);
  check("maxMcap base preserved", eff.maxMcap === config.screening.maxMcap);
  check("minVolume base preserved", eff.minVolume === config.screening.minVolume);
  check("minHolders base preserved", eff.minHolders === config.screening.minHolders);
}

// ── 2. Raw gate honors the LOOSENED floors (marginal pool now passes) ──
console.log("\n[2] getRawPoolScreeningRejectReason — loosened floors admit a marginal pool");
{
  const eff = effectiveScreeningThresholds();
  // A pool sitting in the newly-admitted band: vol 2.6 (>=2.5, <3.0), fee/TVL 0.11
  // (>=0.10, <0.15), organic 65 (>=60, <72). Everything else strictly in-band.
  const marginal = {
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100 },
    tvl: 50_000,
    fee_active_tvl_ratio: 0.11,
    volatility: 2.6,
    volume: 5_000,
    base_token_holders: 800,
    token_x: { market_cap: 500_000, organic_score: 65, created_at: Date.now() - 48 * 3_600_000 },
    token_y: { address: WSOL },
  };
  check("marginal pool PASSES proposed gate", getRawPoolScreeningRejectReason(marginal, eff) === null);

  // Same pool under the PRIOR (tighter) set → rejected (proves the change is what admits it).
  const prior = { ...eff, minVolatility: 3.0, minFeeActiveTvlRatio: 0.15, minOrganic: 72 };
  const priorReason = getRawPoolScreeningRejectReason(marginal, prior);
  check("marginal pool REJECTED under prior tighter set", priorReason !== null);

  // Below the new floors still rejects (floors are real, not off).
  check("vol 2.4 < 2.5 → volatility floor reject",
    /below minVolatility/.test(getRawPoolScreeningRejectReason({ ...marginal, volatility: 2.4 }, eff) || ""));
  check("fee/TVL 0.09 < 0.10 → fee reject",
    /below minFeeActiveTvlRatio/.test(getRawPoolScreeningRejectReason({ ...marginal, fee_active_tvl_ratio: 0.09 }, eff) || ""));
  check("organic 59 < 60 → organic reject",
    /below minOrganic/.test(getRawPoolScreeningRejectReason({ ...marginal, token_x: { ...marginal.token_x, organic_score: 59 } }, eff) || ""));
}

// ── 3. Never-touch gates still bind under the proposed set ──
console.log("\n[3] never-touch gates remain enforced");
{
  const eff = effectiveScreeningThresholds();
  const base = {
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100 },
    tvl: 50_000,
    fee_active_tvl_ratio: 0.11,
    volatility: 2.6,
    volume: 5_000,
    base_token_holders: 800,
    token_x: { market_cap: 500_000, organic_score: 65, created_at: Date.now() - 48 * 3_600_000 },
    token_y: { address: WSOL },
  };
  // mcap band (left intentionally): out-of-band still rejects.
  check("mcap below 150k still rejected", /below minMcap/.test(getRawPoolScreeningRejectReason({ ...base, token_x: { ...base.token_x, market_cap: 50_000 } }, eff) || ""));
  check("mcap above 10M still rejected", /above maxMcap/.test(getRawPoolScreeningRejectReason({ ...base, token_x: { ...base.token_x, market_cap: 20_000_000 } }, eff) || ""));
  // minVolume (left intentionally).
  check("volume below 500 still rejected", /below minVolume/.test(getRawPoolScreeningRejectReason({ ...base, volume: 100 }, eff) || ""));
  // TVL band (left intentionally).
  check("TVL below 10k still rejected", /below minTvl/.test(getRawPoolScreeningRejectReason({ ...base, tvl: 5_000 }, eff) || ""));
  // Fail-closed missing data (NEVER TOUCH).
  check("missing holders → holders_unknown", getRawPoolScreeningRejectReason({ ...base, base_token_holders: null }, eff) === "holders_unknown");
  check("missing volatility → volatility_unknown", getRawPoolScreeningRejectReason({ ...base, volatility: null }, eff) === "volatility_unknown");
  check("missing organic → organic_unknown", getRawPoolScreeningRejectReason({ ...base, token_x: { ...base.token_x, organic_score: null } }, eff) === "organic_unknown");
  // Critical-warning / supply-concentration sanity flags (NEVER TOUCH).
  check("critical warnings still rejected", getRawPoolScreeningRejectReason({ ...base, base_token_has_critical_warnings: true }, eff) === "base token has critical warnings");
  check("high single ownership still rejected", getRawPoolScreeningRejectReason({ ...base, base_token_has_high_single_ownership: true }, eff) === "base token has high single ownership");
}

// ── 4. buildEntryFeatures — telemetry shape + honest-null on missing ──
console.log("\n[4] buildEntryFeatures — passthrough shape + null on missing");
{
  const regime = { regime: "NEUTRAL", sol24hChangePct: -2.3, source: "coingecko" };
  const candidate = { price_change_pct: 4.5, buy_vol: 12000, sell_vol: 9000, mcap: 500_000 };
  const ef = buildEntryFeatures(candidate, regime, 1234567890);
  check("regime threaded", ef.regime === "NEUTRAL");
  check("sol_24h_change_pct threaded", ef.sol_24h_change_pct === -2.3);
  check("regime_source threaded", ef.regime_source === "coingecko");
  check("price_change_pct threaded", ef.price_change_pct === 4.5);
  check("buy_vol threaded", ef.buy_vol === 12000);
  check("sell_vol threaded", ef.sell_vol === 9000);
  check("mcap threaded", ef.mcap === 500_000);
  check("captured_at threaded", ef.captured_at === 1234567890);

  // Missing regime (gate didn't run this cycle) → null, never fabricated.
  const efNoRegime = buildEntryFeatures(candidate, null, 111);
  check("null regime → regime null", efNoRegime.regime === null);
  check("null regime → sol_24h_change_pct null", efNoRegime.sol_24h_change_pct === null);
  check("null regime → regime_source null", efNoRegime.regime_source === null);
  check("null regime → real flow still threaded", efNoRegime.buy_vol === 12000);

  // Missing flow / mcap on candidate → null (honest gap, telemetry not a gate).
  const efSparse = buildEntryFeatures({}, regime, 222);
  check("missing price_change_pct → null", efSparse.price_change_pct === null);
  check("missing buy_vol → null", efSparse.buy_vol === null);
  check("missing sell_vol → null", efSparse.sell_vol === null);
  check("missing mcap → null", efSparse.mcap === null);
  check("regime still present when candidate sparse", efSparse.regime === "NEUTRAL");

  // Non-finite guards: Number(null)/NaN/undefined must NOT coerce to 0.
  const efBad = buildEntryFeatures({ buy_vol: "abc", sell_vol: undefined, mcap: NaN }, null, 333);
  check("non-numeric buy_vol → null (not 0)", efBad.buy_vol === null);
  check("undefined sell_vol → null (not 0)", efBad.sell_vol === null);
  check("NaN mcap → null (not 0)", efBad.mcap === null);
  check("captured_at defaults sensibly when omitted", Number.isFinite(buildEntryFeatures({}, null).captured_at));
}

// ── Restore ──
config.dryRun = originalDryRun;
config.liveOverrides = originalOverrides;

console.log(`\n${passed} assertions passed, ${failed} failed.`);
if (failed > 0) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
