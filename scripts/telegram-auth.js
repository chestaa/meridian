/**
 * telegram-auth.js — one-time MTProto authentication for Telegram userbot.
 * Run once: node scripts/telegram-auth.js
 * Saves TELEGRAM_SESSION and TELEGRAM_WATCH_IDS to root .env
 */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));

const API_ID   = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first");
  process.exit(1);
}

// Private group invite hash from t.me/+HQvrBdMYxes0Yjk1
const PRIVATE_INVITE_HASH = "HQvrBdMYxes0Yjk1";

function upsertEnvKey(envContent, key, value) {
  const lines = envContent.split("\n").filter((l) => !l.startsWith(`${key}=`));
  if (!lines[lines.length - 1]) lines.pop(); // remove trailing blank
  lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

async function saveToEnv(key, value) {
  let content = "";
  try { content = fs.readFileSync(ENV_FILE, "utf8"); } catch { /* new file */ }
  fs.writeFileSync(ENV_FILE, upsertEnvKey(content, key, value));
  console.log(`  ✅ ${key} saved to .env`);
}

async function main() {
  console.log("=== Meridian Telegram Auth ===");
  console.log(`API ID: ${API_ID}\n`);

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Phone number (e.g. +6281234567890): "),
    phoneCode:   async () => await ask("Code from Telegram: "),
    password:    async () => await ask("2FA password (Enter if none): "),
    onError: (err) => console.error("[auth]", err.message),
  });

  const me = await client.getMe();
  console.log(`\n✅ Logged in as @${me.username || me.phone}`);

  const sessionString = client.session.save();
  await saveToEnv("TELEGRAM_SESSION", sessionString);

  // Join private group and capture its ID
  const watchIds = [];
  try {
    const result = await client.invoke(
      new Api.messages.ImportChatInvite({ hash: PRIVATE_INVITE_HASH })
    );
    const chat = result?.chats?.[0];
    if (chat) {
      const id = chat.id?.toString();
      watchIds.push(id);
      console.log(`\n✅ Joined group: "${chat.title}" → id=${id}`);
    }
  } catch (e) {
    if (e.message?.includes("USER_ALREADY_PARTICIPANT")) {
      console.log("\n[info] Already in private group — searching dialogs for ID...");
      try {
        const dialogs = await client.getDialogs({ limit: 100 });
        // The private group ID we're looking for — find by approximate match
        for (const d of dialogs) {
          if (d.entity?.className === "Channel" || d.entity?.className === "Chat") {
            console.log(`  Dialog: "${d.title}" id=${d.entity?.id}`);
          }
        }
        console.log("  ↳ Copy the correct group id above and add TELEGRAM_WATCH_IDS=<id> to .env manually");
      } catch {}
    } else if (e.message?.includes("INVITE_HASH_EXPIRED")) {
      console.warn("[warn] Invite link expired — ask for a fresh invite");
    } else {
      console.warn("[warn] Could not join private group:", e.message);
    }
  }

  // Get @agentmeridian channel ID
  try {
    const entity = await client.getEntity("agentmeridian");
    const id = entity.id?.toString();
    watchIds.push(id);
    console.log(`\n@agentmeridian → id=${id}`);
  } catch (e) {
    console.warn("Could not resolve @agentmeridian:", e.message);
  }

  if (watchIds.length > 0) {
    await saveToEnv("TELEGRAM_WATCH_IDS", watchIds.join(","));
  }

  console.log("\n✅ Auth complete!");
  console.log("Next: scp .env root@<vps>:/opt/meridian/.env  (if running on VPS)");
  console.log("Then: systemctl start meridian-telegram-userbot");

  rl.close();
  await client.disconnect();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
