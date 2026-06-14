/**
 * intel-x-network.js — X/Twitter NETWORK-GRAPH intel crawler.
 *
 * Sirius 🐺 — Signal Collector.
 *
 * Extends intel-x.js (single-account) to the @0xyunss NETWORK: the accounts he
 * mentions/interacts with. Same proven method — nitter RSS, FREE, no API key.
 *
 * GRAPH MODEL (capped to avoid infinite recursion):
 *   - SEED list (known network from prior research) + the root handle.
 *   - DEPTH 1 auto-discovery: parse @mentions in seed accounts' posts → queue.
 *   - Hard cap MAX_ACCOUNTS total. No depth-2 expansion.
 *
 * BLOCKED (honest): reply/thread reconstruction needs X API v2 (paid). RSS gives
 * the account's own timeline (~last 20 posts incl. its replies as flat items),
 * NOT conversation trees. We do account-graph only — by design.
 *
 * Rate-limit aware: nitter throttles aggressively across rapid requests. We space
 * each account fetch by THROTTLE_MS and gracefully skip (note, don't crash) on fail.
 *
 * Output: intel/x/network-graph_<stamp>.json (per-account records + aggregate themes).
 *
 * Run:  node scripts/intel-x-network.js
 *   env INTEL_X_ROOT=0xyunss         → root handle (default 0xyunss)
 *       INTEL_X_SEED=a,b,c           → override seed network
 *       INTEL_X_MAX=10               → cap total accounts (default 10)
 *       INTEL_X_THROTTLE_MS=2500     → ms between account fetches
 *       INTEL_X_INSTANCES=comma,list → override nitter instances
 *
 * READ-ONLY. No posting (anti-pattern #8). No touch executor/dlmm/wallet/state.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { buildIntelRecord } from "./intel-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "intel", "x");

const ROOT_HANDLE = (process.env.INTEL_X_ROOT || "0xyunss").replace(/^@/, "");
// Known network from Sirius's prior spread-map research.
const SEED = (process.env.INTEL_X_SEED ||
  "meridian_agent,MeteoraIDN,eisbedog,trebelsem,EvilPanda,EnclaviumFNF")
  .split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
const MAX_ACCOUNTS = Number(process.env.INTEL_X_MAX || 10);
const THROTTLE_MS = Number(process.env.INTEL_X_THROTTLE_MS || 2500);

const INSTANCES = (process.env.INTEL_X_INSTANCES ||
  "nitter.net,nitter.poast.org,lightbrd.com,xcancel.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
// nitter.net returns EMPTY 200 to bare Node fetch without content-negotiation headers.
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/rss+xml,text/xml,application/xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

function looksLikeError(body) {
  const b = body.toLowerCase();
  return b.includes("not yet whitelist") ||
    (b.includes("rss feed reader") && b.includes("email")) ||
    b.includes("instance has been rate limited") ||
    b.includes("error fetching") ||
    b.includes("user not found") ||
    b.includes("account has been suspended");
}

async function fetchOnce(inst, handle) {
  const url = `https://${inst}/${handle}/rss`;
  const res = await fetch(url, { headers: REQ_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const body = await res.text();
  const itemCount = (body.match(/<item>/gi) || []).length;
  if (looksLikeError(body)) return { ok: false, reason: "error-page body" };
  if (itemCount === 0) return { ok: false, reason: "no items" };
  return { ok: true, body, instance: inst, url, itemCount };
}

async function fetchRss(handle) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const inst of INSTANCES) {
      try {
        const r = await fetchOnce(inst, handle);
        if (r.ok) { console.log(`[xnet] OK @${handle} via ${inst} (${r.itemCount} items, attempt ${attempt})`); return r; }
        console.warn(`[xnet] @${handle} ${inst} → ${r.reason}, next`);
      } catch (e) {
        console.warn(`[xnet] @${handle} ${inst} → ${e.message}, next`);
      }
    }
    if (attempt === 1) await sleep(1500);
  }
  return null;
}

// --- minimal RSS parsing (shared shape with intel-x.js) ---
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
  const imgs = [...(descHtml || "").matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
  return imgs.map((u) =>
    u.startsWith("http") ? u : `https://${instance}${u.startsWith("/") ? "" : "/"}${u}`
  );
}
function parseItems(body, instance, handle) {
  const blocks = [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  return blocks.map((b) => {
    const rawTitle = tag(b, "title") || "";
    const descHtml = tag(b, "description") || "";
    const link = tag(b, "link");
    const creator = tag(b, "dc:creator");
    const pubDate = tag(b, "pubDate");
    const text = stripHtml(descHtml) || rawTitle;
    const images = extractImages(descHtml, instance);
    const isReply = /^R to @/.test(rawTitle) || rawTitle.startsWith("R to");
    const isRt = rawTitle.startsWith("RT by");
    return {
      text,
      title: rawTitle,
      url: link,
      author: creator || `@${handle}`,
      timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      images,
      kind: isRt ? "retweet" : isReply ? "reply" : "post",
    };
  });
}

async function crawlAccount(handle) {
  const rss = await fetchRss(handle);
  if (!rss) return { handle, ok: false, reason: "all-instances-failed", records: [] };
  const items = parseItems(rss.body, rss.instance, handle);
  const records = items.map((it) =>
    buildIntelRecord({
      platform: "x",
      source: `@${handle}`,
      author: it.author,
      text: it.text,
      url: it.url,
      timestamp: it.timestamp,
      images: it.images,
      extra: { kind: it.kind, raw_title: it.title, via_instance: rss.instance },
    })
  );
  return { handle, ok: true, instance: rss.instance, records };
}

// Harvest @mentions from a set of records (lowercased, deduped, self-excluded).
function harvestMentions(records, excludeSet) {
  const found = new Map(); // lc handle → count
  for (const r of records) {
    for (const m of r.spread.mentions) {
      const lc = m.replace(/^@/, "").toLowerCase();
      if (lc.length < 2 || lc.length > 32) continue;
      if (excludeSet.has(lc)) continue;
      found.set(lc, (found.get(lc) || 0) + 1);
    }
  }
  // Rank by frequency — most-interacted-with accounts first.
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([h, c]) => ({ handle: h, mention_count: c }));
}

// Aggregate cross-account themes from all successful records.
function aggregateThemes(perAccount) {
  const topicTotals = {};
  const topicByAccount = {}; // topic → Set(handles that touch it)
  const mentionGraph = {};   // handle → count across whole network
  const addresses = new Map(); // mint → count
  const tgLinks = new Map();
  let totalRecords = 0, totalWithTopics = 0;

  for (const acc of perAccount) {
    if (!acc.ok) continue;
    for (const r of acc.records) {
      totalRecords++;
      if (r.topics.length) totalWithTopics++;
      for (const t of r.topics) {
        topicTotals[t] = (topicTotals[t] || 0) + 1;
        (topicByAccount[t] = topicByAccount[t] || new Set()).add(acc.handle);
      }
      for (const m of r.spread.mentions) {
        const lc = m.replace(/^@/, "").toLowerCase();
        mentionGraph[lc] = (mentionGraph[lc] || 0) + 1;
      }
      for (const a of r.metadata.mentioned_addresses) addresses.set(a, (addresses.get(a) || 0) + 1);
      for (const tl of r.spread.telegram_links) tgLinks.set(tl, (tgLinks.get(tl) || 0) + 1);
    }
  }

  // "consensus topics" = topics multiple accounts independently talk about.
  const consensus = Object.entries(topicByAccount)
    .map(([t, set]) => ({ topic: t, accounts: set.size, mentions: topicTotals[t] }))
    .sort((a, b) => b.accounts - a.accounts || b.mentions - a.mentions);

  return {
    total_records: totalRecords,
    total_with_topics: totalWithTopics,
    topic_totals: topicTotals,
    consensus_topics: consensus, // how many distinct accounts touch each topic
    mention_graph: Object.entries(mentionGraph).sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([h, c]) => ({ handle: "@" + h, count: c })),
    shared_addresses: [...addresses.entries()].filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1]).map(([a, c]) => ({ address: a, count: c })),
    shared_telegram_links: [...tgLinks.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, c]) => ({ channel: t, count: c })),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[xnet] NETWORK crawl. root=@${ROOT_HANDLE} seed=[${SEED.join(", ")}] cap=${MAX_ACCOUNTS} throttle=${THROTTLE_MS}ms`);

  // Build crawl queue: root first, then seed, capped. Depth-1 discovery appended later.
  const visited = new Set();
  const queue = [];
  const enqueue = (h) => {
    const lc = h.toLowerCase();
    if (visited.has(lc) || queue.find((q) => q.toLowerCase() === lc)) return;
    if (visited.size + queue.length >= MAX_ACCOUNTS) return; // respect cap
    queue.push(h);
  };
  enqueue(ROOT_HANDLE);
  for (const s of SEED) enqueue(s);

  const perAccount = [];
  let discoveryDone = false;

  while (queue.length) {
    const handle = queue.shift();
    const lc = handle.toLowerCase();
    if (visited.has(lc)) continue;
    visited.add(lc);

    console.log(`[xnet] (${visited.size}/${MAX_ACCOUNTS}) crawling @${handle}...`);
    const res = await crawlAccount(handle);
    perAccount.push(res);
    if (!res.ok) console.warn(`[xnet] SKIP @${handle}: ${res.reason}`);

    await sleep(THROTTLE_MS); // rate-limit courtesy

    // Depth-1 auto-discovery: ONCE, after root+seed crawled, harvest mentions
    // from the ROOT account and queue the top new ones (no recursion past depth 1).
    if (!discoveryDone && queue.length === 0 && visited.size >= 1) {
      discoveryDone = true;
      const rootRes = perAccount.find((a) => a.handle.toLowerCase() === ROOT_HANDLE.toLowerCase() && a.ok);
      if (rootRes) {
        const exclude = new Set([...visited]);
        const discovered = harvestMentions(rootRes.records, exclude);
        const slots = MAX_ACCOUNTS - visited.size;
        const toAdd = discovered.slice(0, Math.max(0, slots));
        if (toAdd.length) {
          console.log(`[xnet] depth-1 discovery from @${ROOT_HANDLE}: +${toAdd.map((d) => "@" + d.handle + "(" + d.mention_count + ")").join(", ")}`);
          for (const d of toAdd) enqueue(d.handle);
        } else {
          console.log(`[xnet] depth-1 discovery: no new accounts within cap`);
        }
      }
    }
  }

  const themes = aggregateThemes(perAccount);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(OUT_DIR, `network-graph_${stamp}.json`);
  const summary = perAccount.map((a) => ({
    handle: "@" + a.handle,
    ok: a.ok,
    reason: a.reason || null,
    instance: a.instance || null,
    items: a.records.length,
    with_topics: a.records.filter((r) => r.topics.length).length,
    topics: [...new Set(a.records.flatMap((r) => r.topics))],
  }));

  fs.writeFileSync(outFile, JSON.stringify({
    root: "@" + ROOT_HANDLE,
    seed: SEED.map((s) => "@" + s),
    crawled_at: new Date().toISOString(),
    method: "nitter-rss network-graph (depth 1, cap " + MAX_ACCOUNTS + ")",
    blocked: "reply/thread trees require X API v2 (paid) — account-graph only",
    accounts_crawled: summary,
    aggregate_themes: themes,
    per_account_records: perAccount.map((a) => ({ handle: "@" + a.handle, ok: a.ok, records: a.records })),
  }, null, 2), "utf8");

  // Console report
  console.log(`\n=== X NETWORK INTEL SUMMARY ===`);
  for (const s of summary) {
    console.log(`  ${s.ok ? "OK " : "XX "} @${s.handle.replace(/^@/, "")}: ${s.ok ? `${s.items} items, ${s.with_topics} intel, [${s.topics.join(",")}]` : s.reason}`);
  }
  console.log(`\n  AGGREGATE: ${themes.total_records} records, ${themes.total_with_topics} with intel`);
  console.log(`  consensus topics (accounts/mentions): ${themes.consensus_topics.map((c) => `${c.topic}=${c.accounts}a/${c.mentions}m`).join(", ")}`);
  console.log(`  network mention graph (top): ${themes.mention_graph.slice(0, 10).map((m) => `${m.handle}(${m.count})`).join(", ")}`);
  if (themes.shared_addresses.length) console.log(`  shared addresses: ${themes.shared_addresses.map((a) => `${a.address}(${a.count})`).join(", ")}`);
  if (themes.shared_telegram_links.length) console.log(`  shared TG: ${themes.shared_telegram_links.map((t) => `${t.channel}(${t.count})`).join(", ")}`);
  console.log(`  → ${outFile}`);
}

main().catch((e) => { console.error("[xnet fatal]", e.message); process.exit(1); });
