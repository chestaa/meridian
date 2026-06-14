/**
 * intel-discord.js — channel-history intel crawler for Metlex/Meridian Discord.
 *
 * Sirius 🐺 — Signal Collector.
 *
 * ⚠️ ToS RISK (HONEST FLAG): This uses discord.js-selfbot-v13 (a USER token,
 * not a bot token). Automating a user account violates Discord ToS and CAN
 * result in account ban. The existing discord-listener/ already uses this
 * method (real-time), so this crawler does not add new risk class — but
 * HISTORY crawl makes more API calls in a burst, which is MORE detectable
 * than passive listening. Throttled to mitigate. Use a burner Discord account.
 *
 * READ-ONLY: fetches channel history only. Never sends/reacts/joins.
 *
 * Reuses ../.env: DISCORD_USER_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_IDS.
 *
 * Run on VPS (token lives there):
 *   ssh root@vps "cd /opt/meridian/discord-listener && node ../scripts/intel-discord.js [perChannelLimit]"
 *
 * NOTE: requires discord.js-selfbot-v13, which is installed in
 * discord-listener/node_modules — run with that as cwd or node will not resolve it.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// discord.js-selfbot-v13 lives in discord-listener/node_modules, NOT root.
// Anchor module resolution there so this script works regardless of cwd.
const LISTENER_DIR = path.join(ROOT, "discord-listener");
const require = createRequire(path.join(LISTENER_DIR, "index.js"));
require("dotenv").config({ path: path.join(ROOT, ".env") });

const OUT_DIR = path.join(ROOT, "intel", "discord");
const PER_CHANNEL = parseInt(process.env.INTEL_LIMIT || process.argv[2] || "500", 10);
const THROTTLE_MS = parseInt(process.env.INTEL_THROTTLE_MS || "1200", 10); // gentle, ToS-aware

const TOKEN = process.env.DISCORD_USER_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

function fail(msg) { console.error(`[dc-intel] ${msg}`); process.exit(1); }
if (!TOKEN) fail("DISCORD_USER_TOKEN not set in ../.env");
if (!GUILD_ID) fail("DISCORD_GUILD_ID not set in ../.env");
if (CHANNEL_IDS.length === 0) fail("DISCORD_CHANNEL_IDS not set in ../.env");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Lazy imports so the file parses even where deps aren't installed.
  const { Client } = require("discord.js-selfbot-v13");
  const { buildIntelRecord } = await import("./intel-extract.js");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[dc-intel] ⚠️ selfbot history crawl — ToS risk. READ-ONLY, throttled.");

  const client = new Client({ checkUpdate: false });
  const records = [];

  await new Promise((resolve, reject) => {
    client.once("ready", async () => {
      try {
        console.log(`[dc-intel] Connected as ${client.user?.tag}`);
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return reject(new Error(`Guild ${GUILD_ID} not in cache`));
        console.log(`[dc-intel] Guild: ${guild.name}`);

        for (const chId of CHANNEL_IDS) {
          const ch = guild.channels.cache.get(chId);
          if (!ch || typeof ch.messages?.fetch !== "function") {
            console.warn(`[dc-intel] channel ${chId} not fetchable, skip`);
            continue;
          }
          console.log(`[dc-intel] #${ch.name}: fetching up to ${PER_CHANNEL} msgs...`);
          let before = undefined;
          let got = 0;
          while (got < PER_CHANNEL) {
            const batch = await ch.messages.fetch({ limit: Math.min(100, PER_CHANNEL - got), before });
            if (!batch.size) break;
            for (const msg of batch.values()) {
              const content = msg.content || "";
              const embeds = (msg.embeds || []).map((e) => `${e.title || ""} ${e.description || ""}`).join(" ");
              const text = `${content} ${embeds}`.trim();
              if (!text) continue;
              const images = (msg.attachments ? [...msg.attachments.values()] : [])
                .filter((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.url || a.name || ""))
                .map((a) => a.url);
              records.push(buildIntelRecord({
                platform: "discord",
                source: `${guild.name}#${ch.name}`,
                author: msg.author?.username || "unknown",
                text,
                url: `https://discord.com/channels/${GUILD_ID}/${chId}/${msg.id}`,
                timestamp: msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString(),
                images,
                extra: { msg_id: msg.id, bot: !!msg.author?.bot, channel_id: chId },
              }));
              before = msg.id;
              got++;
            }
            await sleep(THROTTLE_MS); // ToS-aware pacing
          }
          console.log(`[dc-intel] #${ch.name}: ${got} fetched`);
        }
        resolve();
      } catch (e) { reject(e); }
    });
    client.on("error", reject);
    client.login(TOKEN).catch(reject);
  });

  await client.destroy();

  const intel = records.filter((r) => r.topics.length);
  const topicCount = {};
  for (const r of records) for (const t of r.topics) topicCount[t] = (topicCount[t] || 0) + 1;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(OUT_DIR, `meridian_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    crawled_at: new Date().toISOString(),
    method: "selfbot-channel-history",
    tos_risk: "user-token automation violates Discord ToS; use burner account",
    guild_id: GUILD_ID,
    channels: CHANNEL_IDS,
    total_messages: records.length,
    with_intel_topics: intel.length,
    topic_counts: topicCount,
    records: intel,
  }, null, 2), "utf8");

  console.log(`\n=== DISCORD INTEL SUMMARY ===`);
  console.log(`  msgs: ${records.length}, with intel: ${intel.length}`);
  console.log(`  topics: ${Object.entries(topicCount).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`  → ${outFile}`);
  process.exit(0);
}

main().catch((e) => { console.error("[dc-intel fatal]", e.message); process.exit(1); });
