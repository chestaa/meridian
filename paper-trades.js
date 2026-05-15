import fs from "fs";
import { getPoolDetail } from "./tools/screening.js";
import { getTokenInfo } from "./tools/token.js";
import { log } from "./logger.js";
import { setPoolAndTokenCooldown } from "./pool-memory.js";

const PAPER_TRADES_FILE = "./paper-trades.json";
const MAX_TRADES = 300;
const CHECKPOINTS_HOURS = [1, 6, 24];

function defaultState() {
  return { trades: [] };
}

function load() {
  if (!fs.existsSync(PAPER_TRADES_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(PAPER_TRADES_FILE, "utf8"));
    return { trades: Array.isArray(parsed?.trades) ? parsed.trades : [] };
  } catch {
    return defaultState();
  }
}

function save(data) {
  fs.writeFileSync(PAPER_TRADES_FILE, JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pnlPct(entryPrice, currentPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return null;
  return Number((((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2));
}

// Cassiopeia P1 #9 — flag whether all key risk fields were populated at entry.
function computeRiskDataComplete(entry) {
  return (
    num(entry.entry_age_hours) != null &&
    num(entry.entry_top10_pct) != null &&
    num(entry.entry_bundle_pct) != null &&
    entry.holders != null
  );
}

// Lyra forensic — fee-inclusive PnL helper.
// fee_inclusive_pnl_pct = price_proxy_pnl_pct + fees_earned_pct - estimated_il_pct
// Returns { fee_inclusive_pnl_pct, fees_earned_pct, estimated_il_pct, il_estimation_method }.
function computeFeeInclusivePnl(trade, priceProxyPnlPct) {
  if (!Number.isFinite(priceProxyPnlPct)) {
    return {
      fee_inclusive_pnl_pct: null,
      fees_earned_pct: null,
      estimated_il_pct: 0,
      il_estimation_method: "naive",
    };
  }

  const feesClaimed = num(trade.fees_claimed_sol);
  const deployAmount = num(trade.amount_sol);
  const feesEarnedPct =
    feesClaimed != null && deployAmount != null && deployAmount > 0
      ? Number(((feesClaimed / deployAmount) * 100).toFixed(2))
      : null;

  // For single-sided DLMM, we cannot cleanly determine in-range vs OOR from snapshot
  // alone, so default to naive 0% IL with explicit method flag.
  const estimatedIlPct = 0;
  const ilMethod = "naive";

  const feeInclusive = Number(
    (priceProxyPnlPct + (feesEarnedPct ?? 0) - estimatedIlPct).toFixed(2),
  );

  return {
    fee_inclusive_pnl_pct: feeInclusive,
    fees_earned_pct: feesEarnedPct,
    estimated_il_pct: estimatedIlPct,
    il_estimation_method: ilMethod,
  };
}

function hoursOpen(trade) {
  const opened = new Date(trade.opened_at).getTime();
  if (!Number.isFinite(opened)) return 0;
  return (Date.now() - opened) / 3_600_000;
}

function maybeEscalateCooldown(trade) {
  const currentPnl = trade.latest_snapshot?.price_proxy_pnl_pct;
  if (!Number.isFinite(currentPnl)) return false;

  if (currentPnl <= -15) {
    setPoolAndTokenCooldown({
      poolAddress: trade.pool_address,
      baseMint: trade.base_mint,
      hours: 12,
      reason: `paper trade drawdown ${currentPnl}%`,
    });
    trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
    if (!trade.notes.includes("cooldown_escalated")) trade.notes.push("cooldown_escalated");
    return true;
  }
  return false;
}

export function recordPaperDeploy(entry) {
  const data = load();
  const trade = {
    id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: "open",
    opened_at: nowIso(),
    updated_at: nowIso(),
    pool_address: entry.pool_address,
    pool_name: entry.pool_name || entry.pool_address,
    base_mint: entry.base_mint || null,
    strategy: entry.strategy || "spot",
    amount_sol: Number(entry.amount_sol || 0),
    active_bin: entry.active_bin ?? null,
    bins_below: entry.bins_below ?? null,
    bins_above: entry.bins_above ?? null,
    range_width_bins: Number(entry.bins_below || 0) + Number(entry.bins_above || 0),
    entry_price: num(entry.entry_price),
    entry_fee_tvl_ratio: num(entry.entry_fee_tvl_ratio),
    entry_volume: num(entry.entry_volume),
    entry_tvl: num(entry.entry_tvl),
    entry_volatility: num(entry.entry_volatility),
    entry_age_hours: num(entry.entry_age_hours),
    entry_top10_pct: num(entry.entry_top10_pct),
    entry_bot_pct: num(entry.entry_bot_pct),
    entry_bundle_pct: num(entry.entry_bundle_pct),
    entry_sniper_pct: num(entry.entry_sniper_pct),
    fees_claimed_sol: num(entry.fees_claimed_sol),
    risk_data_complete: computeRiskDataComplete(entry),
    latest_snapshot: null,
    checkpoints: {},
    notes: ["price_proxy_only"],
  };
  data.trades.push(trade);
  data.trades = data.trades.slice(-MAX_TRADES);
  save(data);
  return trade;
}

async function buildSnapshot(trade) {
  const [detail, tokenInfo] = await Promise.all([
    getPoolDetail({ pool_address: trade.pool_address, timeframe: "5m" }).catch(() => null),
    trade.base_mint ? getTokenInfo({ query: trade.base_mint }).catch(() => null) : Promise.resolve(null),
  ]);

  const token = tokenInfo?.results?.[0] || null;
  const currentPrice = num(detail?.pool_price) ?? num(token?.price);
  const priceProxy = pnlPct(trade.entry_price, currentPrice);
  const feeInclusive = computeFeeInclusivePnl(trade, priceProxy);
  const snapshot = {
    ts: nowIso(),
    price: currentPrice,
    price_proxy_pnl_pct: priceProxy,
    fee_inclusive_pnl_pct: feeInclusive.fee_inclusive_pnl_pct,
    fees_earned_pct: feeInclusive.fees_earned_pct,
    estimated_il_pct: feeInclusive.estimated_il_pct,
    il_estimation_method: feeInclusive.il_estimation_method,
    fee_tvl_ratio: num(detail?.fee_active_tvl_ratio),
    volume: num(detail?.volume),
    tvl: num(detail?.tvl ?? detail?.active_tvl),
    volatility: num(detail?.volatility),
    age_hours: detail?.token_x?.created_at
      ? Math.floor((Date.now() - Number(detail.token_x.created_at)) / 3_600_000)
      : trade.entry_age_hours,
    top10_pct: token?.audit?.top_holders_pct != null ? Number(token.audit.top_holders_pct) : null,
    bot_pct: token?.audit?.bot_holders_pct != null ? Number(token.audit.bot_holders_pct) : null,
    price_change_1h_pct: token?.stats_1h?.price_change != null ? Number(token.stats_1h.price_change) : null,
    net_buyers_1h: token?.stats_1h?.net_buyers != null ? Number(token.stats_1h.net_buyers) : null,
  };
  return snapshot;
}

export async function refreshPaperTrades() {
  const data = load();
  let changed = false;

  for (const trade of data.trades) {
    if (trade.status !== "open") continue;

    const snapshot = await buildSnapshot(trade).catch((error) => {
      log("paper_warn", `Failed to refresh ${trade.pool_name}: ${error.message}`);
      return null;
    });
    if (!snapshot) continue;

    trade.latest_snapshot = snapshot;
    trade.updated_at = snapshot.ts;
    for (const checkpointHours of CHECKPOINTS_HOURS) {
      const key = `${checkpointHours}h`;
      if (!trade.checkpoints[key] && hoursOpen(trade) >= checkpointHours) {
        trade.checkpoints[key] = snapshot;
      }
    }
    if (hoursOpen(trade) >= 24) {
      trade.status = "matured";
    }
    maybeEscalateCooldown(trade);
    changed = true;
  }

  if (changed) save(data);
  return data.trades;
}

export function getPaperTradeSummary() {
  const data = load();
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const withPnl = trades.filter((trade) => trade.latest_snapshot?.price_proxy_pnl_pct != null);
  const matured = trades.filter((trade) => trade.status === "matured" && trade.latest_snapshot?.price_proxy_pnl_pct != null);

  return {
    total_trades: trades.length,
    open_trades: trades.filter((trade) => trade.status === "open").length,
    matured_trades: matured.length,
    avg_open_price_proxy_pnl_pct: withPnl.length
      ? Number((withPnl.reduce((sum, trade) => sum + trade.latest_snapshot.price_proxy_pnl_pct, 0) / withPnl.length).toFixed(2))
      : null,
    matured_win_rate_pct: matured.length
      ? Number(((matured.filter((trade) => trade.latest_snapshot.price_proxy_pnl_pct > 0).length / matured.length) * 100).toFixed(1))
      : null,
    latest: trades.slice(-5).reverse().map((trade) => ({
      pool_name: trade.pool_name,
      opened_at: trade.opened_at,
      status: trade.status,
      entry_price: trade.entry_price,
      current_price: trade.latest_snapshot?.price,
      price_proxy_pnl_pct: trade.latest_snapshot?.price_proxy_pnl_pct ?? null,
      fee_tvl_ratio_entry: trade.entry_fee_tvl_ratio,
      fee_tvl_ratio_now: trade.latest_snapshot?.fee_tvl_ratio ?? null,
      age_hours_now: trade.latest_snapshot?.age_hours ?? null,
    })),
  };
}
