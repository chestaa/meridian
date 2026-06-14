/**
 * intel-x.js — X/Twitter intel crawler for @0xyunss via Nitter RSS.
 *
 * Sirius 🐺 — Signal Collector.
 *
 * METHOD: Nitter RSS (public mirror). FREE, no X API key required.
 *   - Verified live 2026-05-30: nitter.net returns 20 items + images for 0xyunss.
 *   - Falls over multiple instances; if ALL fail, exits honestly (no fabrication).
 *
 * LIMITS (honest):
 *   - RSS = recent timeline only (~last 20 posts), NOT full history.
 *   - Replies/threads: RSS includes the account's replies as items but does
 *     NOT reconstruct full conversation trees. Deep thread crawl needs the
 *     HTML profile (fragile) or X API v2 (paid).
 *   - Nitter instances are volatile (can 403/die). This is best-effort.
 *
 * Image reading (charts/screenshots) is OPT-IN via intel-vision.js — run with
 * INTEL_VISION=1 and a vision model (see VERDICT in report). Off by default to
 * avoid LLM spend without Bro's go-ahead.
 *
 * Run:  node scripts/intel-x.js [handle]
 *   env INTEL_VISION=1  → also caption images via vision model
 *       INTEL_X_INSTANCES=comma,list  → override nitter instances
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { buildIntelRecord } from "./intel-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "intel", "x");

const HANDLE = (process.argv[2] || "0xyunss").replace(/^@/, "");
const INSTANCES = (process.env.INTEL_X_INSTANCES ||
  "nitter.net,xcancel.com,nitter.poast.org,lightbrd.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
// Some nitter instances (nitter.net) return an EMPTY 200 body to bare Node fetch
// unless content-negotiation headers are present. These make it serve the feed.
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/rss+xml,text/xml,application/xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// Reject bodies that are nitter/instance error pages masquerading as a feed
// (e.g. xcancel "RSS reader not yet whitelist", rate-limit notices).
function looksLikeError(body) {
  const b = body.toLowerCase();
  return b.includes("not yet whitelist") ||
    b.includes("rss feed reader") && b.includes("email") ||
    b.includes("instance has been rate limited") ||
    b.includes("error fetching") ||
    b.includes("user not found");
}

async function fetchOnce(inst, handle) {
  const url = `https://${inst}/${handle}/rss`;
  const res = await fetch(url, { headers: REQ_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const body = await res.text();
  const itemCount = (body.match(/<item>/gi) || []).length;
  if (itemCount === 0) return { ok: false, reason: "no items" };
  if (looksLikeError(body)) return { ok: false, reason: "error-page body" };
  return { ok: true, body, instance: inst, url, itemCount };
}

async function fetchRss(handle) {
  // Two passes: instances flap (cold cache), so retry the list once before
  // giving up — nitter.net especially returns 0 then 20 on quick succession.
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const inst of INSTANCES) {
      try {
        const r = await fetchOnce(inst, handle);
        if (r.ok) { console.log(`[x] OK via ${inst} (${r.itemCount} items, attempt ${attempt})`); return r; }
        console.warn(`[x] ${inst} → ${r.reason}, trying next`);
      } catch (e) {
        console.warn(`[x] ${inst} → ${e.message}, trying next`);
      }
    }
    if (attempt === 1) await new Promise((s) => setTimeout(s, 1500));
  }
  return null;
}

// Minimal RSS <item> parser (no XML dep). Handles CDATA + entity decode.
function decode(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]).trim() : null;
}
function stripHtml(html) {
  return decode(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function extractImages(descHtml, instance) {
  // Nitter embeds <img src="/pic/..."> or full pic.twitter URLs in description.
  const imgs = [...(descHtml || "").matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
  return imgs.map((u) =>
    u.startsWith("http") ? u : `https://${instance}${u.startsWith("/") ? "" : "/"}${u}`
  );
}

function parseItems(body, instance) {
  const blocks = [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  return blocks.map((b) => {
    const rawTitle = tag(b, "title") || "";
    const descHtml = tag(b, "description") || "";
    const link = tag(b, "link");
    const creator = tag(b, "dc:creator");
    const pubDate = tag(b, "pubDate");
    const text = stripHtml(descHtml) || rawTitle;
    const images = extractImages(descHtml, instance);
    const isReply = /^R to @/.test(rawTitle) || /^RT by/.test(rawTitle) || rawTitle.startsWith("R to");
    return {
      text,
      title: rawTitle,
      url: link,
      author: creator || `@${HANDLE}`,
      timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      images,
      kind: rawTitle.startsWith("RT by") ? "retweet" : isReply ? "reply" : "post",
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[x] Crawling @${HANDLE} intel via nitter RSS...`);

  const rss = await fetchRss(HANDLE);
  if (!rss) {
    console.error(`[x] BLOCKED: all nitter instances failed for @${HANDLE}.`);
    console.error(`[x] Honest verdict: nitter is volatile. Retry later, override`);
    console.error(`[x] INTEL_X_INSTANCES, or provide X API v2 key (paid) for reliability.`);
    process.exit(2);
  }

  const items = parseItems(rss.body, rss.instance);
  const records = items.map((it) =>
    buildIntelRecord({
      platform: "x",
      source: `@${HANDLE}`,
      author: it.author,
      text: it.text,
      url: it.url,
      timestamp: it.timestamp,
      images: it.images,
      extra: { kind: it.kind, raw_title: it.title, via_instance: rss.instance },
    })
  );

  // Optional vision pass for images (charts/screenshots).
  if (process.env.INTEL_VISION === "1") {
    try {
      const { captionImages } = await import("./intel-vision.js");
      for (const r of records) {
        if (r.metadata.images.length) {
          r.metadata.image_intel = await captionImages(r.metadata.images, r.text);
        }
      }
      console.log(`[x] vision pass complete`);
    } catch (e) {
      console.warn(`[x] vision pass skipped: ${e.message}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(OUT_DIR, `${HANDLE}_${stamp}.json`);
  const withTopics = records.filter((r) => r.topics.length);
  fs.writeFileSync(outFile, JSON.stringify({
    handle: `@${HANDLE}`,
    crawled_at: new Date().toISOString(),
    method: "nitter-rss",
    instance: rss.instance,
    total_items: records.length,
    with_intel_topics: withTopics.length,
    vision_pass: process.env.INTEL_VISION === "1",
    records,
  }, null, 2), "utf8");

  console.log(`\n=== X INTEL SUMMARY (@${HANDLE}) ===`);
  console.log(`  items: ${records.length}, with intel topics: ${withTopics.length}`);
  const topicCount = {};
  for (const r of records) for (const t of r.topics) topicCount[t] = (topicCount[t] || 0) + 1;
  console.log(`  topics: ${Object.entries(topicCount).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  const spread = new Set();
  for (const r of records) for (const m of r.spread.mentions) spread.add(m);
  console.log(`  spread/linked accounts: ${[...spread].join(", ") || "none"}`);
  console.log(`  → ${outFile}`);
}

main().catch((e) => { console.error("[x fatal]", e.message); process.exit(1); });
