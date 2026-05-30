/**
 * test-discord-ranked-source.js — Sirius 🐺
 *
 * Verifies the MeteoraIDN ranked-digest Discord source (fix #3, phantom→real):
 *   1. Ranked-digest msg → correct pool address + metrics extracted
 *   2. Multi-pool digest msg → all pool lines extracted
 *   3. Metlex firehose msg → SKIPPED (not a ranked channel, no metrics)
 *   4. Missing feed file / channel down → [] graceful (never throws)
 *   5. Normalizer produces Meteora raw shape + discord_meteoraidn provenance
 *
 * No network: parsing + normalization are pure; fetch path is exercised against
 * a missing feed file to confirm graceful [].
 *
 * Run: node scripts/test-discord-ranked-source.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Point the source at a temp feed file so we don't touch real data.
const TMP_FEED = path.join(ROOT, "intel", "discord", `__test_ranked_feed_${Date.now()}.json`);
process.env.DISCORD_RANKED_FEED = TMP_FEED;

const {
  parseRankedDigestLine,
  extractDigestEntries,
  fetchDiscordMeteoraIdnRanked,
  __resetDiscordMeteoraIdnCache,
  __normalizePoolForTests,
} = await import("../tools/sources/discord-meteoraidn.js");

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

// ── Sample messages (verbatim shapes from the 2026-05-30 MeteoraIDN intel crawl) ──
const SINGLE_POOL_DIGEST = {
  source: "MeteoraIDN#🌓│dlmm-multiday-opps",
  author: "MeteoraIDN",
  timestamp: "2026-05-30T11:00:00.000Z",
  text:
    "DLMM Top 10 Multiday Opportunities :broom: Min 1d Fees / TVL\n" +
    "**[ASTEROID-SOL](https://app.meteora.ag/dlmm/7UXd3L81hNpoAsWo7vgBnoTFajHNHSiPBNbAQbwN2ET2)** " +
    ":broom: 0.73% :airplane: 0.66% :pushpin: 15.8M :hourglass: 1.11% :bar_chart: 255.0K | 516.1K " +
    ":triangular_ruler: 7.8K | 10.6K | 12.6K :red_square: 100 :bookmark: 1.00% :crown: 0 :zap: 0 :alarm_clock: <t:1776399727:R>",
};

const MULTI_POOL_DIGEST = {
  source: "MeteoraIDN#💎│dlmm-exotic-opps",
  author: "MeteoraIDN",
  timestamp: "2026-05-30T11:30:00.000Z",
  text:
    "DLMM Top 10 Exotic Opportunities :broom: 1hr Yield\n" +
    "**[Dogwifgun-SOL](https://app.meteora.ag/dlmm/FSkSHRJyFTz3AnCaMvTVrVsTzi8PByUAxCZHe5VGKjUt)** " +
    ":broom: 4.93% :airplane: 11.98% :pushpin: 457.2K :bar_chart: $17,017 :triangular_ruler: 2.0K | 14.5K | 33.1K " +
    ":hourglass: 42.10% :red_square: 80 :bookmark: 2.00% :crown: 0 :gem: 0.0K :zap: 40 :alarm_clock: <t:1779851201:R>\n\n" +
    "**[GACHA-SOL](https://app.meteora.ag/dlmm/4DfH61nAFphrQNYw8MxkqK2LnLocteWpeTRKVEVCLr2Q)** " +
    ":broom: 2.61% :airplane: 5.00% :pushpin: 483.2K :bar_chart: $27,471 :triangular_ruler: 2.6K | 16.9K | 18.5K " +
    ":hourglass: -35.63% :red_square: 125 :bookmark: 2.50% :crown: 0 :gem: 0.0K :zap: 0 :alarm_clock: <t:1779833720:R>",
};

const METLEX_FIREHOSE = {
  source: "MeteoraIDN#metlex-dlmm-bot",
  author: "Metlex DLMM",
  timestamp: "2026-05-30T11:45:00.000Z",
  text:
    "New Pool Found! 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin " +
    "[APP](https://app.meteora.ag) [EDGE](https://edge.x) [AXI](https://axi.x) [DEX](https://dex.x)",
};

// ── 1. Single-pool ranked digest → pool + metrics extracted ──
{
  const entries = extractDigestEntries(SINGLE_POOL_DIGEST);
  assert.strictEqual(entries.length, 1, "expected 1 pool entry");
  const e = entries[0];
  assert.strictEqual(e.pool_address, "7UXd3L81hNpoAsWo7vgBnoTFajHNHSiPBNbAQbwN2ET2", "pool address");
  assert.strictEqual(e.name, "ASTEROID-SOL", "pool name");
  assert.strictEqual(e.metrics.fees_tvl_pct, 0.73, "fees/TVL %");
  assert.strictEqual(e.metrics.lincoln_score, 0.66, "Lincoln Score");
  assert.strictEqual(e.metrics.fdv, 15_800_000, "FDV 15.8M");
  assert.strictEqual(e.metrics.tvl, 255_000, "TVL 255.0K");
  assert.strictEqual(e.metrics.bin_step, 100, "bin step");
  assert.strictEqual(e.metrics.base_fee_pct, 1.0, "base fee %");
  ok("single-pool digest: pool address + all metrics extracted");
}

// ── 2. Multi-pool digest → both pools, $-prefixed + suffixed magnitudes ──
{
  const entries = extractDigestEntries(MULTI_POOL_DIGEST);
  assert.strictEqual(entries.length, 2, "expected 2 pool entries");
  assert.strictEqual(entries[0].pool_address, "FSkSHRJyFTz3AnCaMvTVrVsTzi8PByUAxCZHe5VGKjUt");
  assert.strictEqual(entries[0].metrics.lincoln_score, 11.98, "pool1 Lincoln");
  assert.strictEqual(entries[0].metrics.tvl, 17017, "pool1 TVL $17,017 (no suffix, comma-stripped)");
  assert.strictEqual(entries[0].metrics.bin_step, 80, "pool1 bin step");
  assert.strictEqual(entries[1].pool_address, "4DfH61nAFphrQNYw8MxkqK2LnLocteWpeTRKVEVCLr2Q");
  assert.strictEqual(entries[1].metrics.base_fee_pct, 2.5, "pool2 base fee");
  ok("multi-pool digest: both pools extracted, $/K/M magnitudes parsed");
}

// ── 3. Metlex firehose → SKIPPED (not a ranked channel) ──
{
  const entries = extractDigestEntries(METLEX_FIREHOSE);
  assert.strictEqual(entries.length, 0, "Metlex firehose must yield 0 entries");
  ok("Metlex firehose msg skipped (channel not ranked → excluded)");
}

// ── 3b. parseRankedDigestLine on a bare metrics tail ──
{
  const m = parseRankedDigestLine(
    ":broom: 2.05% :airplane: 1.86% :pushpin: 623.2K :bar_chart: $15,669 :red_square: 200 :bookmark: 2.00%"
  );
  assert.strictEqual(m.fees_tvl_pct, 2.05);
  assert.strictEqual(m.lincoln_score, 1.86);
  assert.strictEqual(m.fdv, 623_200);
  assert.strictEqual(m.tvl, 15669);
  assert.strictEqual(m.bin_step, 200);
  assert.strictEqual(m.base_fee_pct, 2.0);
  ok("parseRankedDigestLine: standalone metrics tail parsed");
}

// ── 4. Missing feed file (channel down / no data) → [] graceful ──
{
  __resetDiscordMeteoraIdnCache();
  assert.ok(!fs.existsSync(TMP_FEED), "feed file should not exist yet");
  const pools = await fetchDiscordMeteoraIdnRanked();
  assert.ok(Array.isArray(pools), "returns an array");
  assert.strictEqual(pools.length, 0, "missing feed → [] (no throw)");
  ok("missing feed file → [] graceful (channel-down safe)");
}

// ── 4b. Malformed JSON feed → [] graceful ──
{
  __resetDiscordMeteoraIdnCache();
  fs.mkdirSync(path.dirname(TMP_FEED), { recursive: true });
  fs.writeFileSync(TMP_FEED, "{ this is not json", "utf8");
  const pools = await fetchDiscordMeteoraIdnRanked();
  assert.strictEqual(pools.length, 0, "malformed JSON → [] (no throw)");
  ok("malformed feed JSON → [] graceful");
}

// ── 5. Normalizer → Meteora raw shape + discord_meteoraidn provenance ──
{
  const entry = extractDigestEntries(SINGLE_POOL_DIGEST)[0];
  const meteoraPool = {
    pool_address: entry.pool_address,
    name: "ASTEROID-SOL",
    pool_type: "dlmm",
    tvl: 255000,
    volume: 12600,
    fee_active_tvl_ratio: 0.08,
    volatility: 3.2,
    base_token_holders: 1200,
    dlmm_params: { bin_step: 100 },
    token_x: { symbol: "ASTEROID", address: "AsTeRoIdMint1111111111111111111111111111111", organic_score: 75, market_cap: 15800000, created_at: Date.now() - 50 * 3_600_000 },
    token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 99 },
  };
  const norm = __normalizePoolForTests(meteoraPool, entry);
  assert.strictEqual(norm.pool_address, entry.pool_address, "pool_address preserved");
  assert.strictEqual(norm.pool_type, "dlmm", "pool_type dlmm");
  assert.strictEqual(norm.dlmm_params.bin_step, 100, "bin_step in dlmm_params");
  assert.strictEqual(norm.base_mint, "AsTeRoIdMint1111111111111111111111111111111", "base_mint = non-SOL side");
  assert.strictEqual(norm.token_x.symbol, "ASTEROID", "base symbol");
  assert.strictEqual(norm.signal_source, "discord_meteoraidn", "source tag");
  assert.strictEqual(norm.discord_signal, true, "discord_signal flag");
  assert.strictEqual(norm.discord_source, "meteoraidn_ranked", "discord_source");
  assert.strictEqual(norm.discord_lincoln_score, 0.66, "lincoln score surfaced");
  ok("normalizer: Meteora raw shape + discord_meteoraidn provenance");
}

// cleanup
try { fs.unlinkSync(TMP_FEED); } catch {}

console.log(`\n=== ${pass} test(s) PASS ===`);
process.exit(0);
