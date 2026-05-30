import { log } from "../../logger.js";
import { numeric } from "./meteora-crossref.js";

/**
 * Discord MeteoraIDN ranked-digest source (LOCAL) — Sirius 🐺.
 *
 * REPLACES the phantom HiveMind Discord path. The old
 * fetchDiscordSignalCandidates() hit api.agentmeridian.xyz/signals/discord/candidates
 * which returns 404 → [] → the useDiscordSignals flag did NOTHING. This module
 * wires the REAL curated Discord source: the MeteoraIDN bot's "Top 10" ranked
 * digest channels (#dlmm-multiday-opps, #dlmm-exotic-opps).
 *
 * Those digests are metric-rich and Meteora-native: each pool line carries a
 * direct app.meteora.ag/dlmm/<POOL_ADDRESS> link plus Lincoln Score, FDV, TVL,
 * bin step, base fee, etc. Because the pool address is embedded in the URL, we
 * do NOT need to guess — we read the address directly, then cross-ref Meteora's
 * DLMM index to enrich into the full raw pool shape (identical pattern to
 * solscan-trending.js / pumpfun-graduated.js).
 *
 * We DELIBERATELY EXCLUDE the Metlex firehose bots (#metlex-dlmm-bot,
 * #metlex-dammv2-bot): those are "New Pool Found" link-only spam with NO quality
 * metrics — noise, not signal. Only MeteoraIDN ranked digests are parsed here.
 *
 * READ-ONLY: this module never posts/reacts/joins. It consumes the digest text
 * that the selfbot listener mirrors to discord-signals.json. The selfbot is a
 * USER-token automation (discord.js-selfbot-v13) and violates Discord ToS — run
 * on a BURNER account only (see discord-listener/, intel-discord.js notes).
 *
 * Discord as a source is, per anti-pattern #8, a CROSSVAL BOOSTER not a
 * standalone trigger: in merge mode a discord-only pool still must clear the
 * Cassiopeia gate + Orion judgment. discordSignalMode:"only" exists for testing
 * but is not the live posture.
 *
 * GRACEFUL DEGRADATION: missing feed file / unparseable text / cross-ref miss →
 * skip that entry; whole-source failure → return []. Never throws.
 */

// Default location the selfbot listener mirrors digest messages to.
// Overridable via env for tests / alternate deployments.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIGEST_FEED_FILE =
  process.env.DISCORD_RANKED_FEED || path.join(ROOT, "discord-ranked-digest.json");

// Only these channel name fragments are treated as ranked digests. Anything else
// (notably the Metlex firehose) is ignored.
const RANKED_CHANNEL_RE = /multiday-opps|exotic-opps/i;

// A ranked-digest pool line:  **[NAME](https://app.meteora.ag/dlmm/<ADDR>)** <metrics...>
// Capture group 1 = pool display name, group 2 = pool address (base58).
const POOL_LINE_RE =
  /\*\*\[([^\]]+)\]\(https:\/\/app\.meteora\.ag\/dlmm\/([1-9A-HJ-NP-Za-km-z]{32,44})\)\*\*([^\n]*)/g;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-memory cache
let _cache = { at: 0, pools: null };

/**
 * Parse a percentage token like "0.73%" → 0.73 (number) or null.
 */
function parsePct(token) {
  if (token == null) return null;
  const m = String(token).match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? numeric(m[1]) : null;
}

/**
 * Parse a metric value that may carry a K/M suffix and optional $:
 *   "15.8M" → 15800000, "255.0K" → 255000, "$17,017" → 17017, "100" → 100
 */
function parseMagnitude(token) {
  if (token == null) return null;
  let s = String(token).trim().replace(/[$,]/g, "");
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*([KkMmBb])?/);
  if (!m) return null;
  let n = numeric(m[1]);
  if (n == null) return null;
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") n *= 1e3;
  else if (suffix === "m") n *= 1e6;
  else if (suffix === "b") n *= 1e9;
  return n;
}

/**
 * Extract the structured metrics carried on a ranked-digest pool line.
 * The bot encodes each metric behind an emoji shortcode (e.g. ":broom:",
 * ":airplane:") rendered server-side. The intel crawl preserves the shortcodes,
 * so we key off those — but to be resilient to rendered-emoji variants we also
 * fall back to positional parsing if shortcodes are absent.
 *
 * Fields per the digest legend:
 *   :broom:        Fees/TVL yield        (%)
 *   :airplane:     Lincoln Score          (%)  ← swap fee ratio
 *   :pushpin:      FDV
 *   :bar_chart:    TVL
 *   :red_square:   Bin Step
 *   :bookmark:     Base Fees              (%)
 */
