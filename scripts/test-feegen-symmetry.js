/**
 * Item (a) Fee-Gen-Token — feeGenSymmetryBonus unit tests.
 * Cassiopeia 👁️ — verifies the balanced two-sided flow SCORE BONUS (proxy on
 * buy/sell volume symmetry; the Pool Discovery API has NO per-side fee field).
 *
 * Contract under test:
 *   - symmetric flow (band [0.4,0.6]) → positive bonus, max at 0.5
 *   - one-sided flow (outside band)  → 0
 *   - missing/zero side data         → 0 (NEUTRAL, never penalize — anti-pattern #2)
 *   - flag OFF (default)             → 0
 *   - NEVER a gate: feeGenSymmetryBonus only returns a number; never rejects.
 *
 * Run: node scripts/test-feegen-symmetry.js
 */
import assert from "assert";
import { feeGenSymmetryBonus, scoreCandidate } from "../tools/screening.js";

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

const W = 300;
const ON  = { feeGenSymmetryBonusEnabled: true,  feeGenSymmetryWeight: W };
const OFF = { feeGenSymmetryBonusEnabled: false, feeGenSymmetryWeight: W };

console.log("\nItem (a) Fee-Gen-Token symmetry bonus — Cassiopeia 👁️\n");

// ── 1. Symmetric flow → bonus ────────────────────────────────
{
  const perfect = feeGenSymmetryBonus({ buy_vol: 5000, sell_vol: 5000 }, ON);
  assert.strictEqual(perfect, W, `perfect 0.5 balance → full weight (got ${perfect})`);
  ok("perfect 50/50 flow → full weight (300)");

  // buyShare 0.45 → proximity = 1 - 0.05/0.1 = 0.5 → 150
  const slight = feeGenSymmetryBonus({ buy_vol: 4500, sell_vol: 5500 }, ON);
  assert.strictEqual(slight, W * 0.5, `45/55 → half weight (got ${slight})`);
  ok("45/55 flow → triangular half weight (150)");

  // edge of band buyShare 0.4 → proximity 0 → 0 (band-inclusive but zero credit)
  const edge = feeGenSymmetryBonus({ buy_vol: 4000, sell_vol: 6000 }, ON);
  assert.strictEqual(edge, 0, `band edge 0.4 → zero credit (got ${edge})`);
  ok("band edge (0.4 share) → zero credit (triangular floor)");
}

// ── 2. One-sided flow → 0 ────────────────────────────────────
{
  const buyHeavy = feeGenSymmetryBonus({ buy_vol: 9000, sell_vol: 1000 }, ON);
  assert.strictEqual(buyHeavy, 0, `90/10 buy-heavy → 0 (got ${buyHeavy})`);
  ok("90/10 buy-heavy (outside band) → 0");

  const sellHeavy = feeGenSymmetryBonus({ buy_vol: 500, sell_vol: 9500 }, ON);
  assert.strictEqual(sellHeavy, 0, `sell-heavy → 0 (got ${sellHeavy})`);
  ok("5/95 sell-heavy (outside band) → 0");
}

// ── 3. Missing / zero data → 0 NEUTRAL ───────────────────────
{
  assert.strictEqual(feeGenSymmetryBonus({}, ON), 0);
  ok("both sides missing → 0 neutral");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: 5000 }, ON), 0);
  ok("sell_vol missing → 0 neutral (no assumed default)");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: null, sell_vol: null }, ON), 0);
  ok("null sides → 0 neutral");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: 0, sell_vol: 0 }, ON), 0);
  ok("zero total volume → 0 neutral");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: "abc", sell_vol: "xyz" }, ON), 0);
  ok("non-numeric sides → 0 neutral");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: -100, sell_vol: 5000 }, ON), 0);
  ok("negative side → 0 neutral");
}

// ── 4. Flag OFF (default) → 0 ────────────────────────────────
{
  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: 5000, sell_vol: 5000 }, OFF), 0);
  ok("flag OFF → 0 even for perfectly symmetric pool (opt-in)");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: 5000, sell_vol: 5000 }, undefined), 0);
  ok("no cfg → 0 (backward-compatible)");

  assert.strictEqual(feeGenSymmetryBonus({ buy_vol: 5000, sell_vol: 5000 }, { feeGenSymmetryBonusEnabled: true, feeGenSymmetryWeight: 0 }), 0);
  ok("weight 0 → 0 (inert)");
}

// ── 5. NEVER a gate — integration via scoreCandidate ─────────
{
  const pool = { fee_active_tvl_ratio: 0.01, organic_score: 70, volume_window: 1000, holders: 300 };
  const base = scoreCandidate(pool, OFF);

  // one-sided pool still scores normally (NOT rejected/zeroed) — symmetry only ADDS
  const oneSided = scoreCandidate({ ...pool, buy_vol: 9000, sell_vol: 1000 }, ON);
  assert.strictEqual(oneSided, base, "one-sided pool keeps its base score (bonus is additive 0, never a penalty/gate)");
  ok("one-sided pool NOT penalized — symmetry never gates, only adds");

  const symmetric = scoreCandidate({ ...pool, buy_vol: 5000, sell_vol: 5000 }, ON);
  assert.strictEqual(symmetric, base + W, "symmetric pool gets base + full bonus");
  assert.ok(symmetric > oneSided, "symmetric ranks above one-sided");
  ok("symmetric pool ranks above one-sided (score bonus working)");

  // flag off → scoreCandidate unchanged vs no-flow baseline
  assert.strictEqual(scoreCandidate({ ...pool, buy_vol: 5000, sell_vol: 5000 }, OFF), base);
  ok("scoreCandidate unaffected when flag OFF");
}

console.log(`\n  ${passed} assertions passed ✅\n— Cassiopeia 👁️\n`);
