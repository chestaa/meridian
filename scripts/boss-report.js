/**
 * Boss Report — ringkasan harian ke Telegram
 * Run: node scripts/boss-report.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")); }
  catch { return null; }
}

function countFiles(dir) {
  try {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return 0;
    return fs.readdirSync(full).filter(f => !f.startsWith(".")).length;
  } catch { return 0; }
}

function progressBar(pct, len = 10) {
  const filled = Math.round(Math.min(pct, 100) / 100 * len);
  return "█".repeat(filled) + "░".repeat(len - filled);
}

async function getSolBalance(pubkey, rpcUrl) {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pubkey] }),
    });
    const d = await res.json();
    return (d?.result?.value ?? 0) / 1e9;
  } catch { return null; }
}

async function sendTelegram(token, chatId, html) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) { const t = await res.text(); console.error("TG error:", t.slice(0,200)); }
  return res.ok;
}

// ─── env ────────────────────────────────────────────────────────
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!TOKEN || !CHAT_ID) { console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"); process.exit(1); }

// ─── wallet balance ──────────────────────────────────────────────
let solBalance = null;
let burnerPubkey = null;
try {
  const wl = await import("../wallet-loader.js");
  const kp = wl.getSigningWallet();
  burnerPubkey = kp.publicKey.toBase58();
  solBalance = await getSolBalance(burnerPubkey, RPC_URL);
} catch { /* dry-run or no key */ }

// ─── paper trades ────────────────────────────────────────────────
const tradeArr = (() => { const d = readJson("paper-trades.json"); return Array.isArray(d) ? d : []; })();
const openTrades   = tradeArr.filter(t => !t.closed_at);
const closedTrades = tradeArr.filter(t => !!t.closed_at);
const winners = closedTrades.filter(t => (t.fee_inclusive_pnl_pct ?? t.pnl_pct ?? 0) > 0);
const losers  = closedTrades.filter(t => (t.fee_inclusive_pnl_pct ?? t.pnl_pct ?? 0) <= 0);
const totalPnlPct = closedTrades.length
  ? (closedTrades.reduce((s, t) => s + (t.fee_inclusive_pnl_pct ?? t.pnl_pct ?? 0), 0) / closedTrades.length).toFixed(1)
  : null;

// ─── signals ─────────────────────────────────────────────────────
const inboxCount    = countFiles("signals/inbox");
const rejectedCount = countFiles("signals/rejected");

// ─── LLM cost ────────────────────────────────────────────────────
const llmData = readJson("llm-usage.json") || {};
const llmRecs = Array.isArray(llmData.records) ? llmData.records : [];
const today   = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
const costToday = llmRecs.filter(r => r.timestamp?.startsWith(today)).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const costWeek  = llmRecs.filter(r => r.timestamp >= weekAgo).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

// ─── circuit breaker ─────────────────────────────────────────────
const cb         = readJson("circuit-breaker-state.json");
const cbHalted   = cb?.halted ?? false;
const cbLossSol  = cb?.realized_loss_sol ?? 0;
const cbCapSol   = 0.10;
const cbPct      = Math.min(100, (cbLossSol / cbCapSol) * 100);
const cbBar      = progressBar(cbPct);

// ─── timestamp ──────────────────────────────────────────────────
const nowStr = new Date().toLocaleString("id-ID", {
  timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
  year: "numeric", hour: "2-digit", minute: "2-digit"
});

// ─── build message ──────────────────────────────────────────────
const modeEmoji = DRY_RUN ? "🔵" : "🟢";
const modeText  = DRY_RUN ? "Simulasi (aman, belum pakai uang beneran)" : "LIVE — uang sungguhan";

const balSection = solBalance != null
  ? `💳 Saldo wallet\n<code>${solBalance.toFixed(4)} SOL</code> (~$${(solBalance * 135).toFixed(2)})\n<i>${burnerPubkey?.slice(0,8)}...${burnerPubkey?.slice(-4)}</i>`
  : `💳 Saldo wallet\n<i>tidak terbaca</i>`;

const tradeSection = (() => {
  if (closedTrades.length === 0 && openTrades.length === 0)
    return `📊 Trading\nBelum ada trade sama sekali`;
  const lines = [`📊 Trading`];
  if (openTrades.length > 0) lines.push(`▶️ Posisi aktif: <b>${openTrades.length}</b>`);
  if (closedTrades.length > 0) {
    lines.push(`✅ Menang: ${winners.length}  ❌ Kalah: ${losers.length}`);
    if (totalPnlPct) lines.push(`📈 Rata-rata PnL: <b>${totalPnlPct}%</b>`);
  } else {
    lines.push(`Belum ada trade selesai`);
  }
  return lines.join("\n");
})();

const signalSection = (() => {
  const lines = [`📡 Sinyal Discord`];
  if (inboxCount > 0) lines.push(`⏳ Menunggu diproses: <b>${inboxCount}</b>`);
  else lines.push(`⏳ Menunggu: <b>0</b> (belum ada sinyal masuk)`);
  lines.push(`❌ Ditolak filter: ${rejectedCount}`);
  lines.push(`<i>Sumber: #dlmm-exotic-opps, #dlmm-multiday-opps, #metlex-dlmm-bot, #metlex-dammv2-bot</i>`);
  return lines.join("\n");
})();

const cbSection = (() => {
  const statusLine = cbHalted
    ? `🔴 <b>BOT BERHENTI</b> — rugi ${cbLossSol.toFixed(4)} SOL hari ini`
    : `🛡️ Aman`;
  return [
    `🔒 Pengaman (Circuit Breaker)`,
    statusLine,
    `Rugi hari ini: ${cbLossSol.toFixed(4)} / ${cbCapSol} SOL`,
    `<code>[${cbBar}] ${cbPct.toFixed(0)}%</code>`,
    `<i>Bot otomatis berhenti kalau rugi > 0.10 SOL sehari</i>`,
  ].join("\n");
})();

const costSection = [
  `🤖 Biaya AI (OpenRouter)`,
  `Hari ini: <b>$${costToday.toFixed(3)}</b>  |  7 hari: <b>$${costWeek.toFixed(3)}</b>`,
  `<i>Batas: $0.75/hari · $5/minggu</i>`,
].join("\n");

const sep = `─────────────────────`;

const fullMsg = [
  `🤖 <b>MERIDIAN REPORT</b>`,
  `${nowStr} WIB  |  ${modeEmoji} ${modeText}`,
  sep,
  balSection,
  sep,
  tradeSection,
  sep,
  signalSection,
  sep,
  cbSection,
  sep,
  costSection,
].join("\n");

const ok = await sendTelegram(TOKEN, CHAT_ID, fullMsg);
console.log(ok ? "✅ Report terkirim" : "❌ Gagal kirim");