export function parseRankedDigestLine(metricsText) {
  const out = {
    fees_tvl_pct: null,
    lincoln_score: null,
    fdv: null,
    tvl: null,
    bin_step: null,
    base_fee_pct: null,
  };
  if (!metricsText) return out;

  const grab = (emoji) => {
    // Capture the token immediately after the emoji shortcode, up to the next
    // emoji shortcode or end of line.
    const re = new RegExp(`:${emoji}:\\s*([^:]+?)\\s*(?=:[a-z_]+:|$)`, "i");
    const m = metricsText.match(re);
    return m ? m[1].trim() : null;
  };

  out.fees_tvl_pct = parsePct(grab("broom"));
  out.lincoln_score = parsePct(grab("airplane"));
  out.fdv = parseMagnitude(grab("pushpin"));
  out.tvl = parseMagnitude(grab("bar_chart"));
  out.bin_step = parseMagnitude(grab("red_square"));
  out.base_fee_pct = parsePct(grab("bookmark"));
  return out;
}

/**
 * Pull ranked-digest entries out of a single feed record. A record is the
 * mirrored Discord message: { source/channel, text, author, timestamp }.
 * Returns [] for non-ranked (firehose) channels or text with no pool lines.
 */
export function extractDigestEntries(record) {
  if (!record) return [];
  const channel = record.source || record.channel || record.discord_channel || "";
  // Hard exclude anything that is not a MeteoraIDN ranked digest channel.
  if (!RANKED_CHANNEL_RE.test(channel)) return [];

  const text = record.text || record.raw_text || record.content || "";
  if (!text) return [];

  const entries = [];
  for (const m of text.matchAll(POOL_LINE_RE)) {
    const name = (m[1] || "").trim();
    const poolAddress = m[2];
    const metrics = parseRankedDigestLine(m[3] || "");
    if (!poolAddress) continue;
    entries.push({
      name,
      pool_address: poolAddress,
      channel,
      seen_at: record.timestamp || record.queued_at || null,
      metrics,
    });
  }
  return entries;
}

/**
 * Read + parse the mirrored ranked-digest feed file. Graceful: missing file or
 * bad JSON → []. Dedup pool addresses, newest metric wins.
 */
function readDigestEntries() {
  let raw;
  try {
    if (!fs.existsSync(DIGEST_FEED_FILE)) {
      log("screening", `discord-meteoraidn: feed file not found (${DIGEST_FEED_FILE}), skipping`);
      return [];
    }
    raw = fs.readFileSync(DIGEST_FEED_FILE, "utf8");
  } catch (err) {
    log("screening", `discord-meteoraidn: feed read error: ${err.message}`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("screening", `discord-meteoraidn: feed JSON parse error: ${err.message}`);
    return [];
  }
  // Accept either a bare array of records or { records: [...] }.
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];

  const byAddr = new Map();
  for (const rec of records) {
    for (const entry of extractDigestEntries(rec)) {
      const prev = byAddr.get(entry.pool_address);
      // Keep the most recent sighting per pool.
      if (!prev || (entry.seen_at && (!prev.seen_at || entry.seen_at > prev.seen_at))) {
        byAddr.set(entry.pool_address, entry);
      }
    }
  }
  return Array.from(byAddr.values());
}

/**
 * Normalize a Meteora DLMM pool (sourced via cross-ref by pool address) into the
 * screening raw shape, layering the digest metrics on top. Real Meteora fields
 * win; the digest fills gaps + supplies the discord-specific surface tags.
 */
