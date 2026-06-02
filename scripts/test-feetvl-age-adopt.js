/**
 * Intel adoption — fee/TVL high-preference + token-age sweet-spot SCORE BONUSES.
 * Cassiopeia 👁️ — evidence-based, ANTI-DORMANCY adoption of community/yunus intel.
 *
 * Adopted RESPONSIBLY:
 *   - fee/TVL "is KING" (claimed hard floor 0.20) → adopted as a RANKING bonus
 *     (ramp 0.10→0.20), NOT a 0.20 hard gate (would starve the funnel → dormancy).
 *   - token-age sweet spot 12-48h (claimed hard band) → adopted as a flat bonus in
 *     [12,48]h; maxTokenAgeHours NOT slashed to 48 (mature pools still deploy).
 *
 * Contract under test:
 *   - high fee/TVL (>= target) → full bonus; at/below floor → 0; ramp between
 *   - age in [12,48]h → full bonus; outside → 0
 *   - missing/non-finite/negative inputs → 0 (NEUTRAL, anti-pattern #2)
 *   - flags OFF (default) → 0
 *   - NEVER a gate: both fns return a number only; never reject
 *   - DORMANCY-SAFE: mature pools and low-fee/TVL pools are NOT mass-rejected
 *     (the hard floor stays modest; bonuses only re-rank)
 *
 * Run: node scripts/test-feetvl-age-adopt.js
 */
import assert from "assert";
import {
  feeTvlHighBonus,
  tokenAgeSweetSpotBonus,
  scoreCandidate,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

const FEE_ON = {
  feeTvlHighBonusEnabled: true, feeTvlHighBonusWeight: 250,
  feeTvlHighBonusFloor: 0.10, feeTvlHighBonusTarget: 0.20,
};
const FEE_OFF = { ...FEE_ON, feeTvlHighBonusEnabled: false };

const AGE_ON = {
  tokenAgeSweetSpotBonusEnabled: true, tokenAgeSweetSpotWeight: 200,
  tokenAgeSweetSpotLowHours: 12, tokenAgeSweetSpotHighHours: 48,
};
const AGE_OFF = { ...AGE_ON, tokenAgeSweetSpotBonusEnabled: false };

console.log("\nIntel adoption — fee/TVL + token-age score bonuses — Cassiopeia 👁️\n");

// ── 1. fee/TVL high-preference bonus ─────────────────────────
console.log("fee/TVL high-preference bonus (ramp 0.10→0.20):");
{
  // at/above the king target (0.20) → full weight
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.20 }, FEE_ON), 250);
  ok("fee/TVL 0.20 (king target) → full weight (250)");
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.35 }, FEE_ON), 250);
  ok("fee/TVL 0.35 (above king) → full weight capped (250), no penalty for extra");

  // midpoint 0.15 → halfway up the ramp → ~125 (float-tolerant)
  const mid = feeTvlHighBonus({ fee_active_tvl_ratio: 0.15 }, FEE_ON);
  assert.ok(Math.abs(mid - 125) < 1e-6, `0.15 → half ramp ~125 (got ${mid})`);
  ok("fee/TVL 0.15 → linear ramp half-weight (~125)");

  // at the floor (0.10) → 0 (no preference credit yet)
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.10 }, FEE_ON), 0);
  ok("fee/TVL 0.10 (at floor) → 0 credit");
  // below floor (still a valid deployable pool!) → 0 bonus, but NOT rejected here
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.07 }, FEE_ON), 0);
  ok("fee/TVL 0.07 (below floor) → 0 bonus (NOT rejected — anti-dormancy)");
}

// ── 2. fee/TVL fail-safe + flag-off ──────────────────────────
console.log("\nfee/TVL fail-safe (anti-pattern #2):");
{
  assert.strictEqual(feeTvlHighBonus({}, FEE_ON), 0);
  ok("missing fee/TVL → 0 neutral");
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: "abc" }, FEE_ON), 0);
  ok("non-finite fee/TVL → 0 neutral");
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: -0.5 }, FEE_ON), 0);
  ok("negative fee/TVL → 0 neutral (never penalize)");
  assert.strictEqual(feeTvlHighBonus({ fee_active_tvl_ratio: 0.25 }, FEE_OFF), 0);
  ok("flag OFF (default) → 0");
}

// ── 3. token-age sweet-spot bonus ────────────────────────────
console.log("\ntoken-age sweet-spot bonus [12,48]h:");
{
  // 12h passes (was rejected at the old 24h floor) AND gets full bonus
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 12 }, AGE_ON), 200);
  ok("age 12h (sweet-spot start) → full weight (200) — was rejected at old 24h floor");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 30 }, AGE_ON), 200);
  ok("age 30h (mid sweet-spot) → full weight (200)");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 48 }, AGE_ON), 200);
  ok("age 48h (sweet-spot end) → full weight (200)");

  // just outside band → 0 credit (but NOT rejected)
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 8 }, AGE_ON), 0);
  ok("age 8h (below band) → 0 credit");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 200 }, AGE_ON), 0);
  ok("age 200h (mature, above band) → 0 credit (NOT rejected — anti-dormancy)");

  // raw-pool path: derive from token_x.created_at (ms epoch)
  const createdAt24hAgo = Date.now() - 24 * 3_600_000;
  assert.strictEqual(
    tokenAgeSweetSpotBonus({ token_x: { created_at: createdAt24hAgo } }, AGE_ON),
    200,
  );
  ok("raw-pool created_at 24h ago → full weight (200) via derivation");
}

