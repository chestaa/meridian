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
 * STRICT numeric coercion (anti-pattern #2). Number(null)===0 is finite, so a
 * naive Number()+isFinite would FABRICATE 0 for null/''/[]/false — turning
 * "value unknown" into a fake 0. Only a real finite number (or non-empty numeric
 * string) survives; everything else → null. Mirrors the money-guard's coercion
 * in account-circuit-breaker.js so the display and the CB baseline agree.
 * @param {*} v
 * @returns {number|null}
 */
function strictNumeric(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Sum SOL PRINCIPAL committed to currently-open positions, read from an already-
 * parsed state.json object (SYNC, NO RPC, NO mark-to-market → zero valuation-
 * failure surface). Mirrors account-circuit-breaker.js's readOpenPositionsCapitalSol
 * so the boss-report "di posisi" figure and the CB baseline seed use the SAME
 * recorded principal.
 *
 * Committed principal = two_sided_live.notional_sol (two-sided total exposure) or
 * amount_sol (single-side). A null/stranded two-sided notional falls back to
 * amount_sol (undercount, errs conservative). strictNumeric avoids the
 * Number(null)===0 fabrication trap.
 *
 * RETURN CONTRACT (drives the display fail-safe):
 *   - null → state UNREADABLE (parsed object null/not-an-object). Caller must NOT
 *            fabricate a total; show liquid + honest note.
 *   - 0    → state readable, no open positions (or none with principal) → genuinely
 *            flat → clean render.
 *   - >0   → committed capital to decompose.
 *
 * @param {object|null} stateData - parsed state.json (or null on read failure)
 * @returns {number|null}
 */
export function sumOpenPositionsCapital(stateData) {
  if (!stateData || typeof stateData !== "object") return null; // unreadable
  const positions = stateData.positions && typeof stateData.positions === "object"
    ? Object.values(stateData.positions)
    : []; // readable state, no positions map → flat (0), not unreadable
  let sum = 0;
  for (const p of positions) {
    if (!p || p.closed || p.closed_at) continue; // OPEN only
    const twoSided = p.two_sided === true && p.two_sided_live
      ? strictNumeric(p.two_sided_live.notional_sol)
      : null;
    const single = strictNumeric(p.amount_sol);
    const capital = twoSided != null ? twoSided : (single != null ? single : 0);
    if (capital > 0) sum += capital;
  }
  return parseFloat(sum.toFixed(9));
}

// USD annotation for a SOL figure. Live price null/invalid → "tidak tersedia"
// (never a wrong hardcoded number — BUG 1 fix, was hardcoded $135/SOL).
function usdAnnotation(sol, solUsd) {
  return Number.isFinite(solUsd) && solUsd > 0
    ? ` (~$${(sol * solUsd).toFixed(2)} · SOL @ $${solUsd.toFixed(0)})`
    : ` <i>(nilai USD tidak tersedia)</i>`;
}

/**
 * Wallet balance section — DECOMPOSED so a deployed-capital dip can't read as a
 * drain (phantom-drain display fix, 2026-07-15). The number Bro panics on is
 * this line: when capital is committed to open positions, LIQUID SOL dips
 * (recoverable capital, NOT loss) and a liquid-only "Saldo" reads as a scary drop
 * (0.69 → 0.43). We show TOTAL account value FIRST/prominent, with liquid +
 * deployed as the breakdown, so intact-but-working capital is obvious.
 *
 *   Total account value = liquid + deployed (recorded open-position principal).
 *   Rent is NOT added back (not tracked in state.json; estimating it risks
 *   over-adding — mirrors Vega's CB baseline decision). Deployed principal is the
 *   dominant recoverable term, so the phantom-drain read is fixed without it.
 *
 * Three render modes (driven by `deployedSol`, see sumOpenPositionsCapital):
 *   deployed >  0    → "Saldo: <total> total (likuid X + di posisi Y)"
 *   deployed == 0    → flat wallet → clean "Saldo: <liquid>" (no "di posisi 0" clutter)
 *   deployed == null → UNREADABLE → liquid + honest "(+ posisi terbuka, cek /positions)"
 *                      note. NEVER fabricate a total we can't back with data.
 *
 * @param {number|null} liquidSol   - liquid SOL balance (live RPC read)
 * @param {number|null} solUsd      - live SOL/USD price, or null if unavailable
 * @param {string|null} pubkey
 * @param {number|null} deployedSol - committed open-position principal (sumOpenPositionsCapital)
 */
export function buildBalanceSection(liquidSol, solUsd, pubkey, deployedSol = null) {
  const liquid = strictNumeric(liquidSol);
  if (liquid == null) return `💳 Saldo wallet\n<i>tidak terbaca</i>`;
  const addr = pubkey ? `\n<i>${pubkey.slice(0, 8)}...${pubkey.slice(-4)}</i>` : "";
  const deployed = strictNumeric(deployedSol);

  // Fail-safe: deployed capital unreadable (state.json parse failed) → show liquid
  // + an HONEST note. Never fabricate a total we cannot back with recorded data.
  if (deployed == null) {
    return `💳 Saldo: <code>${liquid.toFixed(4)} SOL</code> likuid${usdAnnotation(liquid, solUsd)}` +
      `\n<i>(+ ada posisi terbuka yang belum kebaca — cek /positions)</i>${addr}`;
  }

  // Flat wallet — nothing deployed → render clean (total == liquid), no confusing
  // "di posisi 0" breakdown.
  if (deployed <= 0) {
    return `💳 Saldo: <code>${liquid.toFixed(4)} SOL</code>${usdAnnotation(liquid, solUsd)}${addr}`;
  }

  // Capital deployed — DECOMPOSE. Total FIRST/prominent (USD on the total = what
  // Bro's capital is actually worth), liquid + deployed as the breakdown.
  const total = parseFloat((liquid + deployed).toFixed(9));
  return `💳 Saldo: <code>${total.toFixed(4)} SOL total</code>${usdAnnotation(total, solUsd)}` +
    `\n<i>(likuid ${liquid.toFixed(4)} + di posisi ${deployed.toFixed(4)})</i>${addr}`;
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

// ─── Plain-Indonesian dimension vocabulary (Lyra bucket-aggregate lessons) ────
// Bucket keys are self-describing strings produced by lessons.js
// (VOLATILITY_BUCKETS / FEE_TVL_BUCKETS / ENTRY_DIRECTION_BUCKETS /
// REGIME_BUCKETS / EXIT_CLASSES). Parsed locally so this report script stays
// import-free of the learning engine.
const DIM_WORDS = Object.freeze({
  "vol[0,2.5)":   "pergerakan harga tenang (di bawah 2.5)",
  "vol[2.5,3.5)": "pergerakan harga sedang (2.5–3.5)",
  "vol[3.5,4.5)": "pergerakan harga cukup tinggi (3.5–4.5)",
  "vol4.5+":      "pergerakan harga tinggi (4.5+)",
  "fee[0,0.1)":   "fee rendah (di bawah 0.1)",
  "fee[0.1,0.2)": "fee sedang (0.1–0.2)",
  "fee[0.2,0.4)": "fee bagus (0.2–0.4)",
  "fee0.4+":      "fee sangat tinggi (0.4+)",
  entry_down: "masuk saat harga token sedang turun",
  entry_flat: "masuk saat harga token datar",
  entry_up:   "masuk saat harga token naik",
  entry_pump: "masuk saat harga token sedang melonjak (pump)",
  regime_down: "pasar SOL sedang turun",
  regime_flat: "pasar SOL datar",
  regime_up:   "pasar SOL sedang naik",
  STOP_LOSS:      "ditutup kena batas rugi (stop-loss)",
  TRAILING_TP:    "ditutup untuk mengunci profit",
  OOR_UP_HARVEST: "ditutup karena harga keluar ke atas lalu dipanen",
  OOR_DOWN:       "ditutup karena harga keluar ke bawah",
  OOR_TIMEOUT:    "ditutup karena kelamaan di luar range",
  LOW_YIELD:      "ditutup karena fee-nya terlalu kecil",
  PUMP_ABOVE:     "ditutup karena harga melonjak di atas range",
  MANUAL:         "ditutup manual oleh operator",
  UNKNOWN:        "alasan penutupan tidak tercatat",
});

/** Upper edge of a "vol[a,b)" / "vol4.5+" style bucket key, else null. */
function bucketUpperEdge(key) {
  if (typeof key !== "string") return null;
  const range = key.match(/^[a-z/]+\[[\d.]+,([\d.]+)\)$/i);
  if (range) return parseFloat(range[1]);
  const open = key.match(/^[a-z/]+([\d.]+)\+$/i);
  if (open) return Infinity;
  return null;
}

/**
 * HONEST enforcement sentence for a bucket pattern.
 *
 * This replaces the old claim "bot sekarang menghindari pola ini" — which was
 * FALSE: a derived lesson only ever entered the LLM prompt, it never created a
 * filter. Here we state what is actually true, per dimension, from live config:
 *   - a real gate exists AND covers the whole bucket → say it is auto-rejected
 *   - a real gate exists but only partly covers it   → say so, with the value
 *   - exit-side pattern                              → not an entry filter at all
 *   - otherwise                                      → prompt context only
 * @param {Object} dims       - lesson.dims
 * @param {Object} userConfig - live user-config.json
 * @returns {string}
 */
export function enforcementNote(dims, userConfig = {}) {
  const d = dims && typeof dims === "object" ? dims : {};
  const notes = [];

  if (d.volatility) {
    const floor = Number(userConfig.minVolatility);
    const edge = bucketUpperEdge(d.volatility);
    if (Number.isFinite(floor) && floor > 0 && Number.isFinite(edge) && floor >= edge) {
      notes.push(`pool serentang ini sudah otomatis ditolak (batas minVolatility ${floor})`);
    } else if (Number.isFinite(floor) && floor > 0) {
      notes.push(`batas minVolatility sekarang ${floor} — sebagian pool di rentang ini masih lolos`);
    }
  }
  if (d.fee_tvl) {
    const floor = Number(userConfig.minFeeActiveTvlRatio);
    const edge = bucketUpperEdge(d.fee_tvl);
    if (Number.isFinite(floor) && floor > 0 && Number.isFinite(edge) && floor >= edge) {
      notes.push(`pool serentang ini sudah otomatis ditolak (batas fee/TVL ${floor})`);
    } else if (Number.isFinite(floor) && floor > 0) {
      notes.push(`batas fee/TVL sekarang ${floor}`);
    }
  }
  if (d.entry_direction) {
    notes.push(userConfig.directionGateEnabled === true
      ? "filter arah harga saat masuk (direction gate) sedang AKTIF"
      : "belum ada filter otomatis untuk arah harga saat masuk (direction gate OFF)");
  }
  if (d.regime) {
    notes.push(userConfig.marketRegimeGateEnabled === false
      ? "filter kondisi pasar (market regime) sedang OFF"
      : `filter kondisi pasar aktif hanya saat SOL turun ≥ ${Math.abs(Number(userConfig.regimeDowntrendThresholdPct) || 5)}%`);
  }
  if (d.exit_class) {
    notes.push("ini pola SAAT KELUAR (exit), bukan filter saat memilih pool");
  }

  if (notes.length === 0) {
    return "Belum ada blokir otomatis untuk pola ini — baru jadi bahan pertimbangan AI saat menilai pool.";
  }
  return `Status penegakan: ${notes.join("; ")}. Selain itu pola ini hanya masuk bahan pertimbangan AI, bukan blokir otomatis.`;
}

/**
 * Convert one raw lesson record into a plain-Indonesian insight sentence an
 * investor understands — no bin_step / volatility / fee_tvl_ratio jargon.
 *
 * Handles BOTH shapes:
 *   - bucket-aggregate rows (sourceType "bucket_aggregate"): renders the REAL
 *     dimensions (entry direction, market regime, exit reason, vol, fee) plus n
 *     and realized-SOL EV. The old renderer collapsed every lesson into the same
 *     two traits (fee + volatility), so an entry-direction or exit-reason finding
 *     was reported as if it were a fee/volatility finding.
 *   - legacy prose lessons: unchanged parsing, but with the honest enforcement
 *     sentence instead of the false "bot sekarang menghindari pola ini".
 * @param {Object} lesson
 * @param {Object} [userConfig] - live user-config.json (drives enforcement text)
 * @returns {string|null}
 */
export function lessonToPlain(lesson, userConfig = {}) {
  if (!lesson || !lesson.rule) return null;
  const rule = String(lesson.rule);

  // Auto-evolved threshold lessons → describe the self-tuning behaviour plainly.
  if (/AUTO-EVOLVED/i.test(rule)) {
    return "Bot pernah menyesuaikan sendiri standar pemilihan pool berdasarkan hasil posisi sebelumnya (mode lama).";
  }

  // ── Bucket-aggregate row (dimension-aware) ───────────────────────────────
  if (lesson.sourceType === "bucket_aggregate" && lesson.dims && typeof lesson.dims === "object") {
    const traits = Object.keys(lesson.dims).sort()
      .map((k) => DIM_WORDS[lesson.dims[k]] || String(lesson.dims[k]))
      .filter(Boolean);
    const traitStr = traits.length ? traits.join(" + ") : "pola tertentu";
    const n = Number(lesson.n);
    const ev = Number(lesson.ev_sol);
    const net = Number(lesson.net_sol);
    const evStr = Number.isFinite(ev) ? `${ev >= 0 ? "+" : ""}${ev.toFixed(4)} SOL per posisi` : "hasil belum terhitung";
    const netStr = Number.isFinite(net) ? ` (total ${net >= 0 ? "+" : ""}${net.toFixed(4)} SOL)` : "";
    const strength = lesson.verdict === "SIGNAL"
      ? (lesson.micro_ev ? "polanya konsisten tapi nilainya kecil" : "polanya konsisten, bukan kebetulan")
      : lesson.verdict === "NOISE"
        ? "belum bisa dipastikan, masih bisa kebetulan"
        : "data masih sedikit, belum cukup untuk kesimpulan";
    const head = `${cap(traitStr)} — ${Number.isFinite(n) ? n : "?"} posisi, rata-rata ${evStr}${netStr}; ${strength}.`;
    return `${head} ${enforcementNote(lesson.dims, userConfig)}`;
  }

  // ── Legacy prose lesson ──────────────────────────────────────────────────
  // Pull numbers from the structured context string (more reliable than the rule prose).
  const ctx = String(lesson.context || rule);
  const num = (re) => { const m = ctx.match(re); return m ? parseFloat(m[1]) : null; };
  const vol     = num(/volatility=([\d.]+)/);
  const feeTvl  = num(/fee_tvl_ratio=([\d.]+)/);
  const pnlPct  = Number.isFinite(lesson.pnl_pct) ? lesson.pnl_pct : num(/PnL\s*([+\-]?[\d.]+)%/);

  const volWord = vol == null ? null : (vol < 2 ? "tenang" : vol < 4 ? "sedang" : "tinggi");
  const feeWord = feeTvl == null ? null : (feeTvl < 0.1 ? "rendah (di bawah 0.1)" : feeTvl < 0.2 ? "sedang" : "bagus");

  const good = lesson.outcome === "good" || /^(\[×\d+ obs\]\s*)?(PREFER|WORKED)/i.test(rule);
  const bad  = lesson.outcome === "poor" || lesson.outcome === "bad" || /^(\[×\d+ obs\]\s*)?FAILED/i.test(rule);

  const traits = [];
  if (feeWord) traits.push(`fee ${feeWord}`);
  if (volWord) traits.push(`pergerakan harga ${volWord}`);
  const traitStr = traits.length ? `pool dengan ${traits.join(" + ")}` : "pola pool tertentu";
  const pnlStr = pnlPct != null ? ` (hasil ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : "";
  const obs = Number(lesson.merged_count) > 1 ? ` [${lesson.merged_count} kejadian serupa]` : "";
  // HONEST enforcement — the old text claimed the bot "menghindari"/"memprioritaskan"
  // these patterns. It does not: a derived lesson only enters the AI prompt.
  const enforcement = enforcementNote({
    volatility: vol == null ? null : (vol < 2.5 ? "vol[0,2.5)" : vol < 3.5 ? "vol[2.5,3.5)" : vol < 4.5 ? "vol[3.5,4.5)" : "vol4.5+"),
    fee_tvl: feeTvl == null ? null : (feeTvl < 0.1 ? "fee[0,0.1)" : feeTvl < 0.2 ? "fee[0.1,0.2)" : feeTvl < 0.4 ? "fee[0.2,0.4)" : "fee0.4+"),
  }, userConfig);

  if (good) return `${cap(traitStr)} cenderung menguntungkan${pnlStr}${obs}. ${enforcement}`;
  if (bad)  return `${cap(traitStr)} cenderung merugi${pnlStr}${obs}. ${enforcement}`;
  return `${cap(traitStr)}${pnlStr}${obs}. ${enforcement}`;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Lessons Engine State — performance records + threshold status + top lessons.
 * @param {Object} lessonsState   - normalized { lessons:[], performance:[] }
 * @param {Object} userConfig     - live user-config.json
 * @param {Object} [proposalsState] - threshold-proposals.json (propose-only queue)
 * @returns {string|null}
 */
export function buildLessonsSection(lessonsState, userConfig = {}, proposalsState = null) {
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

  // Top 3 lessons — bucket-aggregate rows FIRST (they carry n + realized-SOL EV,
  // i.e. actual evidence), then legacy prose by confidence. Auto-evolved
  // bookkeeping entries are summarised separately below.
  const ranked = [...lessons]
    .filter(l => l && l.rule && !/AUTO-EVOLVED/i.test(String(l.rule)))
    .sort((a, b) => {
      // 1. material bucket rows (statistically real AND economically non-trivial)
      const mat = (x) => (x.sourceType === "bucket_aggregate" && x.material ? 2 : x.sourceType === "bucket_aggregate" ? 1 : 0);
      if (mat(b) !== mat(a)) return mat(b) - mat(a);
      // 2. within bucket rows: money moved
      const money = (x) => Math.abs(Number(x.net_sol) || 0);
      if (money(b) !== money(a)) return money(b) - money(a);
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
    // FACT, not agency: the current standard differs from the base default.
    // (Who changed it — Bro manually or the old auto-apply path — is stated below.)
    lines.push(`Standar pemilihan pool saat ini lebih ketat dari setelan dasar (fee/TVL min ${minFeeRatio}, organic min ${minOrganic}).`);
  }

  // ── Threshold-change honesty block ──────────────────────────────────────
  // The learning loop is PROPOSE-ONLY (Lyra guard): it never rewrites its own
  // risk gates. Say that plainly instead of implying self-tuning.
  const autoApply = userConfig?.learning?.evolveAutoApply === true || userConfig?.evolveAutoApply === true;
  const pending = Array.isArray(proposalsState?.pending) ? proposalsState.pending.filter(p => !p.applied) : [];
  if (autoApply) {
    lines.push(`<i>Mode: bot BOLEH mengubah standar sendiri (auto-apply ON).</i>`);
    if (lastEvolved) {
      const dateStr = lastEvolved.slice(0, 16).replace("T", " ");
      lines.push(`<i>Standar terakhir berubah otomatis: ${dateStr}${evaluatedSince !== null && evaluatedSince > 0 ? ` · ${evaluatedSince} posisi dievaluasi sejak itu` : ""}.</i>`);
    }
  } else {
    lines.push(`<i>Bot TIDAK mengubah standar sendiri — hanya mengusulkan, keputusan tetap di Bro (mode usulan / propose-only).</i>`);
    if (pending.length > 0) {
      lines.push(`Usulan menunggu keputusan (<b>${pending.length}</b>):`);
      for (const p of pending.slice(0, 3)) {
        const tag = p.direction === "LOOSEN" ? "⚠️ LEBIH LONGGAR — wajib persetujuan Bro + review Cassiopeia" : "lebih ketat";
        lines.push(`• <b>${p.key}</b>: ${p.current} → ${p.proposed} (${tag})`);
      }
    } else if (lastEvolved) {
      const dateStr = lastEvolved.slice(0, 16).replace("T", " ");
      const since = (evaluatedSince !== null && evaluatedSince > 0)
        ? ` · ${evaluatedSince} posisi dievaluasi sejak itu (data belum cukup beda buat mengusulkan perubahan — ini normal, bukan berhenti)`
        : ` (bot tetap evaluasi tiap posisi ditutup)`;
      lines.push(`<i>Belum ada usulan baru. Standar terakhir pernah berubah otomatis ${dateStr}${since}, mode lama sebelum propose-only.</i>`);
    } else {
      lines.push(`<i>Belum ada usulan perubahan standar.</i>`);
    }
  }

  if (ranked.length > 0) {
    lines.push(`Pelajaran utama:`);
    for (const l of ranked) {
      const plain = lessonToPlain(l, userConfig);
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
  // Keep the RAW read (null on parse failure) so buildBalanceSection can tell
  // "state unreadable" (→ honest note) apart from "flat wallet" (→ clean render).
  const stateRaw = readJson("state.json");
  const stateData = stateRaw || {};
  const openLiveCount = Object.values(stateData.positions || {}).filter(p => p && !p.closed).length;
  // Committed open-position principal (SOL) — decomposes the balance line so a
  // deployed-capital dip in liquid SOL can't read as a drain. Sync, no RPC.
  const deployedSol = sumOpenPositionsCapital(stateRaw);

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
  // Propose-only threshold queue (Lyra) — nothing in here is applied; the report
  // shows it as "menunggu keputusan Bro".
  const proposalsState = readJson("threshold-proposals.json");
  const lessonsSection = buildLessonsSection(lessonsState, userConfig, proposalsState);

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

  const balSection = buildBalanceSection(solBalance, solUsd, burnerPubkey, deployedSol);

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