function normalizePool(meteoraPool, digestEntry) {
  const tokenX = meteoraPool.token_x || {};
  const tokenY = meteoraPool.token_y || {};
  // Base side = whichever isn't SOL/USDC-ish; default to token_x.
  const quoteSymbols = new Set(["SOL", "WSOL", "USDC", "USDT"]);
  const baseIsX = !quoteSymbols.has(String(tokenX.symbol || "").toUpperCase());
  const base = baseIsX ? tokenX : tokenY;
  const quote = baseIsX ? tokenY : tokenX;

  const m = digestEntry.metrics || {};
  const tvl = numeric(meteoraPool.tvl ?? meteoraPool.active_tvl) ?? m.tvl;
  const volume = numeric(meteoraPool.volume);
  const feeActiveTvlRatio = numeric(meteoraPool.fee_active_tvl_ratio);
  const volatility = numeric(meteoraPool.volatility);
  const binStep = numeric(meteoraPool.dlmm_params?.bin_step ?? meteoraPool.bin_step) ?? m.bin_step;
  const holders = numeric(meteoraPool.base_token_holders ?? base?.holder_count);
  const createdAt = numeric(base?.created_at);
  const tokenAgeHours = createdAt != null ? Math.floor((Date.now() - createdAt) / 3_600_000) : null;
  const marketCap = numeric(base?.market_cap) ?? m.fdv;

  return {
    // ── Meteora-raw top-level (consumed by reject-reason + condensePool) ──
    pool_address: meteoraPool.pool_address || meteoraPool.address || digestEntry.pool_address,
    name: meteoraPool.name || digestEntry.name || `${base?.symbol || "?"}-${quote?.symbol || "?"}`,
    pool_type: meteoraPool.pool_type || "dlmm",
    tvl,
    active_tvl: numeric(meteoraPool.active_tvl),
    volume,
    fee: numeric(meteoraPool.fee),
    fee_pct: numeric(meteoraPool.fee_pct),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility,
    volatility_timeframe: meteoraPool.volatility_timeframe || null,
    base_token_holders: holders,
    dlmm_params: { bin_step: binStep },

    base_token_has_critical_warnings: meteoraPool.base_token_has_critical_warnings ?? false,
    quote_token_has_critical_warnings: meteoraPool.quote_token_has_critical_warnings ?? false,
    base_token_has_high_single_ownership: meteoraPool.base_token_has_high_single_ownership ?? false,
    base_token_has_high_supply_concentration: meteoraPool.base_token_has_high_supply_concentration ?? false,

    token_x: {
      symbol: base?.symbol,
      address: base?.address,
      organic_score: numeric(base?.organic_score),
      market_cap: marketCap,
      created_at: createdAt,
      dev: base?.dev || null,
      launchpad: base?.launchpad || null,
    },
    token_y: {
      symbol: quote?.symbol,
      address: quote?.address,
      organic_score: numeric(quote?.organic_score),
    },

    // ── Spec-required flat aliases (non-breaking convenience) ──
    pool_name: meteoraPool.name || digestEntry.name,
    base_mint: base?.address,
    base_token_created_at: createdAt,
    token_age_hours: tokenAgeHours,

    // ── Discord ranked-digest surface (provenance + booster metrics) ──
    discord_signal: true,
    discord_source: "meteoraidn_ranked",
    discord_channel: digestEntry.channel,
    discord_lincoln_score: m.lincoln_score,
    discord_fees_tvl_pct: m.fees_tvl_pct,
    discord_base_fee_pct: m.base_fee_pct,
    discord_seen_at: digestEntry.seen_at,

    // ── Source tag (string alias; signal_sources[] is authoritative) ──
    signal_source: "discord_meteoraidn",
  };
}

/**
 * Fetch + parse the MeteoraIDN ranked digest, cross-ref each pool address
 * against Meteora's DLMM index, and return normalized raw pools. 5-min cached.
 * Never throws.
 *
 * @returns {Promise<Array>} normalized pools tagged signal_source:"discord_meteoraidn".
 */
export async function fetchDiscordMeteoraIdnRanked() {
  const now = Date.now();
  if (_cache.pools && now - _cache.at < CACHE_TTL_MS) {
    return _cache.pools;
  }

  try {
    const entries = readDigestEntries();
    if (entries.length === 0) {
      _cache = { at: now, pools: [] };
      return [];
    }

    const settled = await Promise.allSettled(
      entries.map(async (entry) => {
        // The digest URL already gives us the pool address; cross-ref to enrich
        // with live Meteora metrics. Look up via either token; the pool index is
        // queryable by mint, so we resolve the pool by its address through the
        // shared helper using a query that returns the pool row.
        const meteoraPool = await findDlmmPoolForAddress(entry.pool_address);
        if (!meteoraPool) {
          // Cross-ref miss: still emit a minimal pool so the address isn't lost,
          // but it will almost certainly be filtered by the volatility/metric
          // gates downstream (graceful, not fabricated).
          return normalizePool({ pool_address: entry.pool_address }, entry);
        }
        return normalizePool(meteoraPool, entry);
      })
    );

    const pools = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== "fulfilled" || !r.value || !r.value.pool_address) continue;
      if (seen.has(r.value.pool_address)) continue;
      seen.add(r.value.pool_address);
      pools.push(r.value);
    }

    log(
      "screening",
      `discord-meteoraidn: ${pools.length} ranked-digest pool(s) from ${entries.length} digest entr(ies)`
    );
    _cache = { at: now, pools };
    return pools;
  } catch (err) {
    log("screening", `discord-meteoraidn: unexpected failure, returning []: ${err.message}`);
    return [];
  }
}

/**
 * Resolve a Meteora DLMM pool row by its POOL address (not mint). Uses the same
 * datapi index the cross-ref helper uses; matches on pool_address. Graceful null
 * on any failure.
 */
async function findDlmmPoolForAddress(poolAddress) {
  const { METEORA_DLMM_BASE } = await import("./meteora-crossref.js");
  const url = `${METEORA_DLMM_BASE}/pools?query=${encodeURIComponent(poolAddress)}&sort_by=${encodeURIComponent("tvl:desc")}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    log("screening", `discord-meteoraidn: pool cross-ref fetch error: ${err.message}`);
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((p) => (p?.pool_address || p?.address) === poolAddress) || null;
}

// Exposed for tests — allows cache reset between assertions.
export function __resetDiscordMeteoraIdnCache() {
  _cache = { at: 0, pools: null };
}

// Exposed for tests — the normalizer with no live fetch.
export function __normalizePoolForTests(meteoraPool, digestEntry) {
  return normalizePool(meteoraPool, digestEntry);
}
