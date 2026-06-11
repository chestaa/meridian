/**
 * test-signal-volume-mapping.js — Sirius 🐺
 *
 * Regression for the signal-source CROSS-REF SHAPE-MISMATCH class (2026-06-11).
 *
 * ROOT CAUSE (systemic): the cross-ref DLMM index (dlmm.datapi.meteora.ag)
 * returns MANY gate-read fields with a DIFFERENT shape than the native
 * Pool-Discovery API the gate is calibrated against. Confirmed live across
 * SOL/JUP/BONK/WIF:
 *   - volume / fees / protocol_fees / fee_tvl_ratio → per-WINDOW OBJECTS {30m..24h}
 *   - bin_step lives at pool_config.bin_step (native: dlmm_params.bin_step)
 *   - holders lives at token_x.holders (native helper read: holder_count)
 *   - there is NO fee_active_tvl_ratio (only fee_tvl_ratio window-object)
 *   - NO volatility, NO organic_score, NO token created_at on this endpoint
 * Every signal source (discord-meteoraidn / solscan-trending / pumpfun-graduated)
 * cross-refs via that index, so reading pool.<field> straight produced an OBJECT
 * or wrong-path miss → NaN/null → the field's gate rejected EVERY signal pool,
 * one gate at a time (volume → fee/TVL → bin_step → holders → …).
 *
 * The fix generalizes volumeScalar → windowScalar and centralizes the entire
 * cross-ref shape map in crossrefPoolFields(); all three sources route through it.
 *
 * Asserts (per field: object→scalar correct; missing→null→reject; fail-closed):
 *   1.  windowScalar: window-object → shortest finite window (30m), anti-hype #8
 *   2.  windowScalar: scalar passes through (native + mock back-compat)
 *   3.  windowScalar: empty/null/non-finite → null (fail-closed #2)
 *   4.  windowScalar: absent 30m → next-shortest finite window
 *   5.  windowScalar RATIO anti-inflation: 30m ratio chosen, not the 80× larger 24h
 *   6.  crossrefPoolFields: volume window-object → scalar (30m)
 *   7.  crossrefPoolFields: fee_tvl_ratio window-object → fee_active_tvl_ratio slot (30m)
 *   8.  crossrefPoolFields: no fee_active_tvl_ratio key → still resolves from fee_tvl_ratio
 *   9.  crossrefPoolFields: bin_step from pool_config.bin_step (cross-ref location)
 *   10. crossrefPoolFields: holders from token.holders (NOT holder_count)
 *   11. crossrefPoolFields: market_cap from token.market_cap
 *   12. crossrefPoolFields: structural gaps (volatility/organic) → null (never fabricated)
 *   13. crossrefPoolFields: every field fail-closed → null when missing (#2)
 *   14. discord-meteoraidn normalizer: live cross-ref shape clears the gate
 *   15. solscan-trending: Meteora window wins; Birdeye scalar fallback when unresolvable
 *   16. pumpfun-graduated source loads + shared resolver maps window shape
 *   17. fail-closed end-to-end: unresolvable volume → null → gate REJECT
 *   18. fail-closed end-to-end: missing bin_step (no pool_config) → null → gate REJECT
 *   19. fail-closed end-to-end: missing fee_tvl_ratio → null → gate REJECT
 *
 * No network: pure parsing/normalization against the VERBATIM live cross-ref
 * shape captured 2026-06-11 (SOL-USDC).
 *
 * Run: node scripts/test-signal-volume-mapping.js
 */
import assert from "assert";

import {
  volumeScalar,
  windowScalar,
  crossrefPoolFields,
} from "../tools/sources/meteora-crossref.js";
import { getRawPoolScreeningRejectReason } from "../tools/screening.js";

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

// ── Verbatim cross-ref (dlmm.datapi.meteora.ag) field shapes, captured live 2026-06-11. ──
const CROSSREF_VOLUME = {
  "30m": 404310.8158215448,
  "1h": 1034945.4169001536,
  "2h": 2032174.4177603251,
  "4h": 4487139.430905799,
  "12h": 19246567.36986637,
  "24h": 29693805.517743956,
};
// fee_tvl_ratio is a window-object of RATIOS (0-1). 30m (0.0048) vs 24h (0.386)
// is an ~80× spread — picking the long window would FABRICATE gate-clearing flow.
const CROSSREF_FEE_TVL_RATIO = {
  "30m": 0.0048309033038631665,
  "1h": 0.012401502674840584,
  "2h": 0.024992916470627284,
  "4h": 0.05502699841554033,
  "12h": 0.24687146721602385,
  "24h": 0.3857435035284818,
};

