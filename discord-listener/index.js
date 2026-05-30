/**
 * meridian Discord listener — selfbot
 * Watches LP Army channels for Solana addresses and runs pre-check pipeline.
 * Uses discord.js-selfbot-v13 (personal automation, not a bot token).
 *
 * Env vars (from ../.env):
 *   DISCORD_USER_TOKEN     — your Discord account token (from browser DevTools)
 *   DISCORD_GUILD_ID       — LP Army server ID
 *   DISCORD_CHANNEL_IDS    — comma-separated channel IDs to monitor
 *   DISCORD_MIN_FEES_SOL   — minimum pool fees threshold (default: 5)
 */
import { Client } from "discord.js-selfbot-v13";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Load .env from parent directory (meridian root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });

import { runPreChecks } from "./pre-checks.js";

const SIGNALS_FILE = path.join(ROOT, "discord-signals.json");
const SIGNAL_INBOX_DIR = path.join(ROOT, "signals", "inbox");

// Fix #3 — MeteoraIDN ranked-digest mirror. The screening source
// tools/sources/discord-meteoraidn.js reads this file (DISCORD_RANKED_FEED).
// We mirror the raw curated digest text here so the screener can parse pool
// addresses + Lincoln Score / FDV / TVL / bin step / base fee out-of-band.
// READ-ONLY capture: we never reply/react. Metlex firehose is NOT mirrored here.
const RANKED_DIGEST_FILE = process.env.DISCORD_RANKED_FEED || path.join(ROOT, "discord-ranked-digest.json");
const RANKED_CHANNEL_RE = /multiday-opps|exotic-opps/i;
const RANKED_DIGEST_KEEP = 60; // newest N digest messages

function mirrorRankedDigest(message, fullText) {
  try {
    let records = [];
    if (fs.existsSync(RANKED_DIGEST_FILE)) {
      try { records = JSON.parse(fs.readFileSync(RANKED_DIGEST_FILE, "utf8")); } catch { records = []; }
      if (!Array.isArray(records)) records = Array.isArray(records?.records) ? records.records : [];
    }
    records.unshift({
      source: `${message.guild?.name || "discord"}#${message.channel?.name || "unknown"}`,
      channel: message.channel?.name || "unknown",
      author: message.author?.username || "unknown",
      text: fullText,
      timestamp: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
      msg_id: message.id,
    });
    fs.writeFileSync(RANKED_DIGEST_FILE, JSON.stringify(records.slice(0, RANKED_DIGEST_KEEP), null, 2));
    console.log(`  [ranked-digest] mirrored #${message.channel?.name} → ${path.basename(RANKED_DIGEST_FILE)}`);
  } catch (err) {
    console.error(`  [ranked-digest write failed] ${err.message}`);
  }
}

function sanitizeSourceName(name) {
  return String(name || "discord")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "discord";
}

function writeInboxSignal(rawText, source) {
  try {
    fs.mkdirSync(SIGNAL_INBOX_DIR, { recursive: true });
    const filename = `${Date.now()}-${sanitizeSourceName(source)}.txt`;
    const dest = path.join(SIGNAL_INBOX_DIR, filename);
    fs.writeFileSync(dest, rawText, "utf8");
    console.log(`  [inbox] wrote ${filename}`);
  } catch (err) {
    console.error(`  [inbox write failed] ${err.message}`);
  }
}

// Solana address regex: base58, 32-44 chars
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Known non-address patterns to skip (short common words that match base58 range)
const FALSE_POSITIVE_SKIP = new Set([
  "solana", "meteora", "jupiter", "raydium", "orca",
]);

function isLikelySolanaAddress(str) {
  if (str.length < 32 || str.length > 44) return false;
  if (FALSE_POSITIVE_SKIP.has(str.toLowerCase())) return false;
  // Must contain digits (pure alpha strings are usually words)
  if (!/\d/.test(str)) return false;
  return true;
}

function loadSignals() {
  if (!fs.existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); } catch { return []; }
}

function saveSignal(record) {
  const signals = loadSignals();
  signals.unshift(record); // newest first
  // Keep last 100 signals
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(0, 100), null, 2));
}

