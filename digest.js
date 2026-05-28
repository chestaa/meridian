/**
 * Digest — on-demand instant pulse for Telegram /digest command.
 * Sirius signal collector / status surface.
 *
 * Pure data → HTML string. All I/O is read-only filesystem + the timers
 * object passed in by the caller. Safe to invoke at any time, never
 * touches on-chain state.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const DEFAULT_THRESHOLDS = {
  minOrganic: 60,
  minFeeActiveTvlRatio: 0.05,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(file, tailN = 50) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-tailN);
    return tail
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fmtPct(n, digits = 1) {
  if (!Number.isFinite(n)) return "?";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function nowJakarta() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function gatherDigestData({ now = Date.now(), timers = null } = {}) {
  // Paper trades
  const paperRaw = readJson("paper-trades.json") || {};
  const trades = Array.isArray(paperRaw.trades) ? paperRaw.trades : [];

  const open = trades.filter((t) => t.status === "open");
  // Jakarta-local "today" boundary: midnight WIB = UTC midnight - 7h.
  // Convert `now` to Jakarta date components, then compute the UTC ms for
  // 00:00 WIB of that day (which is 17:00 UTC of the previous calendar day).
  const jakartaParts = new Date(now).toLocaleString("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric", month: "2-digit", day: "2-digit",
  }); // "YYYY-MM-DD"
  const todayWibStartMs = Date.parse(`${jakartaParts}T00:00:00+07:00`);
  const todayUtc = new Date(now).toISOString().slice(0, 10); // retained for llm-cost filter
  const closedToday = trades.filter((t) => {
    if (t.status === "open") return false;
    const closed = t.closed_at || t.matured_at || t.latest_snapshot?.checkpoint_at;
    if (!closed) return false;
    const closedMs = typeof closed === "number" ? closed : Date.parse(closed);
    return Number.isFinite(closedMs) && closedMs >= todayWibStartMs;
  });

  function tradePnl(t) {
    return t.fee_inclusive_pnl_pct ??
      t.latest_snapshot?.fee_inclusive_pnl_pct ??
      t.latest_snapshot?.price_proxy_pnl_pct ??
      null;
  }

  const todayPnlVals = closedToday
    .map(tradePnl)
    .filter((v) => Number.isFinite(v));
  const todayRealizedAvg = todayPnlVals.length
    ? todayPnlVals.reduce((s, v) => s + v, 0) / todayPnlVals.length
    : null;

  const openWithPnl = open
    .map((t) => ({ trade: t, pnl: tradePnl(t) }))
    .filter((x) => Number.isFinite(x.pnl));
  const biggestWinner = openWithPnl.length
    ? openWithPnl.reduce((a, b) => (a.pnl >= b.pnl ? a : b))
    : null;
  const biggestLoser = openWithPnl.length
    ? openWithPnl.reduce((a, b) => (a.pnl <= b.pnl ? a : b))
    : null;

  // Orion / LLM verdicts — read signal-results.jsonl tail
  const recentSignals = readJsonl("signal-results.jsonl", 50);
  const lastVerdicts = recentSignals
    .filter((r) => r?.llm?.decision)
    .slice(-3)
    .reverse()
    .map((r) => ({
      label: r.signal?.symbol || r.signal?.name || r.file || "unknown",
      decision: String(r.llm.decision).toUpperCase(),
      confidence: Number.isFinite(r.llm.confidence)
        ? Math.round(r.llm.confidence * 100)
        : null,
      reason: typeof r.llm.reason === "string"
        ? r.llm.reason.replace(/\s+/g, " ").slice(0, 80)
        : "",
    }));

  // Thresholds (current vs default)
  const userCfg = readJson("user-config.json") || {};
  const thresholds = {
    minOrganic: {
      current: userCfg.minOrganic ?? DEFAULT_THRESHOLDS.minOrganic,
      default: DEFAULT_THRESHOLDS.minOrganic,
    },
    minFeeActiveTvlRatio: {
      current: userCfg.minFeeActiveTvlRatio ?? DEFAULT_THRESHOLDS.minFeeActiveTvlRatio,
      default: DEFAULT_THRESHOLDS.minFeeActiveTvlRatio,
    },
  };

  // LLM cost today
  const llmData = readJson("llm-usage.json") || {};
  const records = Array.isArray(llmData.records) ? llmData.records : [];
  const todayCostUsd = records
    .filter((r) => typeof r.ts === "string" && r.ts.startsWith(todayUtc))
    .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);

  // Circuit breaker
  const cb = readJson("circuit-breaker-state.json");
  const circuit = cb
    ? {
        halted: !!cb.halted,
        realized_loss_sol: Number(cb.realized_loss_sol) || 0,
        cap_sol: 0.10,
        halt_reason: cb.halt_reason || null,
      }
    : { halted: false, realized_loss_sol: 0, cap_sol: 0.10, halt_reason: null };

  // Heartbeat (most recent of management/screening)
  const lastCycleAt = timers
    ? Math.max(timers.managementLastRun || 0, timers.screeningLastRun || 0)
    : 0;
  const lastCycleAgoMs = lastCycleAt > 0 ? now - lastCycleAt : null;

  return {
    now,
    paper: {
      open_count: open.length,
      today_realized_avg_pct: todayRealizedAvg,
      biggest_winner: biggestWinner
        ? { label: biggestWinner.trade.pool_name || biggestWinner.trade.base_symbol || "?", pnl: biggestWinner.pnl }
        : null,
      biggest_loser: biggestLoser
        ? { label: biggestLoser.trade.pool_name || biggestLoser.trade.base_symbol || "?", pnl: biggestLoser.pnl }
        : null,
    },
    verdicts: lastVerdicts,
    thresholds,
    llm_cost_today_usd: todayCostUsd,
    circuit,
    last_cycle_ago_ms: lastCycleAgoMs,
  };
}

export function formatDigest(data) {
  const lines = [];
  lines.push(`📋 <b>MERIDIAN DIGEST</b>`);
  lines.push(`${nowJakarta()} WIB`);
  lines.push("");

  // Paper trading
  lines.push(`💼 <b>Paper trading</b>`);
  const realizedStr = data.paper.today_realized_avg_pct == null
    ? "today realized: no closes yet"
    : `today realized: ${fmtPct(data.paper.today_realized_avg_pct)} avg`;
  lines.push(`Open: ${data.paper.open_count} trades | ${realizedStr}`);
  if (data.paper.biggest_winner) {
    lines.push(`Biggest winner open: ${data.paper.biggest_winner.label} ${fmtPct(data.paper.biggest_winner.pnl)}`);
  }
  if (data.paper.biggest_loser && data.paper.biggest_loser.label !== data.paper.biggest_winner?.label) {
    lines.push(`Biggest loser open: ${data.paper.biggest_loser.label} ${fmtPct(data.paper.biggest_loser.pnl)}`);
  }
  lines.push("");

  // Orion verdicts
  lines.push(`🏹 <b>Last 3 Orion verdicts</b>`);
  if (data.verdicts.length === 0) {
    lines.push(`<i>no recent verdicts</i>`);
  } else {
    for (const v of data.verdicts) {
      const conf = v.confidence != null ? ` (${v.confidence}%)` : "";
      const reason = v.reason ? ` — ${v.reason}` : "";
      lines.push(`- ${v.label} ${v.decision}${conf}${reason}`);
    }
  }
  lines.push("");

  // Thresholds
  lines.push(`📊 <b>Evolved thresholds</b>`);
  lines.push(`minOrganic: ${data.thresholds.minOrganic.current} (default ${data.thresholds.minOrganic.default})`);
  lines.push(`minFeeActiveTvlRatio: ${data.thresholds.minFeeActiveTvlRatio.current} (default ${data.thresholds.minFeeActiveTvlRatio.default})`);
  lines.push("");

  // LLM cost
  lines.push(`🤖 LLM cost today: $${data.llm_cost_today_usd.toFixed(3)}`);

  // Circuit
  const cb = data.circuit;
  const cbStatus = cb.halted
    ? `🔴 halted${cb.halt_reason ? ` (${cb.halt_reason})` : ""}`
    : `armed`;
  lines.push(`🛡️ Circuit: ${cbStatus} (${cb.realized_loss_sol.toFixed(4)}/${cb.cap_sol} SOL loss)`);

  // Heartbeat
  lines.push(`⏱️ Last cycle: ${fmtAgo(data.last_cycle_ago_ms)}`);

  return lines.join("\n");
}

export function buildDigest({ now = Date.now(), timers = null, executive = false } = {}) {
  const data = gatherDigestData({ now, timers });
  if (executive) {
    return { data, html: formatExecutiveDigest(data) };
  }
  return { data, html: formatDigest(data) };
}

/**
 * Executive digest (Sirius UX upgrade C) — short plain-Indonesia summary.
 * Reads paper-trades.json + circuit-breaker-state.json for the high-level
 * pulse: open positions, today's PnL, 7d win rate, wallet, bot status.
 * Walletbalance + win-rate hooks are passed in by the caller to avoid
 * pulling tools/wallet into digest.js (read-only module).
 */
export function formatExecutiveDigest(data, extras = {}) {
  const lines = [];
  lines.push(`📊 <b>RINGKASAN HARI INI</b>`);
  lines.push(`${nowJakarta()} WIB`);
  lines.push("");
  lines.push(`Posisi terbuka: ${data.paper.open_count}`);
  const realized = data.paper.today_realized_avg_pct;
  if (realized == null) {
    lines.push(`Untung hari ini: belum ada close`);
  } else {
    const sign = realized >= 0 ? "+" : "";
    lines.push(`Untung hari ini: ${sign}${realized.toFixed(2)}%`);
  }
  if (extras.winRate7d != null) {
    lines.push(`Win rate 7 hari: ${extras.winRate7d}%`);
  }
  if (extras.walletSol != null) {
    const usdStr = extras.walletUsd != null ? ` ($${extras.walletUsd.toFixed(0)})` : "";
    lines.push(`Wallet: ${Number(extras.walletSol).toFixed(3)} SOL${usdStr}`);
  }
  const cbStatus = data.circuit.halted ? "🔴 halted" : "🟢 jalan";
  lines.push(`Bot: ${cbStatus}`);
  lines.push("");
  lines.push(`Detail teknis: /details`);
  return lines.join("\n");
}