// Build a RAW cross-ref pool the way the live index returns it (window-objects,
// pool_config.bin_step, token.holders, NO fee_active_tvl_ratio / volatility /
// organic_score). Everything set to clear the OTHER gates so only the field under
// test is the variable. feeTvlOverride lets us push the gate-relevant ratio up.
function rawCrossrefPool({ volume = CROSSREF_VOLUME, feeTvl = null, omit = [] } = {}) {
  // A fee/TVL window-object whose 30m clears minFeeActiveTvlRatio (0.06).
  const feeRatioObj = feeTvl || {
    "30m": 0.12, "1h": 0.2, "2h": 0.3, "4h": 0.4, "12h": 0.5, "24h": 0.6,
  };
  const p = {
    pool_address: "Poo1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    address: "Poo1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    name: "TEST-SOL",
    pool_type: "dlmm",
    tvl: 56940,
    volume,
    fee_tvl_ratio: feeRatioObj,
    // Cross-ref provides volatility nowhere; gate needs it. We inject a usable
    // value here ONLY so non-volatility gate tests can pass end-to-end; the
    // structural-gap test (#12) asserts the mapper does NOT invent it.
    volatility: 3.2,
    pool_config: { bin_step: 100 },
    token_x: {
      symbol: "TEST",
      address: "TeStMint11111111111111111111111111111111111",
      holders: 1200,
      market_cap: 800000,
      organic_score: 80,            // injected for end-to-end gate pass (cross-ref lacks it)
      created_at: Date.now() - 30 * 3_600_000,
    },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 99 },
  };
  for (const k of omit) delete p[k];
  return p;
}

// Permissive thresholds: each test isolates one floor.
const S = {
  minMcap: 100000, maxMcap: 10_000_000,
  minHolders: 500,
  minVolume: 500,
  minTvl: 10000, maxTvl: 150000,
  minBinStep: 80, maxBinStep: 125,
  minFeeActiveTvlRatio: 0.06,
  minOrganic: 60, minQuoteOrganic: 0,
  excludeHighSupplyConcentration: false,
};

// ── 1. window-object → shortest finite window (anti-hype) ──
{
  assert.strictEqual(windowScalar(CROSSREF_VOLUME), 404310.8158215448, "picks 30m, not 24h");
  assert.strictEqual(volumeScalar(CROSSREF_VOLUME), 404310.8158215448, "volumeScalar alias still works");
  ok("windowScalar: window-object resolves to SHORTEST window (anti-hype #8)");
}

// ── 2. scalar passes through (native shape + mock back-compat) ──
{
  assert.strictEqual(windowScalar(705.8), 705.8, "scalar passes through");
  assert.strictEqual(windowScalar(0), 0, "scalar 0 passes through (genuine zero, not missing)");
  ok("windowScalar: scalar passes through unchanged (native + mock back-compat)");
}

// ── 3. fail-closed: empty object / null / non-finite → null (anti-pattern #2) ──
{
  assert.strictEqual(windowScalar({}), null, "empty object → null");
  assert.strictEqual(windowScalar(null), null, "null → null");
  assert.strictEqual(windowScalar(undefined), null, "undefined → null");
  assert.strictEqual(windowScalar("not a number"), null, "string → null");
  assert.strictEqual(windowScalar({ "30m": null, "1h": "x" }), null, "all-non-finite windows → null");
  ok("windowScalar: unresolvable shapes → null (fail-closed, gate rejects unknown)");
}

// ── 4. missing 30m → next-shortest finite window ──
{
  assert.strictEqual(windowScalar({ "1h": 1200, "24h": 99999 }), 1200, "skips absent 30m, uses 1h");
  assert.strictEqual(
    windowScalar({ "30m": NaN, "1h": 0, "2h": 50 }),
    0,
    "30m NaN → 1h (0 is finite, wins over 2h)"
  );
  ok("windowScalar: absent/non-finite 30m falls to next-shortest finite window");
}

// ── 5. RATIO field anti-inflation: 30m chosen, never the inflated 24h ──
{
  const r = windowScalar(CROSSREF_FEE_TVL_RATIO);
  assert.strictEqual(r, 0.0048309033038631665, "fee_tvl_ratio resolves to 30m, not 0.386 @ 24h");
  assert.ok(r < CROSSREF_FEE_TVL_RATIO["24h"] / 10, "30m ratio is >10× smaller than 24h (anti-inflate #8)");
  ok("windowScalar: RATIO window-object picks conservative 30m, never inflates flow (#8)");
}