// ── 4. token-age fail-safe + flag-off ────────────────────────
console.log("\ntoken-age fail-safe (anti-pattern #2):");
{
  assert.strictEqual(tokenAgeSweetSpotBonus({}, AGE_ON), 0);
  ok("missing age → 0 neutral");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: "x" }, AGE_ON), 0);
  ok("non-finite age → 0 neutral");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: -5 }, AGE_ON), 0);
  ok("negative age → 0 neutral");
  assert.strictEqual(tokenAgeSweetSpotBonus({ token_age_hours: 30 }, AGE_OFF), 0);
  ok("flag OFF (default) → 0");
}

// ── 5. scoreCandidate integration (additive, never negative) ─
console.log("\nscoreCandidate integration:");
{
  const pool = { fee_active_tvl_ratio: 0.20, token_age_hours: 30, organic_score: 50 };
  const baseCfg = { ...FEE_OFF, ...AGE_OFF }; // both bonuses off
  const bonusCfg = { ...FEE_ON, ...AGE_ON };  // both on
  const baseScore  = scoreCandidate(pool, baseCfg);
  const bonusScore = scoreCandidate(pool, bonusCfg);
  // bonus adds exactly 250 (fee king) + 200 (age sweet) = 450
  assert.strictEqual(bonusScore - baseScore, 450, `expected +450 (got ${bonusScore - baseScore})`);
  ok("both bonuses ON → +450 over base (250 fee + 200 age), strictly additive");

  // high fee/TVL pool RANKS ABOVE a low fee/TVL pool of equal organic/vol
  const kingPool = { fee_active_tvl_ratio: 0.22, organic_score: 60 };
  const mehPool  = { fee_active_tvl_ratio: 0.07, organic_score: 60 };
  assert.ok(scoreCandidate(kingPool, FEE_ON) > scoreCandidate(mehPool, FEE_ON));
  ok("king fee/TVL pool out-ranks low fee/TVL pool (insight captured as preference)");

  // no bonus can drive score negative
  assert.ok(scoreCandidate({}, bonusCfg) >= 0);
  ok("empty pool with bonuses on → score >= 0 (additive, never penalizes)");
}

// ── 6. DORMANCY SAFETY — bonuses are NOT gates ───────────────
console.log("\nDORMANCY SAFETY (the whole point):");
{
  // A mature pool (well outside 12-48h) with low-but-passing fee/TVL must NOT be
  // rejected by the raw screen. The hard floor uses minFeeActiveTvlRatio, NOT the
  // bonus floor/target. Age max is generous (null/720), NOT 48.
  const matureModerate = {
    token_x: {
      symbol: "MATURE",
      address: "Mat1111111111111111111111111111111111111111",
      market_cap: 500_000,
      organic_score: 80,
      created_at: Date.now() - 300 * 3_600_000, // 300h old — way past 48h band
    },
    token_y: { symbol: "SOL", organic_score: 80 },
    dlmm_params: { bin_step: 100 },
    tvl: 50_000,
    fee_active_tvl_ratio: 0.09, // ABOVE a modest hard floor (0.06/0.08), BELOW bonus floor (0.10)
    volatility: 2,
    volume: 20_000,
    base_token_holders: 800,
  };
  const s = {
    minMcap: 150_000, maxMcap: 10_000_000, minHolders: 500, minVolume: 500,
    minTvl: 10_000, maxTvl: 150_000, minBinStep: 80, maxBinStep: 125,
    minFeeActiveTvlRatio: 0.08,  // modest hard floor — NOT 0.20, NOT the bonus floor
    minOrganic: 60, minQuoteOrganic: 60,
    blockedLaunchpads: [],
    minTokenAgeHours: 8,         // intel floor
    maxTokenAgeHours: null,      // generous — mature pools allowed (anti-dormancy)
    // bonuses ON — should re-rank, never reject
    ...FEE_ON, ...AGE_ON,
  };
  const reason = getRawPoolScreeningRejectReason(matureModerate, s);
  assert.strictEqual(reason, null, `mature/moderate pool must NOT be rejected (got: ${reason})`);
  ok("mature (300h) + fee/TVL 0.09 pool PASSES hard screen — funnel survives");

  // Same pool gets 0 bonus on both axes but is still a deployable candidate.
  assert.strictEqual(feeTvlHighBonus(matureModerate, FEE_ON), 0);
  assert.strictEqual(tokenAgeSweetSpotBonus(matureModerate, AGE_ON), 0);
  ok("...and it simply earns 0 bonus on both axes (ranked lower, NOT removed)");

  // Contrast: a 0.20 HARD floor (the rejected blind approach) WOULD have killed it.
  const blindHardFloor = { ...s, minFeeActiveTvlRatio: 0.20 };
  const blindReason = getRawPoolScreeningRejectReason(matureModerate, blindHardFloor);
  assert.ok(blindReason && blindReason.includes("fee/active-TVL"));
  ok("PROOF: a blind 0.20 hard floor WOULD reject this pool → why we ranked instead");
}

console.log(`\n✅ ALL ${passed} assertions passed — intel adopted, dormancy-safe.\n— Cassiopeia 👁️\n`);
