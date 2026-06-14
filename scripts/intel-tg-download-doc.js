/**
 * intel-tg-download-doc.js — one-shot Telegram document/attachment downloader.
 *
 * Sirius 🐺 — Signal Collector. READ-ONLY (connects with existing session,
 * never posts). Built to grab the LP/DLMM guide HTML attachments from a public
 * channel that t.me/s web-preview cannot render (file blocks absent from preview).
 *
 * Resolves a channel, fetches a list of specific message IDs, downloads any
 * media/document attachment, and — for text-like files (html/txt/json/md/csv)
 * under ~512KB — prints the decoded content to stdout so it can be read back
 * without copying binary files off the VPS.
 *
 * Usage on VPS (session lives in /opt/meridian/.env):
 *   cd /opt/meridian && node scripts/intel-tg-download-doc.js hesz_journal 750 788
 *
 * Defaults to channel "hesz_journal", msgs 750 & 788 if no args given.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "intel", "telegram", "docs");

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION = process.env.TELEGRAM_SESSION || "";

const channel = process.argv[2] || "hesz_journal";
const msgIds = (process.argv.slice(3).length ? process.argv.slice(3) : ["750", "788"]).map((n) => parseInt(n, 10));

const TEXT_EXT = new Set([".html", ".htm", ".txt", ".json", ".md", ".csv", ".xml", ".js", ".ts"]);
const PRINT_MAX = 512 * 1024;

function attName(msg) {
  const doc = msg?.media?.document;
  if (!doc) return null;
  const attr = (doc.attributes || []).find((a) => a.fileName);
  if (attr?.fileName) return attr.fileName;
  // fallback from mime
  const mime = doc.mimeType || "";
  const ext = mime.includes("html") ? ".html" : mime.includes("json") ? ".json" : mime.includes("text") ? ".txt" : ".bin";
  return `doc_${msg.id}${ext}`;
}

async function main() {
  if (!API_ID || !API_HASH || !SESSION) {
    console.error("[tg-doc] TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set. Run on the VPS.");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  const me = await client.getMe();
  console.error(`[tg-doc] Connected as @${me.username || me.phone} (READ-ONLY)`);

  // warm entity cache so getEntity on a non-joined public channel resolves
  await client.getDialogs({ limit: 100 });

  let entity;
  try {
    entity = await client.getEntity(channel);
  } catch (e) {
    console.error(`[tg-doc] Cannot resolve @${channel}: ${e.message}`);
    console.error(`[tg-doc] If not joined, the public username should still resolve; if it fails, join the channel first.`);
    await client.disconnect();
    process.exit(2);
  }

  console.error(`[tg-doc] Fetching messages ${msgIds.join(", ")} from @${channel}...`);
  const messages = await client.getMessages(entity, { ids: msgIds });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const wantId = msgIds[i];
    console.error(`\n========== MSG ${wantId} ==========`);
    if (!msg) {
      console.error(`[tg-doc] msg ${wantId}: not found / inaccessible`);
      continue;
    }
    if (msg.message) console.error(`[caption] ${msg.message.slice(0, 400)}`);
    if (!msg.media) {
      console.error(`[tg-doc] msg ${wantId}: no media attachment (text only).`);
      continue;
    }
    const fname = attName(msg) || `doc_${wantId}.bin`;
    const safe = fname.replace(/[^\w.\-]/g, "_");
    const outPath = path.join(OUT_DIR, `${channel}_${wantId}_${safe}`);
    try {
      const buf = await client.downloadMedia(msg, {});
      fs.writeFileSync(outPath, buf);
      console.error(`[tg-doc] saved -> ${outPath} (${buf.length}B)`);
      const ext = path.extname(safe).toLowerCase();
      if (TEXT_EXT.has(ext) && buf.length <= PRINT_MAX) {
        console.log(`\n>>>>> BEGIN CONTENT msg ${wantId} (${safe}) >>>>>`);
        console.log(buf.toString("utf8"));
        console.log(`<<<<< END CONTENT msg ${wantId} <<<<<\n`);
      } else {
        console.error(`[tg-doc] msg ${wantId}: binary or >512KB, not printing (read file ${outPath} manually).`);
      }
    } catch (e) {
      console.error(`[tg-doc] msg ${wantId}: download failed: ${e.message}`);
    }
  }

  await client.disconnect();
  console.error("\n[tg-doc] done.");
}

main().catch((e) => { console.error("[tg-doc fatal]", e.message); process.exit(1); });