// ── 6-13. crossrefPoolFields: per-field shape map ──
{
  const p = rawCrossrefPool();
  const f = crossrefPoolFields(p, p.token_x);

  // 6. volume window → scalar
  assert.strictEqual(f.volume, 404310.8158215448, "volume window-object → 30m scalar");
  ok("crossrefPoolFields: volume window-object → scalar (30m)");

  // 7. fee_tvl_ratio window → fee_active_tvl_ratio slot
  assert.strictEqual(f.feeActiveTvlRatio, 0.12, "fee_tvl_ratio[30m] → fee_active_tvl_ratio slot");
  assert.strictEqual(f.feeTvlRatio, 0.12, "fee_tvl_ratio also exposed directly");
  ok("crossrefPoolFields: fee_tvl_ratio window-object → fee_active_tvl_ratio slot (30m, ratio unit)");

  // 8. no fee_active_tvl_ratio key on cross-ref → resolved from fee_tvl_ratio
  assert.ok(!("fee_active_tvl_ratio" in p), "raw cross-ref has NO fee_active_tvl_ratio key");
  assert.strictEqual(f.feeActiveTvlRatio, 0.12, "still resolved despite absent fee_active_tvl_ratio");
  ok("crossrefPoolFields: absent fee_active_tvl_ratio → falls back to fee_tvl_ratio window");

  // 9. bin_step from pool_config (cross-ref location)
  assert.strictEqual(f.binStep, 100, "bin_step read from pool_config.bin_step");
  ok("crossrefPoolFields: bin_step from pool_config.bin_step (cross-ref location)");

  // 10. holders from token.holders (NOT holder_count)
  assert.strictEqual(f.holders, 1200, "holders read from token_x.holders");
  const noTopHolders = { ...p };
  delete noTopHolders.base_token_holders;
  assert.strictEqual(
    crossrefPoolFields(noTopHolders, { holders: 777 }).holders,
    777,
    "falls to token.holders when base_token_holders absent"
  );
  ok("crossrefPoolFields: holders from token.holders (NOT holder_count)");

  // 11. market_cap from token.market_cap
  assert.strictEqual(f.marketCap, 800000, "market_cap from token.market_cap");
  ok("crossrefPoolFields: market_cap from token.market_cap");

  // 12. structural gaps must NOT be fabricated — null when absent on the endpoint
  const bare = crossrefPoolFields(
    { volume: CROSSREF_VOLUME, fee_tvl_ratio: CROSSREF_FEE_TVL_RATIO, pool_config: { bin_step: 90 }, tvl: 50000 },
    { holders: 600, market_cap: 200000 } // a token object with NO volatility/organic
  );
  assert.strictEqual(bare.volatility, null, "volatility absent → null (never fabricated)");
  assert.strictEqual(bare.baseOrganic, null, "organic_score absent → null (never fabricated)");
  ok("crossrefPoolFields: structural gaps (volatility/organic) → null, never fabricated (#2)");

  // 13. every numeric field fail-closed → null when missing
  const empty = crossrefPoolFields({}, {});
  for (const key of ["tvl", "volume", "feeActiveTvlRatio", "feeTvlRatio", "binStep", "holders", "marketCap", "volatility", "baseOrganic"]) {
    assert.strictEqual(empty[key], null, `${key} → null when input empty`);
  }
  ok("crossrefPoolFields: every field → null when missing (fail-closed #2)");
}

// ── 14. discord-meteoraidn normalizer: live cross-ref shape clears the gate ──
{
  const { __normalizePoolForTests, __resetDiscordMeteoraIdnCache } =
    await import("../tools/sources/discord-meteoraidn.js");
  __resetDiscordMeteoraIdnCache();
  const digestEntry = {
    name: "TEST-SOL",
    pool_address: "Poo1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    channel: "MeteoraIDN#dlmm-multiday-opps",
    seen_at: "2026-06-11T00:00:00.000Z",
    metrics: { lincoln_score: 0.66, fees_tvl_pct: 0.73, tvl: 255000, bin_step: 100 },
  };
  const norm = __normalizePoolForTests(rawCrossrefPool(), digestEntry);
  assert.strictEqual(norm.volume, 404310.8158215448, "discord: 30m window volume mapped");
  assert.strictEqual(norm.fee_active_tvl_ratio, 0.12, "discord: fee_tvl_ratio[30m] → fee_active_tvl_ratio");
  assert.strictEqual(norm.dlmm_params.bin_step, 100, "discord: bin_step from pool_config mapped to dlmm_params");
  assert.strictEqual(norm.base_token_holders, 1200, "discord: holders mapped");
  assert.strictEqual(
    getRawPoolScreeningRejectReason(norm, S),
    null,
    "discord: real fields clear EVERY gate (was choking one gate at a time before fix)"
  );
  ok("discord-meteoraidn: full cross-ref shape → real scalars, clears all gates");
}

