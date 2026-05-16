/**
 * telegram-history.js — fetch historical messages from watched Telegram chats.
 * Saves messages containing Solana addresses to signals/history/ for review.
 *
 * Run: node scripts/telegram-history.js
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HISTORY_DIR = path.join(ROOT, "signals", "history");

const API_ID   = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION  = process.env.TELEGRAM_SESSION || "";
const LIMIT    = parseInt(process.env.HISTORY_LIMIT || process.argv[2] || "2000", 10); // messages per source

// Same sources as userbot
const SOURCES = [
  { type: "username", value: "agentmeridian",   label: "agentmeridian" },
  { type: "id",       value: "3698411335",       label: "meridian-discussion" },
];

const SOL_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
function hasSolanaAddress(text) {
  const matches = [...text.matchAll(SOL_ADDR_RE)].map(m => m[0]);
  return matches.some(a => a.length >= 32 && a.length <= 44 && /\d/.test(a));
}

async function fetchSource(client, source) {
  let entity;
  try {
    entity = source.type === "id"
      ? await client.getEntity(BigInt(source.value))
      : await client.getEntity(source.value);
  } catch (e) {
    console.error(`[history] Cannot resolve ${source.label}: ${e.message}`);
    return { label: source.label, total: 0, saved: 0 };
  }

  console.log(`[history] Fetching ${LIMIT} messages from ${source.label}...`);
  const messages = await client.getMessages(entity, { limit: LIMIT });

  let saved = 0;
  for (const msg of messages) {
    const text = msg.message || "";
    if (!text || !hasSolanaAddress(text)) continue;

    const ts   = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
    const slug = ts.slice(0, 10);
    const filename = `${msg.date || Date.now()}-${source.label}.txt`;
    const dest = path.join(HISTORY_DIR, filename);

    // Skip duplicates
    if (fs.existsSync(dest)) continue;

    const content = [
      `[TELEGRAM HISTORY] source=${source.label} msg_id=${msg.id}`,
      `Timestamp: ${ts}`,
      ``,
      text,
    ].join("\n");

    fs.writeFileSync(dest, content, "utf8");
    saved++;
  }

  console.log(`[history] ${source.label}: ${messages.length} fetched, ${saved} with Solana address saved`);
  return { label: source.label, total: messages.length, saved };
}

async function main() {
  if (!API_ID || !API_HASH || !SESSION) {
    console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set");
    process.exit(1);
  }

  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();
  const me = await client.getMe();
  console.log(`[history] Connected as @${me.username || me.phone}`);

  // Warm entity cache so private group IDs resolve correctly
  console.log("[history] Loading dialogs to warm entity cache...");
  await client.getDialogs({ limit: 100 });

  const results = [];
  for (const src of SOURCES) {
    results.push(await fetchSource(client, src));
  }

  await client.disconnect();

  console.log("\n=== SUMMARY ===");
  let totalSaved = 0;
  for (const r of results) {
    console.log(`  ${r.label}: ${r.saved} signal files saved (of ${r.total} msgs)`);
    totalSaved += r.saved;
  }
  console.log(`\nTotal: ${totalSaved} files → signals/history/`);
  console.log(`Run signal-runner against history: SIGNAL_DIR=signals/history node scripts/signal-runner.js --once`);
}

main().catch(e => { console.error("[history fatal]", e.message); process.exit(1); });
