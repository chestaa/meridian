/**
 * Boss Report — ringkasan harian ke Telegram
 * Run: node scripts/boss-report.js
 *
 * Section generators are exported (pure functions, no I/O when given inputs)
 * so scripts/test-boss-report-sections.js can exercise them on mock data.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Defaults — used to detect "evolved" thresholds (current ≠ default)
const DEFAULT_MIN_ORGANIC = 60;
const DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO = 0.05;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")); }
  catch { return null; }
}

function readJsonl(file, { maxLines = 5000 } = {}) {
  try {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* ignore broken */ }
    }
    return out;
  } catch { return []; }
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

function median(nums) {
  const arr = nums.filter(n => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
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

// ─── Section generators (pure, exported) ─────────────────────────

/**
 * Lessons Engine State — performance records + evolved thresholds + top lessons.
 * @param {Object} lessonsState - normalized { lessons:[], performance:[], _lastEvolved?, _config? }
 * @returns {string|null}
 */
export function buildLessonsSection(lessonsState, userConfig = {}) {
  if (!lessonsState || (!Array.isArray(lessonsState.performance) && !Array.isArray(lessonsState.lessons))) {
    return null;
  }
  const perf = Array.isArray(lessonsState.performance) ? lessonsState.performance : [];
  const lessons = Array.isArray(lessonsState.lessons) ? lessonsState.lessons : [];
  const paperCount = perf.filter(p => p.source === "paper").length;
  const liveCount  = perf.filter(p => p.source !== "paper").length;

  const minOrganic    = userConfig.minOrganic ?? DEFAULT_MIN_ORGANIC;
  const minFeeRatio   = userConfig.minFeeActiveTvlRatio ?? DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO;
  const lastEvolved   = userConfig._lastEvolved || null;
  const organicTag    = minOrganic === DEFAULT_MIN_ORGANIC ? "default" : `evolved from ${DEFAULT_MIN_ORGANIC}`;
  const feeRatioTag   = minFeeRatio === DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO ? "default" : `evolved from ${DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO}`;

  // Top 3 lessons by confidence desc, tie-break recency
  const ranked = [...lessons]
    .filter(l => l && l.rule)
    .sort((a, b) => {
      const ca = a.confidence ?? 0;
      const cb = b.confidence ?? 0;
      if (cb !== ca) return cb - ca;
      return (b.created_at || "").localeCompare(a.created_at || "");
    })
    .slice(0, 3);

  const lines = [
    `🧠 <b>Lessons Engine</b>`,
    `Records: <b>${perf.length}</b> (live ${liveCount} · paper ${paperCount})`,
    `minOrganic: <b>${minOrganic}</b> (${organicTag})`,
    `minFeeActiveTvlRatio: <b>${minFeeRatio}</b> (${feeRatioTag})`,
  ];
  if (lastEvolved) lines.push(`Last evolution: <i>${lastEvolved.slice(0, 16).replace("T", " ")}</i>`);
  if (ranked.length > 0) {
    lines.push(`Top lessons:`);
    for (const l of ranked) {
      const conf = l.confidence != null ? `${Math.round(l.confidence * 100)}%` : "—";
      const rule = String(l.rule).slice(0, 90);
      lines.push(`• [${conf}] ${rule}`);
    }
  }
  return lines.join("\n");
}

/**
 * Max Drawdown Stats — depends on paper-trades.json schema with max_drawdown_pct.
 * @param {Array} trades
 * @returns {string|null}
 */
export function buildDrawdownSection(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const cutoff = Date.now() - 24 * 3_600_000;
  const closed24h = trades.filter(t => {
    if (!t.closed_at) return false;
    const ts = Date.parse(t.closed_at);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (closed24h.length === 0) return null;

  const dds = closed24h.map(t => Number(t.max_drawdown_pct)).filter(Number.isFinite);
  const medDd = median(dds);
  const worstDd = dds.length ? Math.max(...dds) : null;

  const counts = { DRAWDOWN_RECOVERY: 0, STOP_LOSS: 0, TAKE_PROFIT: 0, TRAILING_TP: 0, OUT_OF_RANGE: 0, OTHER: 0 };
  for (const t of closed24h) {
    const act = t.close_action;
    if (act && counts[act] != null) counts[act]++;
    else counts.OTHER++;
  }

  const lines = [
    `📉 <b>Drawdown Stats (24h)</b>`,
    `Closed paper: <b>${closed24h.length}</b>`,
    `Median max_dd: <b>${medDd != null ? medDd.toFixed(2) + "%" : "—"}</b>  |  Worst: <b>${worstDd != null ? worstDd.toFixed(2) + "%" : "—"}</b>`,
    `Exits: DD-Rec ${counts.DRAWDOWN_RECOVERY} · SL ${counts.STOP_LOSS} · TP ${counts.TAKE_PROFIT} · Trail ${counts.TRAILING_TP} · OOR ${counts.OUT_OF_RANGE}`,
  ];
  return lines.join("\n");
}

/**
 * What Orion is Rejecting — top 3 skip reasons from signal-results.jsonl (24h).
 * @param {Array} entries - parsed JSONL rows
 * @returns {string|null}
 */
export function buildOrionRejectionsSection(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const cutoff = Date.now() - 24 * 3_600_000;
  const recent = entries.filter(e => {
    const ts = Date.parse(e.ts || e.timestamp || "");
    if (!Number.isFinite(ts)) return false;
    return ts >= cutoff;
  });
  const skips = recent.filter(e => {
    const dec = e.llm?.decision || e.decision;
    return typeof dec === "string" && dec.toLowerCase() === "skip";
  });
  if (skips.length === 0) return null;

  // Normalize reasons by extracting the first ~60 chars (keyword-style bucket)
  const buckets = new Map();
  for (const e of skips) {
    const raw = e.llm?.reason || e.reason || "(no reason)";
    const key = String(raw).slice(0, 80).trim();
    if (!buckets.has(key)) buckets.set(key, 0);
    buckets.set(key, buckets.get(key) + 1);
  }
  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const lines = [
    `🏹 <b>Orion rejected (24h)</b>: ${skips.length} signals`,
  ];
  for (const [reason, count] of top) {
    lines.push(`• <b>${count}×</b> ${reason}`);
  }
  return lines.join("\n");
}

// Export helpers for tests
export { readJson, readJsonl, median };

// ─── CLI entrypoint ─────────────────────────────────────────────
// Only execute the live report when this file is run directly (not on import).
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runBossReport();
}

async function runBossReport() {
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
  const tradesRaw = readJson("paper-trades.json");
  const tradeArr = Array.isArray(tradesRaw?.trades) ? tradesRaw.trades : (Array.isArray(tradesRaw) ? tradesRaw : []);
  const openTrades   = tradeArr.filter(t => !t.closed_at);
  const closedTrades = tradeArr.filter(t => !!t.closed_at);
  const winners = closedTrades.filter(t => (t.final_fee_inclusive_pnl_pct ?? t.fee_inclusive_pnl_pct ?? t.final_pnl_pct ?? t.pnl_pct ?? 0) > 0);
  const losers  = closedTrades.filter(t => (t.final_fee_inclusive_pnl_pct ?? t.fee_inclusive_pnl_pct ?? t.final_pnl_pct ?? t.pnl_pct ?? 0) <= 0);
  const totalPnlPct = closedTrades.length
    ? (closedTrades.reduce((s, t) => s + (t.final_fee_inclusive_pnl_pct ?? t.fee_inclusive_pnl_pct ?? t.final_pnl_pct ?? t.pnl_pct ?? 0), 0) / closedTrades.length).toFixed(1)
    : null;

  // ─── signals ─────────────────────────────────────────────────────
  const inboxCount    = countFiles("signals/inbox");
  const rejectedCount = countFiles("signals/rejected");

  // ─── LLM cost ────────────────────────────────────────────────────
  const llmData = readJson("llm-usage.json") || {};
  const llmRecs = Array.isArray(llmData.records) ? llmData.records : [];
  const today   = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const costToday = llmRecs.filter(r => r.ts?.startsWith(today)).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const costWeek  = llmRecs.filter(r => r.ts >= weekAgo).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  // ─── circuit breaker ─────────────────────────────────────────────
  const cb         = readJson("circuit-breaker-state.json");
  const cbHalted   = cb?.halted ?? false;
  const cbLossSol  = cb?.realized_loss_sol ?? 0;
  const cbCapSol   = 0.10;
  const cbPct      = Math.min(100, (cbLossSol / cbCapSol) * 100);
  const cbBar      = progressBar(cbPct);

  // ─── NEW sections (lessons, drawdown, orion rejections) ─────────
  const lessonsState = readJson("lessons.json");
  const userConfig   = readJson("user-config.json") || {};
  const lessonsSection = buildLessonsSection(lessonsState, userConfig);

  const drawdownSection = buildDrawdownSection(tradeArr);

  const signalEntries = readJsonl("signal-results.jsonl");
  const orionSection  = buildOrionRejectionsSection(signalEntries);

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

  const sections = [
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
  ];

  // Graceful degradation: only append new sections when their generators produced output.
  if (lessonsSection)  { sections.push(sep, lessonsSection); }
  if (drawdownSection) { sections.push(sep, drawdownSection); }
  if (orionSection)    { sections.push(sep, orionSection); }

  const fullMsg = sections.join("\n");

  // Hard cap — Telegram message limit is ~4096; we aim well below.
  const safeMsg = fullMsg.length > 4000 ? fullMsg.slice(0, 3990) + "\n…(truncated)" : fullMsg;

  const ok = await sendTelegram(TOKEN, CHAT_ID, safeMsg);
  console.log(ok ? "✅ Report terkirim" : "❌ Gagal kirim");
}
