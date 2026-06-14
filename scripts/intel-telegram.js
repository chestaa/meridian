/**
 * intel-telegram.js — full-history intel crawler for Meridian Telegram chats.
 *
 * Sirius 🐺 — Signal Collector.
 *
 * Extends the telegram-history.js pattern but extracts QUALITATIVE INTEL
 * (keluh kesah / technical / alpha / profit-loss talk) instead of only Solana
 * addresses. READ-ONLY — connects with the existing live session, never posts.
 *
 * Reuses the SAME sources + live MTProto session already on the VPS:
 *   @agentmeridian (public channel) + meridian-discussion (private group).
 *
 * Run on VPS (session lives there):
 *   ssh root@vps "cd /opt/meridian && node scripts/intel-telegram.js [limit]"
 * Locally only works if TELEGRAM_SESSION is in your local .env.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { buildIntelRecord } from "./intel-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "intel", "telegram");

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION = process.env.TELEGRAM_SESSION || "";
const LIMIT = parseInt(process.env.INTEL_LIMIT || process.argv[2] || "3000", 10);

const SOURCES = [
  { type: "username", value: "agentmeridian", label: "agentmeridian" },
  { type: "id", value: "3698411335", label: "meridian-discussion" },
];

async function crawlSource(client, source) {
  let entity;
  try {
    entity = source.type === "id"
      ? await client.getEntity(BigInt(source.value))
      : await client.getEntity(source.value);
  } catch (e) {
    console.error(`[tg-intel] Cannot resolve ${source.label}: ${e.message}`);
    return { label: source.label, total: 0, withIntel: 0, records: [] };
  }

  console.log(`[tg-intel] Fetching up to ${LIMIT} messages from ${source.label}...`);
  const messages = await client.getMessages(entity, { limit: LIMIT });

  const records = [];
  for (const msg of messages) {
    const text = msg.message || "";
    if (!text.trim()) continue;
    const ts = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
    const authorId = msg.fromId?.userId?.toString() || msg.senderId?.toString() || "unknown";
    const rec = buildIntelRecord({
      platform: "telegram",
      source: source.label,
      author: authorId,
      text,
      url: null,
      timestamp: ts,
      images: msg.media ? ["<telegram-media:not-downloaded>"] : [],
      extra: {
        msg_id: msg.id,
        has_media: !!msg.media,
        views: msg.views ?? null,
        forwards: msg.forwards ?? null,
      },
    });
    records.push(rec);
  }

  const withIntel = records.filter((r) => r.topics.length);
  console.log(`[tg-intel] ${source.label}: ${records.length} msgs, ${withIntel.length} with intel topics`);
  return { label: source.label, total: records.length, withIntel: withIntel.length, records };
}

async function main() {
  if (!API_ID || !API_HASH || !SESSION) {
    console.error("[tg-intel] TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set.");
    console.error("[tg-intel] These live on the VPS .env — run there, not locally.");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  const me = await client.getMe();
  console.log(`[tg-intel] Connected as @${me.username || me.phone} (READ-ONLY)`);

  console.log("[tg-intel] Warming entity cache (dialogs)...");
  await client.getDialogs({ limit: 100 });

  const results = [];
  for (const src of SOURCES) results.push(await crawlSource(client, src));
  await client.disconnect();

  const allRecords = results.flatMap((r) => r.records);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(OUT_DIR, `meridian_${stamp}.json`);

  const topicCount = {};
  for (const r of allRecords) for (const t of r.topics) topicCount[t] = (topicCount[t] || 0) + 1;
  const authors = {};
  for (const r of allRecords) if (r.topics.length) authors[r.author] = (authors[r.author] || 0) + 1;

  fs.writeFileSync(outFile, JSON.stringify({
    crawled_at: new Date().toISOString(),
    method: "mtproto-userbot-history",
    sources: SOURCES.map((s) => s.label),
    limit_per_source: LIMIT,
    total_messages: allRecords.length,
    with_intel_topics: allRecords.filter((r) => r.topics.length).length,
    topic_counts: topicCount,
    records: allRecords.filter((r) => r.topics.length), // store only intel-bearing to keep file lean
  }, null, 2), "utf8");

  console.log(`\n=== TELEGRAM INTEL SUMMARY ===`);
  for (const r of results) console.log(`  ${r.label}: ${r.total} msgs, ${r.withIntel} intel`);
  console.log(`  topics: ${Object.entries(topicCount).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`  → ${outFile}`);
}

main().catch((e) => { console.error("[tg-intel fatal]", e.message); process.exit(1); });
