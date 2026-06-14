/**
 * intel-telegram-webpreview.js — FULL-HISTORY crawler for a PUBLIC Telegram
 * channel via the t.me/s/<channel> web preview (NO session, NO API key).
 *
 * Sirius 🐺 — Signal Collector. READ-ONLY.
 *
 * The public web preview (t.me/s/<channel>) paginates backwards via
 * ?before=<msg_id>. We walk from the newest post all the way to msg 1,
 * parsing each post's text, datetime, views and permalink straight from the
 * HTML. Works for ANY public channel without the VPS MTProto session.
 *
 * Usage:
 *   node scripts/intel-telegram-webpreview.js <channel> [maxPages]
 *   node scripts/intel-telegram-webpreview.js hesz_journal
 *
 * Output: intel/telegram/<channel>_webpreview_<stamp>.json (gitignored)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildIntelRecord } from "./intel-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "intel", "telegram");

const CHANNEL = process.argv[2] || "hesz_journal";
const MAX_PAGES = parseInt(process.argv[3] || "200", 10);
const THROTTLE_MS = parseInt(process.env.INTEL_TG_THROTTLE_MS || "900", 10);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "") // strip remaining tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([0-9a-fx]+);/gi, "") // drop leftover odd entities
    .trim();
}

/**
 * Parse one preview HTML page into an array of posts.
 *
 * The web preview lays each post out as a wrapper carrying data-post="ch/ID",
 * followed (further down the same wrapper) by the text body, optional poll
 * question / document title, datetime, and views. We slice the HTML into
 * per-post segments using the data-post anchors as boundaries so a post that
 * has no text body can't "steal" the next post's text via a greedy match.
 */
function parsePage(html) {
  const posts = [];
  const anchorRe = /data-post="[^/]+\/(\d+)"/g;
  const anchors = [];
  let m;
  while ((m = anchorRe.exec(html))) {
    anchors.push({ id: parseInt(m[1], 10), index: m.index });
  }
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const chunk = html.slice(start, end);
    const msgId = anchors[i].id;

    // Message text body — stop at the first footer/reply/poll/date marker.
    const textMatch = chunk.match(
      /tgme_widget_message_text js-message_text[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_(?:footer|reply|poll|document|media)|<a class="tgme_widget_message_date|<div class="tgme_widget_message_bubble)/
    );
    let text = textMatch ? decodeEntities(textMatch[1]) : "";

    // Poll question (channel uses polls heavily)
    const pollQ = chunk.match(/<div class="tgme_widget_message_poll_question">([\s\S]*?)<\/div>/);
    if (pollQ) text = (text ? text + "\n" : "") + "[POLL] " + decodeEntities(pollQ[1]);

    // Document / file attachment (the lp-screening-guide.html etc.)
    const docTitle = chunk.match(/<div class="tgme_widget_message_document_title[^"]*">([\s\S]*?)<\/div>/);
    if (docTitle) {
      const fname = decodeEntities(docTitle[1]);
      text = (text ? text + "\n" : "") + `[FILE] ${fname}`;
    }

    // Datetime (first datetime after this anchor belongs to this post)
    const dt = chunk.match(/datetime="([^"]+)"/);
    const timestamp = dt ? dt[1] : null;

    // Views
    const views = chunk.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/);

    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video/.test(chunk);

    if (!posts.find((p) => p.msgId === msgId)) {
      posts.push({
        msgId,
        text,
        timestamp,
        views: views ? views[1] : null,
        hasMedia,
        url: `https://t.me/${CHANNEL}/${msgId}`,
      });
    }
  }
  return posts;
}

async function fetchPage(before) {
  const url = before
    ? `https://t.me/s/${CHANNEL}?before=${before}`
    : `https://t.me/s/${CHANNEL}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9,id;q=0.8" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[tg-web] FULL-HISTORY crawl of public channel @${CHANNEL} via web preview (READ-ONLY)`);

  const seen = new Map(); // msgId -> post
  let before = null;
  let pages = 0;
  let lowest = Infinity;

  while (pages < MAX_PAGES) {
    let html;
    try {
      html = await fetchPage(before);
    } catch (e) {
      console.error(`[tg-web] fetch failed (page ${pages}, before=${before}): ${e.message}`);
      break;
    }
    const posts = parsePage(html);
    if (!posts.length) {
      console.log(`[tg-web] page ${pages} (before=${before}) returned 0 posts → reached start or end.`);
      break;
    }
    let newCount = 0;
    let pageLowest = Infinity;
    for (const p of posts) {
      pageLowest = Math.min(pageLowest, p.msgId);
      if (!seen.has(p.msgId)) {
        seen.set(p.msgId, p);
        newCount++;
      }
    }
    pages++;
    console.log(`[tg-web] page ${pages}: ${posts.length} posts (${newCount} new), id range ${pageLowest}..${Math.max(...posts.map((p) => p.msgId))}, total=${seen.size}`);

    if (pageLowest >= lowest && newCount === 0) {
      console.log(`[tg-web] no progress backwards → stop.`);
      break;
    }
    lowest = Math.min(lowest, pageLowest);
    if (lowest <= 1) {
      console.log(`[tg-web] reached msg #1 → full history captured.`);
      break;
    }
    before = lowest; // paginate strictly older
    await sleep(THROTTLE_MS);
  }

  const all = [...seen.values()].sort((a, b) => a.msgId - b.msgId);
  const records = all
    .filter((p) => p.text && p.text.trim())
    .map((p) =>
      buildIntelRecord({
        platform: "telegram",
        source: CHANNEL,
        author: CHANNEL, // broadcast channel — single author
        text: p.text,
        url: p.url,
        timestamp: p.timestamp || new Date().toISOString(),
        images: p.hasMedia ? ["<telegram-media:not-downloaded>"] : [],
        extra: { msg_id: p.msgId, views: p.views, has_media: p.hasMedia },
      })
    );

  const topicCount = {};
  for (const r of records) for (const t of r.topics) topicCount[t] = (topicCount[t] || 0) + 1;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(OUT_DIR, `${CHANNEL}_webpreview_${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        crawled_at: new Date().toISOString(),
        method: "tme-web-preview-pagination",
        channel: CHANNEL,
        pages_fetched: pages,
        total_posts_seen: seen.size,
        text_records: records.length,
        id_range: all.length ? [all[0].msgId, all[all.length - 1].msgId] : [],
        topic_counts: topicCount,
        records,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`\n=== ${CHANNEL} WEB-PREVIEW SUMMARY ===`);
  console.log(`  pages: ${pages}, posts seen: ${seen.size}, text records: ${records.length}`);
  console.log(`  id range: ${all.length ? all[0].msgId + ".." + all[all.length - 1].msgId : "none"}`);
  console.log(`  topics: ${Object.entries(topicCount).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`  → ${outFile}`);
}

main().catch((e) => {
  console.error("[tg-web fatal]", e.message);
  process.exit(1);
});
