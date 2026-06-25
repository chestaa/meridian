// tsmom/ohlcv-ingest.js — Lyra's daily OHLCV ingester for crypto majors (TSMOM v1).
//
// WHY THIS EXISTS
// ---------------
// B1 = systematic time-series momentum (TSMOM) on crypto majors. Before ANY
// capital we validate on history. That requires honest price data. This module
// pulls DAILY close history from a FREE source and stores it locally as an
// append-friendly JSON cache.
//
// HONESTY MANDATE (Lyra audit code):
//   * We use CoinGecko's FREE public API. It has HARD LIMITS we name openly:
//       - Free tier `market_chart` with days>90 returns DAILY granularity only
//         (intraday is gated). For TSMOM (12-month signal, monthly rebalance)
//         daily is exactly right — but we cannot get true OHLC, only CLOSE
//         (the free `market_chart` endpoint returns [ts, price] points, i.e.
//         close-equivalent spot snapshots). So our "OHLCV" is really a daily
//         CLOSE series. We label it honestly: ohlcv rows carry close only;
//         open/high/low are null. TSMOM uses close-to-close returns, so this is
//         sufficient — but we do NOT pretend we have true OHLC.
//       - Free tier historical depth: CoinGecko caps free `market_chart` at
//         365 days of daily history (days="max" silently truncates to ~1yr on
//         the free key as of 2026). We request 365 and REPORT the actual span
//         returned. SOL/ETH/BTC all began well before — so OUR window is the
//         free-API window, NOT the full asset history. This is the single
//         biggest honesty caveat for the backtest: ~1 year of daily data is
//         THIN for a 12-month-lookback strategy (it leaves almost no
//         out-of-sample periods). We flag this loudly downstream.
//       - Rate limit: ~5-15 calls/min on the free tier. We fetch 3 assets with
//         polite spacing and never hammer.
//   * NEVER fabricate. If a fetch fails or returns short, we store what we got
//     and stamp the gap. A missing day is a missing day.
//
// NO money path. NO LLM cost. Pure HTTP GET + local JSON cache.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Data dir (overridable for tests).
export function dataDir() {
  return process.env.TSMOM_DATA_DIR
    ? path.resolve(process.env.TSMOM_DATA_DIR)
    : path.resolve(__dirname, "data");
}

// Majors. CoinGecko ids. vs USD.
export const MAJORS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

const CG_BASE = process.env.COINGECKO_BASE || "https://api.coingecko.com/api/v3";
// Optional demo/pro key (still free tier behavior for demo keys).
const CG_KEY = process.env.COINGECKO_API_KEY || null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── fetch one asset's daily close history ──────────────────────────────
// Returns { asset, source, requested_days, rows:[{date, ts, close, open,high,low,volume}], gaps:[...], warnings:[...] }
export async function fetchDailyHistory(asset, { days = 365, vs = "usd" } = {}) {
  const id = MAJORS[asset];
  if (!id) throw new Error(`unknown asset ${asset}; known: ${Object.keys(MAJORS).join(",")}`);

  const url = new URL(`${CG_BASE}/coins/${id}/market_chart`);
  url.searchParams.set("vs_currency", vs);
  url.searchParams.set("days", String(days));
  url.searchParams.set("interval", "daily");
  const headers = { accept: "application/json" };
  if (CG_KEY) headers["x-cg-demo-api-key"] = CG_KEY;

  const warnings = [];
  let json;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    json = await res.json();
  } catch (e) {
    return {
      asset,
      source: "coingecko-free",
      requested_days: days,
      rows: [],
      gaps: [],
      warnings: [`FETCH FAILED: ${e.message}`],
      ok: false,
    };
  }

  // market_chart returns { prices:[[ms,price]], market_caps:[...], total_volumes:[[ms,vol]] }
  const prices = Array.isArray(json.prices) ? json.prices : [];
  const volsByMs = new Map(
    (Array.isArray(json.total_volumes) ? json.total_volumes : []).map(([ms, v]) => [
      dayKeyFromMs(ms),
      v,
    ])
  );

  // Collapse to one row per calendar day (UTC). CoinGecko daily already ~1/day
  // but the last point is "now" (partial day) — we keep the LAST close seen for
  // each day key. We honestly mark the final row as possibly-partial.
  const byDay = new Map();
  for (const [ms, price] of prices) {
    const k = dayKeyFromMs(ms);
    byDay.set(k, { date: k, ts: ms, close: price });
  }
  const dayKeys = [...byDay.keys()].sort();
  const rows = dayKeys.map((k) => {
    const r = byDay.get(k);
    return {
      date: k,
      ts: r.ts,
      open: null, // free market_chart gives no true OHLC — close only. HONEST.
      high: null,
      low: null,
      close: r.close,
      volume: volsByMs.has(k) ? volsByMs.get(k) : null,
    };
  });

  // Detect calendar gaps (missing days between first and last).
  const gaps = detectGaps(dayKeys);
  if (gaps.length) warnings.push(`${gaps.length} calendar-day gap(s) in series`);
  if (rows.length && days >= 364 && rows.length < 360) {
    warnings.push(
      `requested ${days}d but got only ${rows.length} rows — free-tier depth truncation`
    );
  }
  if (rows.length) {
    warnings.push(
      `final row ${rows[rows.length - 1].date} may be a PARTIAL day (live snapshot)`
    );
  }

  return {
    asset,
    source: "coingecko-free",
    requested_days: days,
    rows,
    gaps,
    warnings,
    ok: rows.length > 0,
  };
}

function dayKeyFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Return list of missing YYYY-MM-DD between first and last present day.
function detectGaps(sortedDayKeys) {
  if (sortedDayKeys.length < 2) return [];
  const gaps = [];
  const oneDay = 86400000;
  let prev = new Date(sortedDayKeys[0] + "T00:00:00Z").getTime();
  const present = new Set(sortedDayKeys);
  const last = new Date(sortedDayKeys[sortedDayKeys.length - 1] + "T00:00:00Z").getTime();
  for (let t = prev + oneDay; t < last; t += oneDay) {
    const k = new Date(t).toISOString().slice(0, 10);
    if (!present.has(k)) gaps.push(k);
  }
  return gaps;
}

// ── persist ─────────────────────────────────────────────────────────────
export function saveHistory(result) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.asset}-daily.json`);
  const payload = {
    asset: result.asset,
    source: result.source,
    fetched_at: new Date().toISOString(),
    requested_days: result.requested_days,
    row_count: result.rows.length,
    first_date: result.rows[0]?.date ?? null,
    last_date: result.rows[result.rows.length - 1]?.date ?? null,
    gaps: result.gaps,
    warnings: result.warnings,
    rows: result.rows,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

export function loadHistory(asset) {
  const file = path.join(dataDir(), `${asset}-daily.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ── CLI: node tsmom/ohlcv-ingest.js [BTC ETH SOL] ────────────────────────
async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const assets = args.length ? args.map((a) => a.toUpperCase()) : Object.keys(MAJORS);
  const days = Number(process.env.TSMOM_DAYS || 365);

  console.log(`[ingest] assets=${assets.join(",")} days=${days} source=coingecko-free`);
  for (const asset of assets) {
    process.stdout.write(`[ingest] ${asset} ... `);
    const result = await fetchDailyHistory(asset, { days });
    if (!result.ok) {
      console.log(`FAILED — ${result.warnings.join("; ")}`);
      continue;
    }
    const file = saveHistory(result);
    console.log(
      `${result.rows.length} rows (${result.rows[0].date} → ${result.rows[result.rows.length - 1].date}) → ${path.basename(file)}`
    );
    for (const w of result.warnings) console.log(`   ⚠ ${w}`);
    await sleep(2500); // polite spacing for free-tier rate limit
  }
  console.log("[ingest] done.");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ohlcv-ingest.js")) {
  main().catch((e) => {
    console.error("[ingest] fatal:", e.message);
    process.exit(1);
  });
}