async function processAddress(address, message, rawSignalText) {
  const result = await runPreChecks(address);
  if (!result.pass) return;

  const record = {
    id: `${address.slice(0, 8)}-${Date.now()}`,
    pool_address: result.pool_address,
    base_mint: result.base_mint,
    base_symbol: result.symbol || "?",
    signal_source: "discord",
    discord_guild: message.guild?.name || "unknown",
    discord_channel: message.channel?.name || "unknown",
    discord_author: message.author?.username || "unknown",
    discord_message_snippet: message.content?.slice(0, 120) || "",
    queued_at: new Date().toISOString(),
    rug_score: result.rug_score ?? null,
    total_fees_sol: result.total_fees_sol ?? null,
    token_age_minutes: result.token_age_minutes ?? null,
    status: "pending",
  };

  saveSignal(record);
  // Also mirror normalized signal text to signals/inbox/ for signal-runner pipeline.
  // Best-effort: failure must not crash listener.
  const sourceLabel = `${message.channel?.name || "discord"}-${record.base_symbol}`;
  writeInboxSignal(rawSignalText || "", sourceLabel);
  console.log(`\n[QUEUED] ${record.base_symbol} → ${record.pool_address}`);
  console.log(`  from: @${record.discord_author} in #${record.discord_channel}`);
  console.log(`  → Check with: node ../cli.js discord-signals`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_USER_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("ERROR: DISCORD_USER_TOKEN not set in ../.env");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("ERROR: DISCORD_GUILD_ID not set in ../.env");
  process.exit(1);
}
if (CHANNEL_IDS.length === 0) {
  console.error("ERROR: DISCORD_CHANNEL_IDS not set in ../.env (comma-separated channel IDs)");
  process.exit(1);
}

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  console.log(`\n[meridian discord-listener] Connected as ${client.user?.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.warn(`WARNING: Guild ${GUILD_ID} not found in cache. Check DISCORD_GUILD_ID.`);
  } else {
    console.log(`Watching guild: ${guild.name}`);
    const channelNames = CHANNEL_IDS.map(id => {
      const ch = guild.channels.cache.get(id);
      return ch ? `#${ch.name}` : `#${id} (not found)`;
    });
    console.log(`Channels: ${channelNames.join(", ")}`);
  }
  console.log(`\nStreaming messages... (Ctrl+C to stop)\n`);
});

client.on("messageCreate", async (message) => {
  // Only process messages from configured guild + channels
  if (message.guildId !== GUILD_ID) return;
  if (!CHANNEL_IDS.includes(message.channelId)) return;
  // Skip own messages
  if (message.author?.id === client.user?.id) return;

  const content = message.content || "";
  const embeds = message.embeds?.map(e => `${e.title || ""} ${e.description || ""}`).join(" ") || "";
  const fullText = `${content} ${embeds}`;

  // Fix #3 — mirror MeteoraIDN ranked-digest channels for the screening source.
  // This runs for ANY author in those channels (the digest is posted by the
  // MeteoraIDN bot) and is independent of the Metlex address pipeline below.
  if (RANKED_CHANNEL_RE.test(message.channel?.name || "")) {
    mirrorRankedDigest(message, fullText);
    return; // ranked digest is not an address-firehose message; nothing more to do
  }

  // Only process messages from Metlex Pool Bot for the address pipeline
  if (message.author?.username !== "Metlex Pool Bot") return;

  const matches = [...fullText.matchAll(SOL_ADDR_RE)].map(m => m[0]);
  const unique = [...new Set(matches)].filter(isLikelySolanaAddress);

  if (unique.length === 0) return;

  console.log(`\n[message] @${message.author?.username} in #${message.channel?.name}: "${content.slice(0, 80)}"`);
  console.log(`  Addresses found: ${unique.join(", ")}`);

  // Process each address independently (don't await — handle concurrently but logged sequentially)
  for (const addr of unique) {
    await processAddress(addr, message, fullText);
  }
});

client.on("error", (err) => {
  console.error("[discord error]", err.message);
});

client.login(TOKEN);
