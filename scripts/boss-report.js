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

// PIECE 2 — meaningful-profit reporting bar (Lyra tiers). The win-rate counts a
// trade a "win" ONLY when its TRUE realized SOL delta clears NOISE. ~$0.75 = 0.005 SOL.
const DEFAULT_MIN_MEANINGFUL_PROFIT_SOL = 0.005;
const PROFIT_TIER_MARGINAL_SOL = 0.005; // >= this = MARGINAL (also = the win bar)
const PROFIT_TIER_REAL_SOL     = 0.02;   // >= this = REAL
const PROFIT_TIER_MEANINGFUL_SOL = 0.05; // >= this = MEANINGFUL

/**
 * The TRUE realized SOL delta for a closed record — net of IL + close-swap
 * slippage + gas (realized-sol.js). This is the HONEST economic outcome, NOT
 * the price-only LP-PnL. Returns null when the record predates realized-SOL
 * accounting or the figure couldn't be computed (caller then falls back).
 * @param {object} r - a lessons.performance record
 * @returns {number|null}
 */
export function realizedSolOf(r) {
  if (!r || typeof r !== "object") return null;
  const v = r.realized_sol_delta;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * Classify a closed trade by its realized SOL delta into Lyra's honesty tiers.
 * Answers Bro's "$0.001 dianggap profit" — a $0.001-class net is NOISE, not a win.
 *   LOSS      : realized < 0
 *   NOISE     : 0 <= realized < 0.005  (gas + IL ate it — NOT a win)
 *   MARGINAL  : 0.005 <= realized < 0.02
 *   REAL      : 0.02 <= realized < 0.05
 *   MEANINGFUL: realized >= 0.05
 * Returns "UNKNOWN" when no realized figure exists (record predates accounting).
 * @param {number|null} realizedSol
 * @returns {"LOSS"|"NOISE"|"MARGINAL"|"REAL"|"MEANINGFUL"|"UNKNOWN"}
 */
export function profitTier(realizedSol) {
  // null/undefined/"" all coerce to a finite Number via Number(), so guard them
  // explicitly — a record with no realized figure is UNKNOWN, never NOISE/0.
  if (realizedSol == null || realizedSol === "") return "UNKNOWN";
  if (!Number.isFinite(Number(realizedSol))) return "UNKNOWN";
  const v = Number(realizedSol);
  if (v < 0) return "LOSS";
  if (v < PROFIT_TIER_MARGINAL_SOL) return "NOISE";
  if (v < PROFIT_TIER_REAL_SOL) return "MARGINAL";
  if (v < PROFIT_TIER_MEANINGFUL_SOL) return "REAL";
  return "MEANINGFUL";
}

/**
 * HONEST win classifier (PIECE 2). A trade counts as a WIN only when its TRUE
 * realized SOL delta clears the meaningful-profit bar. Micro-profits (NOISE)
 * are explicitly NOT wins. When the record has no realized figure we FALL BACK
 * to the legacy LP-PnL sign (so older records still classify) but flag it.
 * @param {object} r        - lessons.performance record
 * @param {number} minWinSol - meaningful-profit bar in SOL (config.minMeaningfulProfitSol)
 * @returns {{ win: boolean, basis: "realized"|"lp_fallback", tier: string, realizedSol: number|null }}
 */
export function classifyTrade(r, minWinSol = DEFAULT_MIN_MEANINGFUL_PROFIT_SOL) {
  const realizedSol = realizedSolOf(r);
  if (realizedSol != null) {
    return {
      win: realizedSol >= minWinSol,
      basis: "realized",
      tier: profitTier(realizedSol),
      realizedSol,
    };
  }
  // Legacy fallback — no realized SOL on this record. Use LP-PnL sign so the
  // record still classifies, but mark the basis so callers can disclose it.
  const lp = Number(r?.pnl_usd ?? r?.pnl_pct ?? 0);
  return { win: lp > 0, basis: "lp_fallback", tier: "UNKNOWN", realizedSol: null };
}

/**
 * Escape HTML entities for Telegram `parse_mode: "HTML"` (BUG fix 2026-07-11,
 * Draco found). The boss-report is sent with parse_mode HTML; any raw `<`, `>`,
 * or `&` in INTERPOLATED external text (LLM reject reasons, token names, etc.)
 * makes Telegram 400 with "can't parse entities" — e.g. a reason like
 * "mcap &lt; $200k" or "rug &amp; bot" silently drops the WHOLE report. Apply to
 * every externally-sourced string interpolated into an HTML section; NEVER to the
 * intentional <b>/<i>/<code> tags we author. Escapes & FIRST (order matters).
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

/**
 * Classify a signal file (inbox/processed/rejected) by its ORIGIN source.
 * Files are named "<ts>-[<ts>-]<sourceLabel>.txt": signal-runner's moveFile
 * prepends one timestamp, the inbox writer (auto-screener saveToInbox OR the
 * discord-listener) prepends another → up to two leading "<digits>-" groups.
 *   - auto-screener      → "screener-<SYMBOL>"       → "screener"
 *   - manual/test drops  → "hanta…" / "test…"        → "manual"
 *   - discord listener   → "<channel>-<symbol>"      → "discord"
 * IMPORTANT: the LIVE, productive Discord path (MeteoraIDN ranked-digest) is
 * merged into native discovery and therefore emits "screener-" files — it is
 * counted under `screener`. `discord` here means ONLY the standalone
 * discord-listener file-inbox path (channel-named files).
 * Pure + exported for tests.
 */
export function classifySignalSource(filename) {
  let s = String(filename || "").replace(/\.(txt|md)$/i, "");
  s = s.replace(/^\d+-/, "").replace(/^\d+-/, ""); // strip up to 2 leading timestamps
  const head = s.toLowerCase();
  if (!head) return "other";
  if (head.startsWith("screener")) return "screener";
  if (/^(hanta|test|manual)/.test(head)) return "manual";
  return "discord";
}

// Count files in a signal dir, bucketed by classifySignalSource origin.
function countFilesBySource(dir) {
  const out = { screener: 0, discord: 0, manual: 0, other: 0, total: 0 };
  try {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return out;
    for (const f of fs.readdirSync(full)) {
      if (f.startsWith(".")) continue;
      const bucket = classifySignalSource(f);
      out[bucket] = (out[bucket] || 0) + 1;
      out.total++;
    }
  } catch { /* leave zeros */ }
  return out;
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

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Live SOL/USD price via a multi-source fallback chain. Returns null ONLY when
 * EVERY source fails — callers then render "USD unavailable" rather than a
 * wrong/stale/hardcoded number (never show a fabricated price).
 *
 * ROOT CAUSE (2026-06-03, Lyra): the old single source
 * `lite-api.jup.ag/price/v2` now returns HTTP 404 ("Route not found") — Jupiter
 * retired the v2 price route. The fetch fell through to null → "tidak tersedia".
 * Jupiter price is now v3 and the response shape changed: the per-mint object
 * carries `usdPrice` (v3) instead of `data[mint].price` (v2).
 *
 * Sources tried in order (first finite >0 wins):
 *   1. Jupiter price v3  (lite-api.jup.ag/price/v3)  field: usdPrice
 *   2. Jupiter price v3  (api.jup.ag/price/v3)        field: usdPrice  (mirror)
 *   3. CoinGecko simple price                          field: solana.usd
 */
async function getSolUsdPrice() {
  const sources = [
    {
      name: "jup-v3-lite",
      url: `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
      pick: (d) => Number(d?.[SOL_MINT]?.usdPrice),
    },
    {
      name: "jup-v3-api",
      url: `https://api.jup.ag/price/v3?ids=${SOL_MINT}`,
      pick: (d) => Number(d?.[SOL_MINT]?.usdPrice),
    },
    {
      name: "coingecko",
      url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      pick: (d) => Number(d?.solana?.usd),
    },
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const d = await res.json();
      const px = src.pick(d);
      if (Number.isFinite(px) && px > 0) return px;
    } catch { /* try next source */ }
  }
  return null; // every source failed — caller renders "tidak tersedia"
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
 * Trading performance section. (BUG 2 fix + PIECE 2 honest win-rate.)
 *
 * Headline win-rate now comes from LIVE closes only (lessons.performance
 * where source !== "paper"), windowed to recent activity — NOT the frozen
 * paper-trades.json blind-scanner batch (47 trades from May 2026 that
 * polluted the old all-time number into 14W/33L, -8.3%).
 *
 * PIECE 2 — HONEST win-rate. A trade counts a WIN only when its TRUE realized
 * SOL delta (net of IL + slippage + gas, NOT LP-only PnL) clears the
 * meaningful-profit bar (config.minMeaningfulProfitSol, default 0.005 SOL ~ $0.75).
 * Micro-profits below that are NOISE — gas + IL ate them — and are shown as
 * breakeven, NOT a win. This answers "$0.001 dianggap profit". A tier breakdown
 * (NOISE/MARGINAL/REAL/MEANINGFUL) is surfaced so the distribution stays honest.
 *
 * Paper sim results are shown separately and clearly labelled as practice,
 * so losses are never hidden — just attributed honestly.
 *
 * @param {Array} liveRecords - lessons.performance entries (live + paper mixed)
 * @param {Array} paperTrades - paper-trades.json rows (closed sim trades)
 * @param {number} openCount  - currently open positions
 * @param {number} windowDays - recency window for the live headline (default 30)
 * @param {number} minWinSol  - meaningful-profit bar in SOL (default 0.005)
 */
export function buildTradeSection(liveRecords, paperTrades, openCount = 0, windowDays = 30, minWinSol = DEFAULT_MIN_MEANINGFUL_PROFIT_SOL) {
  const recs = Array.isArray(liveRecords) ? liveRecords : [];
  const cutoff = Date.now() - windowDays * 86_400_000;
  const live = recs.filter(r => r && r.source !== "paper");
  const liveRecent = live.filter(r => {
    const ts = Date.parse(r.recorded_at || r.closed_at || "");
    return Number.isFinite(ts) && ts >= cutoff;
  });

  // HONEST classification — realized-SOL-based win bar (PIECE 2).
  const classed = liveRecent.map(r => classifyTrade(r, minWinSol));
  const liveWins = classed.filter(c => c.win).length;
  const liveWinRate = liveRecent.length ? Math.round((liveWins / liveRecent.length) * 100) : null;
  const liveAvgPct = liveRecent.length
    ? (liveRecent.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / liveRecent.length)
    : null;
  // Net realized SOL across the window — the number Bro actually banks.
  const realizedRecs = classed.filter(c => c.realizedSol != null);
  const netRealizedSol = realizedRecs.reduce((s, c) => s + c.realizedSol, 0);
  // Tier distribution (only counts records that HAVE a realized figure).
  const tierCounts = { LOSS: 0, NOISE: 0, MARGINAL: 0, REAL: 0, MEANINGFUL: 0 };
  for (const c of realizedRecs) { if (tierCounts[c.tier] != null) tierCounts[c.tier]++; }
  const noiseCount = classed.filter(c => c.tier === "NOISE").length;

  const lines = [`📊 Hasil Trading (real money)`];
  if (openCount > 0) lines.push(`▶️ Posisi aktif sekarang: <b>${openCount}</b>`);

  if (liveRecent.length > 0) {
    const liveLosses = liveRecent.length - liveWins;
    lines.push(`✅ Menang: ${liveWins}  ❌ Kalah/impas: ${liveLosses}  (dari ${liveRecent.length} posisi ${windowDays} hari terakhir)`);
    lines.push(`🎯 Tingkat kemenangan: <b>${liveWinRate}%</b> <i>(menang = profit nyata ≥ ${minWinSol} SOL bersih)</i>`);
    if (noiseCount > 0) {
      lines.push(`<i>⚠️ ${noiseCount} trade untung tipis &lt; ${minWinSol} SOL — dihitung impas (gas+IL makan), bukan menang.</i>`);
    }
    if (realizedRecs.length > 0) {
      lines.push(`💰 Profit bersih (real, sudah dikurangi IL+slippage+gas): <b>${netRealizedSol >= 0 ? "+" : ""}${netRealizedSol.toFixed(4)} SOL</b>`);
      lines.push(`<i>Sebaran: MEANINGFUL ${tierCounts.MEANINGFUL} · REAL ${tierCounts.REAL} · MARGINAL ${tierCounts.MARGINAL} · NOISE ${tierCounts.NOISE} · RUGI ${tierCounts.LOSS}</i>`);
    }
    if (liveAvgPct != null) {
      const verb = liveAvgPct >= 0 ? "untung" : "rugi";
      lines.push(`📈 Rata-rata LP-PnL per posisi: <b>${liveAvgPct >= 0 ? "+" : ""}${liveAvgPct.toFixed(1)}%</b> (${verb}) <i>(harga saja, bukan SOL bersih)</i>`);
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
    lines.push(`<i>— Latihan simulasi (bukan real money): ${pw} menang / ${paper.length - pw} kalah, data lama mode uji coba —</i>`);
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
  // Positions closed/evaluated since the last automatic threshold change.
  // Bot re-evaluates every cycle; the date only moves when win/loss data
  // justifies shifting a standard — a stale date ≠ a dead engine.
  const posAtEvolution = Number.isFinite(userConfig._positionsAtEvolution) ? userConfig._positionsAtEvolution : null;
  const evaluatedSince = (posAtEvolution !== null) ? Math.max(0, perf.length - posAtEvolution) : null;

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
    const dateStr = lastEvolved.slice(0, 16).replace("T", " ");
    if (evaluatedSince !== null && evaluatedSince > 0) {
      // Make explicit: date = last AUTO threshold change, not last activity.
      // Engine keeps evaluating; it just hasn't seen data significant enough to move a standard.
      lines.push(`<i>Standar terakhir berubah otomatis: ${dateStr} · ${evaluatedSince} posisi dievaluasi sejak itu (data belum cukup beda buat geser standar — ini normal, bukan berhenti).</i>`);
    } else {
      lines.push(`<i>Standar terakhir berubah otomatis: ${dateStr} (bot tetap evaluasi tiap posisi ditutup; standar baru bergeser kalau data win/loss cukup beda).</i>`);
    }
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
    // reason is raw LLM/free text — MUST be HTML-escaped or a literal <, >, &
    // (e.g. "mcap < $200k") 400s the whole report under parse_mode HTML.
    lines.push(`• <b>${count}×</b> ${escapeHtml(reason)}`);
  }
  return lines.join("\n");
}

/**
 * Signal pipeline summary — CUMULATIVE file counts since inception.
 *
 * FIX (Sirius 2026-07-11): the old section was titled "📡 Sinyal Discord" and
 * rendered `countFiles("signals/rejected")` as if it were the Discord reject
 * count, while NEVER counting signals/processed. Two lies stacked:
 *   1. rejected/processed files are ~94% auto-screener; only a tiny, long-dead
 *      tail is the discord-listener path — so labelling the whole pile "Discord"
 *      was wrong (investigated: 371/394 rejected = screener; discord file-inbox
 *      last produced 2026-05-16).
 *   2. the missing processed count made a HEALTHY pipeline (684 passed) read as
 *      "0 passed".
 * This version shows PASSED (processed) + REJECTED + WAITING with an honest
 * per-source split, and stops claiming the numbers are Discord.
 *
 * @param {{screener:number,discord:number,manual:number,other:number,total:number}} processed
 * @param {object} rejected  same shape
 * @param {object} inbox     same shape
 */
export function buildSignalSection(processed, rejected, inbox) {
  const p = processed || {}, r = rejected || {}, i = inbox || {};
  const pT = p.total || 0, rT = r.total || 0, iT = i.total || 0;
  const split = (o) =>
    `screening ${o.screener || 0} · Discord ${o.discord || 0} · manual ${(o.manual || 0) + (o.other || 0)}`;
  const lines = [
    `📡 Sinyal (screening + Discord) — total sejak awal`,
    `✅ Lolos filter: <b>${pT}</b>`,
    `❌ Ditolak filter: <b>${rT}</b>`,
    iT > 0 ? `⏳ Menunggu diproses: <b>${iT}</b>` : `⏳ Menunggu: <b>0</b>`,
  ];
  if (pT > 0) lines.push(`<i>Lolos per sumber: ${split(p)}</i>`);
  if (rT > 0) lines.push(`<i>Ditolak per sumber: ${split(r)}</i>`);
  lines.push(`<i>Discord masuk lewat merge screening (ranked-digest), bukan pile terpisah.</i>`);
  return lines.join("\n");
}

/**
 * Map a raw judge/reject reason string into a plain-Indonesian bucket an
 * investor understands — NO raw jargon (organic→"organik", fee/TVL→"fee",
 * mcap→"ukuran pool", volatility→"pergerakan harga"). Keyword-driven so it
 * degrades safely on novel reason text (unknown → "alasan lain").
 * @param {string} reason
 * @returns {string} plain Indonesian bucket label
 */
export function plainRejectBucket(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r.trim()) return "Alasan lain";
  // Order matters — most specific keywords first.
  if (/organic|organik/.test(r))                       return "Aktivitas organik rendah";
  if (/volatil|pergerakan/.test(r))                    return "Pergerakan harga kurang (pool sepi)";
  if (/\bbot|bundler|bundle/.test(r))                  return "Banyak bot/bundler";
  if (/top.?10|top.?holder|concentrat|holder/.test(r)) return "Kepemilikan terlalu terpusat";
  if (/mcap|market.?cap|ukuran/.test(r))               return "Ukuran pool (market cap) di luar target";
  if (/fee.?tvl|fee\/tvl|fee active|fee_tvl|\bfee\b/.test(r)) return "Fee terlalu kecil dibanding likuiditas";
  if (/\btvl\b|liquidit|likuid/.test(r))               return "Likuiditas (TVL) tipis";
  if (/volume|sepi/.test(r))                           return "Volume perdagangan sepi";
  if (/age|umur|too new|too old/.test(r))              return "Umur token di luar rentang aman";
  if (/rug|mint|freeze|renounce/.test(r))              return "Gagal cek keamanan token (rug/mint/freeze)";
  if (/sol.?quote|non.?sol|undeployable/.test(r))      return "Pool tidak pakai SOL (tak bisa dipasang)";
  if (/launchpad/.test(r))                             return "Launchpad diblokir";
  if (/confidence|low conf|not worth|did not qualify|no enter/.test(r)) return "Skor kelayakan kurang menurut penilai";
  return "Alasan lain";
}

/**
 * Detect whether a no_deploy decision was a SAFETY/transient BLOCK (deploy was
 * attempted but refused by a safety check / rate-limit / on-chain error) vs a
 * JUDGE decision (pool simply not good enough). This is the line Bro asked for:
 * "gagal deploy" (blocked mid-deploy) vs "ga di-deploy" (judge said no).
 * @param {object} d - a decision-log entry (type === "no_deploy")
 * @returns {boolean} true when it's a deploy-attempt failure, not a judge skip
 */
export function isDeployFailure(d) {
  const txt = `${d?.summary || ""} ${d?.reason || ""}`.toLowerCase();
  if (/deploy attempt did not succeed/.test(txt)) return true;
  if (/429|rate.?limit|rate limit|snapshot_verify|snapshot verify|timeout|timed out|on-chain|onchain|tx failed|transaction failed|blocked by safety|safety check|insufficient/.test(txt)) return true;
  return false;
}

/**
 * Translate a deploy-failure reason into a plain, short Indonesian phrase.
 * @param {object} d
 * @returns {string}
 */
function plainDeployFailReason(d) {
  const txt = `${d?.summary || ""} ${d?.reason || ""}`.toLowerCase();
  if (/429|rate.?limit|rate limit/.test(txt))             return "API kena rate-limit (429, sementara)";
  if (/snapshot_verify|snapshot verify/.test(txt))        return "Verifikasi harga pool gagal (data berubah)";
  if (/timeout|timed out/.test(txt))                      return "Koneksi timeout (sementara)";
  if (/insufficient|balance/.test(txt))                   return "Saldo SOL kurang untuk deploy";
  if (/on-chain|onchain|tx failed|transaction failed/.test(txt)) return "Transaksi on-chain gagal";
  return "Ke-block saat mau deploy (cek log teknis)";
}

/**
 * Ringkasan Screening Harian — the daily executive screening summary Bro asked
 * for: how many screening cycles ran today, how many candidates reached the
 * judge, deploy outcomes split into THREE clear categories, and the most-common
 * plain-language reasons pools were rejected.
 *
 * THREE CATEGORIES (verbatim Bro intent):
 *   1. Deploy berhasil   — position actually opened.
 *   2. Gagal deploy      — deploy WAS attempted but blocked (safety/429/error).
 *   3. Ga di-deploy      — judge decided WATCH/SKIP (pool not good enough).
 *   + Ga ada kandidat    — nothing survived filters far enough to be judged.
 *
 * DATA SOURCES (all local files, NO LLM cost):
 *   - verdictRows  : logs/verdicts-YYYY-MM-DD.jsonl (per-candidate judge verdicts
 *                    + reasons + cycle timestamps). Authoritative for cycle count,
 *                    candidates-judged, and reject reasons.
 *   - decisions    : decision-log.json entries (deploy success / no_deploy reason).
 *
 * ANTI-FABRICATION: when verdictRows is empty for today we DO NOT invent cycle
 * counts — we say "data screening mulai terkumpul hari ini" and show only what
 * the decision-log proves. Never fabricate aggregate numbers.
 *
 * @param {Array}  verdictRows - parsed rows from today's verdicts-*.jsonl
 * @param {Array}  decisions   - decision-log.json entries (will be filtered to today)
 * @param {string} dateStr     - YYYY-MM-DD for "today" (defaults to system today)
 * @returns {string} HTML section
 */
export function buildScreeningSummarySection(verdictRows, decisions, dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  const rows = Array.isArray(verdictRows)
    ? verdictRows.filter(r => typeof r?.ts === "string" && r.ts.startsWith(today))
    : [];
  const decs = Array.isArray(decisions)
    ? decisions.filter(d => typeof d?.ts === "string" && d.ts.startsWith(today))
    : [];

  // Friendly date label (e.g. "14 Jun").
  let dateLabel = today;
  try {
    dateLabel = new Date(`${today}T12:00:00Z`).toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
    });
  } catch { /* keep ISO */ }

  const header = `📊 <b>Ringkasan Screening Harian</b> (${dateLabel})`;

  // ── Empty-data honesty ───────────────────────────────────────────
  // If there is NOTHING from either source today, be honest rather than
  // print a wall of zeros that looks like a broken report.
  if (rows.length === 0 && decs.length === 0) {
    return [
      header,
      `<i>Data screening mulai terkumpul hari ini — belum ada siklus tercatat.</i>`,
    ].join("\n");
  }

  // ── Cycle count — cluster verdict rows by timestamp proximity ────
  // One screening cycle judges its candidates within a few seconds, so rows
  // whose timestamps are within 90s of the previous one belong to the SAME
  // cycle. This gives an HONEST cycle count without a separate cycle marker.
  const CYCLE_GAP_MS = 90_000;
  const sortedTs = rows.map(r => Date.parse(r.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  let cycleCount = 0;
  let lastTs = -Infinity;
  for (const ts of sortedTs) {
    if (ts - lastTs > CYCLE_GAP_MS) cycleCount++;
    lastTs = ts;
  }
  // Cycle count from verdict-log only reflects cycles that REACHED the judge.
  // Cycles that produced no candidate never write a verdict row — so we count
  // those separately from the decision-log "no candidate" entries.
  const noCandidateDecs = decs.filter(d =>
    d.type === "no_deploy" &&
    /no candidate|all filtered|all candidates filtered|single candidate/i.test(`${d.summary || ""} ${d.reason || ""}`)
  );

  // ── Candidates judged + verdict split (verdict-log) ──────────────
  const judged = rows.length;
  const enterCount = rows.filter(r => r.verdict === "enter").length;
  const skipCount  = rows.filter(r => r.verdict === "skip").length;
  const watchCount = rows.filter(r => r.verdict === "watch").length;

  // ── Deploy outcomes (decision-log) — THE 3 CATEGORIES ────────────
  const deploySuccess = decs.filter(d => d.type === "deploy").length;
  const noDeployDecs  = decs.filter(d => d.type === "no_deploy");
  const deployFailDecs = noDeployDecs.filter(isDeployFailure);
  const judgeSkipDecs  = noDeployDecs.filter(d => !isDeployFailure(d) && !noCandidateDecs.includes(d));

  // ── Aggregate reject reasons (plain Indonesian, top 3) ───────────
  // Source: judge SKIP/WATCH reasons (the pool-quality verdict text). This is
  // the "kenapa pool ditolak" Bro wants — bucketed and translated.
  const rejBuckets = new Map();
  for (const r of rows) {
    if (r.verdict === "enter") continue; // enter = accepted, not a rejection
    const bucket = plainRejectBucket(r.reason);
    rejBuckets.set(bucket, (rejBuckets.get(bucket) || 0) + 1);
  }
  const totalRej = [...rejBuckets.values()].reduce((s, n) => s + n, 0);
  const topRej = [...rejBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // ── Compose ──────────────────────────────────────────────────────
  const lines = [header];

  // Cycle line — honest about what the count covers.
  if (cycleCount > 0) {
    lines.push(`Total screening: <b>${cycleCount}x</b>`);
  } else {
    lines.push(`Total screening: <i>belum tercatat lewat penilai hari ini</i>`);
  }

  if (judged > 0) {
    lines.push(`Lolos ke penilai (judge): <b>${judged}</b> kandidat`);
  } else {
    lines.push(`Lolos ke penilai (judge): <b>0</b> — belum ada pool yang lolos filter awal`);
  }

  lines.push(`Deploy berhasil: <b>${deploySuccess}</b>`);

  // Category 2 — Gagal deploy (attempted but blocked).
  if (deployFailDecs.length > 0) {
    // Surface the single most-common fail reason in plain language.
    const failReasons = new Map();
    for (const d of deployFailDecs) {
      const k = plainDeployFailReason(d);
      failReasons.set(k, (failReasons.get(k) || 0) + 1);
    }
    const topFail = [...failReasons.entries()].sort((a, b) => b[1] - a[1])[0];
    lines.push(`  ⛔ Gagal deploy: <b>${deployFailDecs.length}x</b> — ${topFail[0]}`);
  }

  // Category 3 — Ga di-deploy (judge said no / WATCH-SKIP).
  if (judgeSkipDecs.length > 0 || skipCount > 0 || watchCount > 0) {
    // Prefer the decision-log no_deploy count (1 per cycle) but if absent fall
    // back to per-candidate skip/watch from the verdict-log so we never under-report.
    const noDeployN = judgeSkipDecs.length > 0 ? judgeSkipDecs.length : (skipCount + watchCount);
    const unit = judgeSkipDecs.length > 0 ? "siklus" : "kandidat";
    lines.push(`  ⏸️ Ga di-deploy: <b>${noDeployN}x</b> (${unit}) — penilai menilai pool kurang bagus`);
  }

  // Category 4 — Ga ada kandidat lolos filter.
  if (noCandidateDecs.length > 0) {
    lines.push(`  🚫 Ga ada kandidat lolos filter: <b>${noCandidateDecs.length}x</b>`);
  }

  // Top reject reasons (plain language, with %).
  if (topRej.length > 0 && totalRej > 0) {
    lines.push(`Alasan paling sering pool ditolak:`);
    for (const [bucket, n] of topRej) {
      const pct = Math.round((n / totalRej) * 100);
      lines.push(`  • ${bucket} ${pct}%`);
    }
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
  // Bucketed by ORIGIN source AND now counting signals/processed (the old
  // section never did → healthy pipeline read "0 passed"). See buildSignalSection.
  const signalProcessed = countFilesBySource("signals/processed");
  const signalRejected  = countFilesBySource("signals/rejected");
  const signalInbox     = countFilesBySource("signals/inbox");

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

  // ─── Daily screening summary (Lyra) ─────────────────────────────
  // Sources: today's per-candidate judge verdicts (logs/verdicts-YYYY-MM-DD.jsonl)
  // + decision-log.json deploy/no_deploy outcomes. Both local files, NO LLM cost.
  const todayDate = new Date().toISOString().slice(0, 10);
  const verdictRows = readJsonl(`logs/verdicts-${todayDate}.jsonl`);
  const decisionData = readJson("decision-log.json");
  const decisionRows = Array.isArray(decisionData?.decisions) ? decisionData.decisions : [];
  const screeningSummary = buildScreeningSummarySection(verdictRows, decisionRows, todayDate);

  // ─── timestamp ──────────────────────────────────────────────────
  const nowStr = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit"
  });

  // ─── build message ──────────────────────────────────────────────
  const modeEmoji = DRY_RUN ? "🔵" : "🟢";
  const modeText  = DRY_RUN ? "Simulasi (aman, belum pakai real money)" : "LIVE — real money";

  const balSection = buildBalanceSection(solBalance, solUsd, burnerPubkey);

  const livePerf = Array.isArray(lessonsState?.performance) ? lessonsState.performance : [];
  // PIECE 2 — honest win bar from config (reloadable). Falls back to the default
  // when user-config.json doesn't set it.
  const minWinSol = Number.isFinite(Number(userConfig.minMeaningfulProfitSol))
    ? Number(userConfig.minMeaningfulProfitSol)
    : DEFAULT_MIN_MEANINGFUL_PROFIT_SOL;
  const tradeSection = buildTradeSection(livePerf, tradeArr, openLiveCount, 30, minWinSol);

  const signalSection = buildSignalSection(signalProcessed, signalRejected, signalInbox);

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
    screeningSummary,
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