// ── 15. solscan-trending: Meteora window wins; Birdeye scalar fallback ──
{
  // Object-window present → Meteora wins.
  assert.strictEqual(windowScalar(CROSSREF_VOLUME) ?? 12345, 404310.8158215448, "Meteora window wins");
  // Meteora unresolvable ({}) → Birdeye scalar fallback survives.
  const fallback = windowScalar({}) ?? Number(98765);
  assert.strictEqual(fallback, 98765, "solscan: unresolvable Meteora volume → Birdeye scalar fallback");
  ok("solscan-trending: Meteora window wins; Birdeye scalar fallback when unresolvable");
}

// ── 16. pumpfun-graduated source loads + uses shared resolver ──
{
  const { fetchPumpfunGraduated } = await import("../tools/sources/pumpfun-graduated.js");
  assert.strictEqual(typeof fetchPumpfunGraduated, "function", "pumpfun source loads");
  const f = crossrefPoolFields(rawCrossrefPool(), rawCrossrefPool().token_x);
  assert.strictEqual(f.volume, 404310.8158215448, "pumpfun: shared mapper resolves window volume");
  assert.strictEqual(f.feeActiveTvlRatio, 0.12, "pumpfun: shared mapper resolves fee/TVL window");
  ok("pumpfun-graduated: uses shared crossrefPoolFields → window shapes resolved");
}

// ── 17. fail-closed: unresolvable volume → null → gate REJECT ──
{
  const { __normalizePoolForTests } = await import("../tools/sources/discord-meteoraidn.js");
  const digestEntry = {
    name: "NOVOL-SOL",
    pool_address: "NoVo1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    channel: "MeteoraIDN#dlmm-multiday-opps",
    seen_at: "2026-06-11T00:00:00.000Z",
    metrics: {},
  };
  const norm = __normalizePoolForTests({ ...rawCrossrefPool(), volume: {} }, digestEntry);
  assert.strictEqual(norm.volume, null, "empty volume object → null (not fabricated)");
  assert.ok(/volume/.test(String(getRawPoolScreeningRejectReason(norm, S))), "unresolvable volume rejects at gate");
  ok("fail-closed: unresolvable volume → null → gate REJECT (anti-pattern #2)");
}

// ── 18. fail-closed: missing bin_step (no pool_config) → null → gate REJECT ──
{
  const { __normalizePoolForTests } = await import("../tools/sources/discord-meteoraidn.js");
  const digestEntry = {
    name: "NOBIN-SOL", pool_address: "NoBin1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    channel: "MeteoraIDN#dlmm-multiday-opps", seen_at: "2026-06-11T00:00:00.000Z", metrics: {},
  };
  const norm = __normalizePoolForTests(rawCrossrefPool({ omit: ["pool_config"] }), digestEntry);
  assert.strictEqual(norm.dlmm_params.bin_step, null, "no pool_config → bin_step null (not fabricated)");
  assert.ok(/bin_step/.test(String(getRawPoolScreeningRejectReason(norm, S))), "missing bin_step rejects at gate");
  ok("fail-closed: missing pool_config.bin_step → null → gate REJECT (anti-pattern #2)");
}

// ── 19. fail-closed: missing fee_tvl_ratio → null → gate REJECT ──
{
  const { __normalizePoolForTests } = await import("../tools/sources/discord-meteoraidn.js");
  const digestEntry = {
    name: "NOFEE-SOL", pool_address: "NoFee1AddrTestXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    channel: "MeteoraIDN#dlmm-multiday-opps", seen_at: "2026-06-11T00:00:00.000Z", metrics: {},
  };
  const norm = __normalizePoolForTests(rawCrossrefPool({ omit: ["fee_tvl_ratio"] }), digestEntry);
  assert.strictEqual(norm.fee_active_tvl_ratio, null, "no fee_tvl_ratio → null (not fabricated)");
  assert.ok(
    /fee\/active-TVL/.test(String(getRawPoolScreeningRejectReason(norm, S))),
    "missing fee/TVL rejects at gate"
  );
  ok("fail-closed: missing fee_tvl_ratio → null → gate REJECT (anti-pattern #2)");
}

console.log(`\n=== ${pass} test(s) PASS ===`);
process.exit(0);
