/**
 * intel-extract.js — shared intel topic-tagging + normalization.
 *
 * Sirius 🐺 — Signal Collector intel module.
 * NOT a trading signal parser. This extracts qualitative intel (keluh kesah,
 * technical talk, alpha, profit/loss anecdotes) from crawled text for review.
 * Output is READ-ONLY structured JSON; never feeds executor/deploy.
 *
 * Topic tags (bahasa-aware: indonesian + english keyword sets):
 *   llm | dlmm | meridian | profit | loss | complaint | issue | technical | alpha | strategy
 */

// Keyword sets per topic. Lowercased substring match on normalized text.
// Bahasa Indonesia + English. Tuned for the Meridian/0xyunss community vocab.
const TOPIC_KEYWORDS = {
  llm: [
    "llm", "openrouter", "deepseek", "gpt", "claude", "model", "prompt",
    "token cost", "ai agent", "langganan ai", "vision", "context window",
    "mimo", "qwen", "gemini", "inference",
  ],
  dlmm: [
    "dlmm", "meteora", "bin", "bin step", "liquidity", "lp ", "likuiditas",
    "pool", "range", "out of range", "oor", "rebalance", "fee tier",
    "single side", "single-side", "concentrated",
  ],
  meridian: [
    "meridian", "agentmeridian", "agent_meridian", "metlex", "hivemind",
    "hive mind", "constellation", "sirius", "polaris", "cassiopeia", "orion",
    "vega", "andromeda", "lyra", "draco",
  ],
  profit: [
    "profit", "untung", "cuan", "gain", "gacor", "dapet $", "dapet usd",
    "withdraw", "wd ", "roi", "+%", "naik", "moon", "x2", "x3", "x5",
    "all time high", "ath", "green",
  ],
  loss: [
    "loss", "rugi", "rug", "rugpull", "boncos", "kena rug", "minus",
    "drawdown", "stop loss", "sl ", "merah", "red", "down bad", "liq",
    "liquidated", "impermanent",
  ],
  complaint: [
    "keluh", "kesel", "kesal", "ngeluh", "annoying", "frustrating", "frustasi",
    "capek", "lelah", "ribet", "susah", "bingung", "stuck", "macet", "lemot",
    "lambat", "error mulu", "gagal terus", "complain", "kecewa", "nyebelin",
  ],
  issue: [
    "bug", "error", "crash", "fail", "gagal", "broken", "rusak", "issue",
    "problem", "masalah", "kendala", "ga jalan", "gak jalan", "nggak jalan",
    "timeout", "rate limit", "down", "offline", "stuck", "hang", "fix",
  ],
  technical: [
    "rpc", "vps", "systemd", "cron", "node", "api", "config", "env",
    "private key", "wallet", "deploy", "git", "setup", "install", "script",
    "regex", "json", "schema", "endpoint", "latency", "helius", "jupiter",
    "solana", "base58", "selfbot", "session",
  ],
  alpha: [
    "alpha", "gem", "early", "presale", "fair launch", "graduate", "graduated",
    "pump.fun", "pumpfun", "bonk", "narrative", "meta ", "smart wallet", "kol",
    "whale", "insider", "call", "ape ", "aping", "entry", "snipe", "sniper",
  ],
  strategy: [
    "strategy", "strategi", "approach", "setup", "threshold", "filter",
    "bid ask", "bid_ask", "spot", "curve", "position size", "sizing",
    "take profit", "tp ", "trailing", "compounding", "compound", "risk management",
    "diversif", "allocation", "backtest",
  ],
};

const TOPICS = Object.keys(TOPIC_KEYWORDS);

// Solana mint regex — surfaced as metadata only, NOT as a trade trigger.
const SOL_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
// @mentions and t.me / discord links for "where they spread" mapping.
const MENTION_RE = /@([A-Za-z0-9_]{2,32})/g;
const URL_RE = /https?:\/\/[^\s)]+/g;
const TME_RE = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_+]+)/gi;

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Tag a block of text with intel topics. Returns matched topics + the
 * keyword hits that triggered each (for auditability — Lyra can review WHY).
 */
export function tagTopics(text) {
  const norm = normalize(text);
  const tags = [];
  const hits = {};
  for (const topic of TOPICS) {
    const matched = TOPIC_KEYWORDS[topic].filter((kw) => norm.includes(kw));
    if (matched.length) {
      tags.push(topic);
      hits[topic] = matched;
    }
  }
  return { tags, hits };
}

function uniq(arr) {
  return [...new Set(arr)];
}

/**
 * Build a normalized intel record from raw crawled content.
 * @param {object} p
 * @param {string} p.platform   x | telegram | discord
 * @param {string} p.source     channel/account label
 * @param {string} p.author     handle
 * @param {string} p.text       raw message/post text
 * @param {string} p.url        permalink (if any)
 * @param {string} p.timestamp  ISO8601
 * @param {string[]} p.images   image URLs attached
 * @param {object} p.extra      platform-specific metadata (likes, replies, etc.)
 */
export function buildIntelRecord(p) {
  const text = p.text || "";
  const { tags, hits } = tagTopics(text);

  const mentions = uniq([...text.matchAll(MENTION_RE)].map((m) => "@" + m[1]));
  const urls = uniq([...text.matchAll(URL_RE)].map((m) => m[0]));
  const tmeLinks = uniq([...text.matchAll(TME_RE)].map((m) => m[1]));
  const addresses = uniq(
    [...text.matchAll(SOL_ADDR_RE)].map((m) => m[0]).filter((a) => /\d/.test(a))
  );

  const tsIso = p.timestamp || new Date().toISOString();
  const hash = Math.abs(
    [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
  ).toString(36);

  return {
    intel_id: `intel_${Date.parse(tsIso) || Date.now()}_${p.platform}_${hash}`,
    platform: p.platform,
    source: p.source || null,
    author: p.author || null,
    url: p.url || null,
    timestamp: tsIso,
    text,
    topics: tags,
    topic_hits: hits, // which keywords fired (audit trail for Lyra)
    spread: {
      // "where they spread" — linked accounts/channels referenced
      mentions,
      telegram_links: tmeLinks,
      urls,
    },
    metadata: {
      mentioned_addresses: addresses, // surfaced, NOT a trade trigger (anti-pattern #8)
      images: p.images || [],
      image_intel: [], // filled by vision pass if run (see intel-vision.js)
      ...(p.extra || {}),
    },
    extracted_at: new Date().toISOString(),
    extractor_version: "1.0",
  };
}

export { TOPICS, TOPIC_KEYWORDS };
