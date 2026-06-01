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

/**
 * Live SOL/USD price. Returns null on any failure — callers must render
 * "USD unavailable" rather than a wrong number (never show a stale/hardcoded
 * price). Uses Jupiter price API; falls back to null silently.
 */
async function getSolUsdPrice() {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`);
    if (!res.ok) return null;
    const d = await res.json();
    const px = Number(d?.data?.[SOL_MINT]?.price);
    return Number.isFinite(px) && px > 0 ? px : null;
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
 * Wallet balance section. USD only shown when a live price is supplied;
 * a null/invalid price renders "(nilai USD tidak tersedia)" instead of a
 * wrong hardcoded number. (BUG 1 fix — was hardcoded $135/SOL.)
 * @param {number|null} solBalance
 * @param {number|null} solUsd - live SOL/USD price, or null if unavailable
 * @param {string|null} pubkey
 */
export function buildBalanceSection(solBalance, solUsd, pubkey) {
  if (solBalance == null) return `💳 Saldo wallet\n<i>tidak terbaca</i>`;
  const addr = pubkey ? `\n<i>${pubkey.slice(0, 8)}...${pubkey.slice(-4)}</i>` : "";
  const usd = Number.isFinite(solUsd) && solUsd > 0
    ? ` (~$${(solBalance * solUsd).toFixed(2)} · SOL @ $${solUsd.toFixed(0)})`
    : ` <i>(nilai USD tidak tersedia)</i>`;
  return `💳 Saldo wallet\n<code>${solBalance.toFixed(4)} SOL</code>${usd}${addr}`;
}

/**
 * Trading performance section. (BUG 2 fix.)
 *
 * Headline win-rate now comes from LIVE closes only (lessons.performance
 * where source !== "paper"), windowed to recent activity — NOT the frozen
 * paper-trades.json blind-scanner batch (47 trades from May 2026 that
 * polluted the old all-time number into 14W/33L, -8.3%).
 *
 * Paper sim results are shown separately and clearly labelled as practice,
 * so losses are never hidden — just attributed honestly.
 *
 * @param {Array} liveRecords - lessons.performance entries (live + paper mixed)
 * @param {Array} paperTrades - paper-trades.json rows (closed sim trades)
 * @param {number} openCount  - currently open positions
 * @param {number} windowDays - recency window for the live headline (default 30)
 */
export function buildTradeSection(liveRecords, paperTrades, openCount = 0, windowDays = 30) {
  const recs = Array.isArray(liveRecords) ? liveRecords : [];
  const cutoff = Date.now() - windowDays * 86_400_000;
  const live = recs.filter(r => r && r.source !== "paper");
  const liveRecent = live.filter(r => {
    const ts = Date.parse(r.recorded_at || r.closed_at || "");
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const liveWins = liveRecent.filter(r => (r.pnl_usd ?? r.pnl_pct ?? 0) > 0).length;
  const liveWinRate = liveRecent.length ? Math.round((liveWins / liveRecent.length) * 100) : null;
  const liveAvgPct = liveRecent.length
    ? (liveRecent.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / liveRecent.length)
    : null;

  const lines = [`📊 Hasil Trading (uang sungguhan)`];
  if (openCount > 0) lines.push(`▶️ Posisi aktif sekarang: <b>${openCount}</b>`);

  if (liveRecent.length > 0) {
    const liveLosses = liveRecent.length - liveWins;
    lines.push(`✅ Menang: ${liveWins}  ❌ Kalah: ${liveLosses}  (dari ${liveRecent.length} posisi ${windowDays} hari terakhir)`);
    lines.push(`🎯 Tingkat kemenangan: <b>${liveWinRate}%</b>`);
    if (liveAvgPct != null) {
      const verb = liveAvgPct >= 0 ? "untung" : "rugi";
      lines.push(`📈 Rata-rata per posisi: <b>${liveAvgPct >= 0 ? "+" : ""}${liveAvgPct.toFixed(1)}%</b> (${verb})`);
    }
  } else {
    lines.push(`Belum ada posisi sungguhan yang ditutup dalam ${windowDays} hari terakhir.`);
  }

  // Paper sim — shown separately, labelled as practice (never hidden, never
  // mixed into the headline). Only render if there are sim trades.
  const paper = Array.isArray(paperTrades) ? paperTrades.filter(t => t.closed_at) : [];
  if (paper.length > 0) {
    const pnl = t => (t.final_fee_inclusive_pnl_pct ?? t.fee_inclusive_pnl_pct ?? t.final_pnl_pct ?? t.pnl_pct ?? 0);
    const pw = paper.filter(t => pnl(t) > 0).length;
    lines.push(`<i>— Latihan simulasi (bukan uang asli): ${pw} menang / ${paper.length - pw} kalah, data lama mode uji coba —</i>`);
  }
  return lines.join("\n");
}

/**
 * Convert one raw lesson record into a plain-Indonesian insight sentence an
 * investor understands — no bin_step / volatility / fee_tvl_ratio jargon.
 * Reads structured fields (outcome, pnl_pct, context) so it degrades safely
 * when the rule text shape changes.
 * @param {Object} lesson
 * @returns {string|null}
 */
export function lessonToPlain(lesson) {
  if (!lesson || !lesson.rule) return null;
  const rule = String(lesson.rule);

  // Auto-evolved threshold lessons → describe the self-tuning behaviour plainly.
  if (/AUTO-EVOLVED/i.test(rule)) {
    return "Bot menyesuaikan sendiri standar pemilihan pool agar lebih ketat, berdasarkan hasil posisi sebelumnya.";
  }

  // Pull numbers from the structured context string (more reliable than the rule prose).
  const ctx = String(lesson.context || rule);
  const num = (re) => { const m = ctx.match(re); return m ? parseFloat(m[1]) : null; };
  const vol     = num(/volatility=([\d.]+)/);
  const feeTvl  = num(/fee_tvl_ratio=([\d.]+)/);
  const pnlPct  = Number.isFinite(lesson.pnl_pct) ? lesson.pnl_pct : num(/PnL\s*([+\-]?[\d.]+)%/);

  const volWord = vol == null ? null : (vol < 2 ? "tenang" : vol < 4 ? "sedang" : "tinggi");
  const feeWord = feeTvl == null ? null : (feeTvl < 0.1 ? "rendah (di bawah 0.1)" : feeTvl < 0.2 ? "sedang" : "bagus");

  const good = lesson.outcome === "good" || /^PREFER|^WORKED/i.test(rule);
  const bad  = lesson.outcome === "poor" || lesson.outcome === "bad" || /^FAILED/i.test(rule);

  const traits = [];
  if (feeWord) traits.push(`fee ${feeWord}`);
  if (volWord) traits.push(`pergerakan harga ${volWord}`);
  const traitStr = traits.length ? `pool dengan ${traits.join(" + ")}` : "pola pool tertentu";
  const pnlStr = pnlPct != null ? ` (hasil ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : "";

  if (good) return `${cap(traitStr)} cenderung menguntungkan${pnlStr} — bot memprioritaskan pola ini.`;
  if (bad)  return `${cap(traitStr)} cenderung merugi${pnlStr} — bot sekarang menghindari pola ini.`;
  return `${cap(traitStr)}${pnlStr}.`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
  const liveCount  = perf.filter(p => p.source !== "paper").length;

  const minOrganic    = userConfig.minOrganic ?? DEFAULT_MIN_ORGANIC;
  const minFeeRatio   = userConfig.minFeeActiveTvlRatio ?? DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO;
  const lastEvolved   = userConfig._lastEvolved || null;
  const tightened     = (minOrganic !== DEFAULT_MIN_ORGANIC) || (minFeeRatio !== DEFAULT_MIN_FEE_ACTIVE_TVL_RATIO);

  // Top 3 lessons by confidence desc, tie-break recency. Skip auto-evolved
  // bookkeeping entries here — those are summarised in one line below.
  const ranked = [...lessons]
    .filter(l => l && l.rule && !/AUTO-EVOLVED/i.test(String(l.rule)))
    .sort((a, b) => {
      const ca = a.confidence ?? 0;
      const cb = b.confidence ?? 0;
      if (cb !== ca) return cb - ca;
      return (b.created_at || "").localeCompare(a.created_at || "");
    })
    .slice(0, 3);

  const lines = [
    `🧠 <b>Apa yang Dipelajari Bot</b>`,
    `Bot belajar dari <b>${liveCount}</b> posisi sungguhan yang sudah ditutup.`,
  ];
  if (tightened) {
    lines.push(`Bot sudah memperketat standar pemilihan pool sendiri agar lebih selektif.`);
  }
  if (lastEvolved) {
    lines.push(`<i>Penyesuaian terakhir: ${lastEvolved.slice(0, 16).replace("T", " ")}</i>`);
  }
  if (ranked.length > 0) {
    lines.push(`Pelajaran utama:`);
    for (const l of ranked) {
      const plain = lessonToPlain(l);
      if (plain) lines.push(`• ${plain}`);
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

  // Live SOL/USD — null means "couldn't fetch", render USD as unavailable.
  const solUsd = await getSolUsdPrice();

  // ─── paper trades (simulation only — kept for the labelled practice line) ──
  const tradesRaw = readJson("paper-trades.json");
  const tradeArr = Array.isArray(tradesRaw?.trades) ? tradesRaw.trades : (Array.isArray(tradesRaw) ? tradesRaw : []);

  // ─── live open positions (real money) from state.json ───────────────────
  const stateData = readJson("state.json") || {};
  const openLiveCount = Object.values(stateData.positions || {}).filter(p => p && !p.closed).length;

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

  const balSection = buildBalanceSection(solBalance, solUsd, burnerPubkey);

  const livePerf = Array.isArray(lessonsState?.performance) ? lessonsState.performance : [];
  const tradeSection = buildTradeSection(livePerf, tradeArr, openLiveCount, 30);

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
