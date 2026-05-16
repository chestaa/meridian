/**
 * auto-screener.js
 * Cari kandidat pool DLMM terbaik dari Meteora API setiap 30 menit.
 * Evaluasi pakai DeepSeek V4 Flash (murah ~$0.00017/scan).
 * Kirim hasil ke Telegram + simpan ke signals/inbox/ untuk signal-runner.
 *
 * Run: node scripts/auto-screener.js
 * Via systemd: meridian-auto-screener.service
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import "../envcrypt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const INBOX_DIR = path.join(ROOT, "signals", "inbox");
const STATE_FILE = path.join(ROOT, "auto-screener-state.json");

const SCAN_INTERVAL_MS  = 30 * 60 * 1000; // 30 menit
const MODEL             = process.env.SCREENER_MODEL || "deepseek/deepseek-v4-flash";
const LLM_BASE_URL      = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_API_KEY       = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN           = process.env.DRY_RUN === "true";
const MAX_CANDIDATES_TO_REPORT = 3;

// ─── helpers ────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { last_scan: null, total_scans: 0, total_candidates_found: 0 }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function sendTelegram(html) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) { console.error("[telegram]", e.message); }
}

function saveToInbox(candidates) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const ts = Date.now();
  for (const c of candidates) {
    const filename = `${ts}-screener-${(c.symbol || "unknown").replace(/[^a-z0-9]/gi, "").slice(0, 12)}.txt`;
    const content = [
      `[SCREENER SIGNAL] ${c.symbol || "?"} / ${c.pair || "?"}`,
      `Pool: ${c.pool_address}`,
      `TVL: $${Number(c.tvl || 0).toFixed(0)} | Vol: $${Number(c.volume_window || 0).toFixed(0)}`,
      `Fee/TVL: ${Number(c.fee_active_tvl_ratio || 0).toFixed(4)} | Organic: ${c.organic_score || "?"}`,
      `Bin step: ${c.bin_step || "?"} | Volatility: ${Number(c.volatility || 0).toFixed(2)}`,
      `Source: Meteora auto-screener`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n");
    fs.writeFileSync(path.join(INBOX_DIR, filename), content);
  }
  console.log(`[screener] Saved ${candidates.length} candidates to inbox`);
}

async function callLlm(prompt) {
  if (!LLM_API_KEY) return null;
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "HTTP-Referer": "https://github.com/chestaa/meridian",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[llm]", e.message);
    return null;
  }
}

// ─── main scan ──────────────────────────────────────────────────
async function runScan() {
  const state = loadState();
  console.log(`[screener] Scan #${state.total_scans + 1} — ${new Date().toISOString()}`);

  // Import screener (lazy to avoid module load cost at startup)
  let candidates = [];
  try {
    const { getTopCandidates } = await import("../tools/screening.js");
    const result = await getTopCandidates({ limit: 10 });
    candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    console.log(`[screener] Found ${candidates.length} candidates after filtering`);
  } catch (e) {
    console.error("[screener] getTopCandidates failed:", e.message);
    await sendTelegram(`⚠️ <b>Screener error</b>\n${e.message.slice(0, 200)}`);
    return;
  }

  state.total_scans += 1;
  state.last_scan = new Date().toISOString();

  if (candidates.length === 0) {
    state.consecutive_empty = (state.consecutive_empty || 0) + 1;
    saveState(state);
    console.log("[screener] No candidates this scan");
    // Only notify Telegram after 6 consecutive empty scans (3 hours of nothing)
    if (state.consecutive_empty % 6 === 0) {
      await sendTelegram(
        `🔍 <b>Screener</b> — tidak ada kandidat selama ${state.consecutive_empty / 2} jam\n` +
        `<i>Market sepi atau threshold terlalu ketat</i>`
      );
    }
    return;
  }

  state.consecutive_empty = 0;
  state.total_candidates_found += candidates.length;
  saveState(state);

  // Save all to inbox for signal-runner
  saveToInbox(candidates);

  // Build LLM prompt — ultra short to save tokens
  const topN = candidates.slice(0, MAX_CANDIDATES_TO_REPORT);
  const poolSummary = topN.map((c, i) =>
    `${i + 1}. ${c.symbol || "?"} | TVL $${Number(c.tvl || 0).toFixed(0)} | ` +
    `Vol $${Number(c.volume_window || 0).toFixed(0)} | Fee/TVL ${Number(c.fee_active_tvl_ratio || 0).toFixed(3)} | ` +
    `Organic ${c.organic_score || "?"} | BinStep ${c.bin_step || "?"}`
  ).join("\n");

  const prompt = `You are a Solana DLMM LP analyst. Rate these ${topN.length} pool candidates for liquidity providing. ` +
    `Reply in Bahasa Indonesia, max 3 lines per pool. Format: "Pool X: [LAYAK/SKIP] — alasan singkat". Be direct, no intro.\n\n${poolSummary}`;

  let llmAnalysis = await callLlm(prompt);
  if (!llmAnalysis) llmAnalysis = "<i>(AI analysis tidak tersedia)</i>";

  // Format Telegram message
  const modeTag = DRY_RUN ? "🔵 DRY RUN" : "🟢 LIVE";
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", timeStyle: "short", dateStyle: "short" });
  const sep = "─────────────────";

  const poolLines = topN.map((c, i) => {
    const tvl     = `$${Number(c.tvl || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
    const vol     = `$${Number(c.volume_window || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
    const fee     = Number(c.fee_active_tvl_ratio || 0).toFixed(3);
    const organic = c.organic_score || "?";
    return `<b>${i + 1}. ${c.symbol || "?"}</b>  <code>${(c.pool_address || "").slice(0, 8)}...</code>\n` +
           `   TVL ${tvl} | Vol ${vol} | Fee/TVL ${fee} | Organic ${organic}`;
  }).join("\n\n");

  const msg = [
    `🔍 <b>SCREENER REPORT</b>  ${modeTag}`,
    `${now} WIB — ${candidates.length} kandidat lolos filter`,
    sep,
    poolLines,
    sep,
    `🤖 <b>Analisis AI (DeepSeek)</b>`,
    llmAnalysis.slice(0, 800),
    sep,
    `<i>Tersimpan ke inbox — signal-runner akan proses selanjutnya</i>`,
  ].join("\n");

  await sendTelegram(msg);
  console.log(`[screener] Sent ${topN.length} candidates to Telegram`);
}

// ─── run loop ───────────────────────────────────────────────────
console.log(`[screener] Auto-screener started. Interval: ${SCAN_INTERVAL_MS / 60000} min | Model: ${MODEL}`);
await runScan(); // immediate first scan
setInterval(runScan, SCAN_INTERVAL_MS);
