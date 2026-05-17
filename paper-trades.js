import fs from "fs";
import { getPoolDetail } from "./tools/screening.js";
import { getTokenInfo } from "./tools/token.js";
import { log } from "./logger.js";
import { setPoolAndTokenCooldown } from "./pool-memory.js";
import { config } from "./config.js";
import { notifyClose, isExecutiveMode, isBigPnl } from "./telegram.js";
import { recordPerformance } from "./lessons.js";

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
    // Andromeda PR-A — max-drawdown-recovery exit fields. Track low-water mark
    // and running peak-trough so we can lock in a partial recovery from a deep
    // dip even when peak never reached trailingTriggerPct. Additive — old trades
    // without these fields still work via `?? 0` fallbacks in evaluatePaperExit.
    min_pnl_pct: 0,
    max_drawdown_pct: 0,
    drawdown_recovery_armed_at: null,
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

// Andromeda — paper trade exit evaluator. Mirrors state.js updatePnlAndCheckExits,
// but runs against price_proxy_pnl_pct + active-bin OOR for paper (DRY_RUN) trades.
// Returns { action, reason } or null.
export function evaluatePaperExit(trade, snapshot, mgmtConfigOverride = null) {
  if (!trade || trade.status !== "open" || !snapshot) return null;
  const mgmt = mgmtConfigOverride || config.management || {};
  const pnlPct = Number(snapshot.price_proxy_pnl_pct);
  if (Number.isFinite(pnlPct)) {
    // Track peak for trailing TP
    if (trade.peak_pnl_pct == null || pnlPct > trade.peak_pnl_pct) {
      trade.peak_pnl_pct = pnlPct;
    }
    // Stop loss
    if (mgmt.stopLossPct != null && pnlPct <= mgmt.stopLossPct) {
      return { action: "STOP_LOSS", reason: `Stop loss: PnL ${pnlPct.toFixed(2)}% <= ${mgmt.stopLossPct}%` };
    }
    // Take profit (basic)
    if (mgmt.takeProfitPct != null && pnlPct >= mgmt.takeProfitPct) {
      return { action: "TAKE_PROFIT", reason: `Take profit: PnL ${pnlPct.toFixed(2)}% >= ${mgmt.takeProfitPct}%` };
    }
    // Trailing TP
    if (mgmt.trailingTakeProfit && trade.peak_pnl_pct != null && trade.peak_pnl_pct >= (mgmt.trailingTriggerPct ?? Infinity)) {
      const dropFromPeak = trade.peak_pnl_pct - pnlPct;
      if (dropFromPeak >= (mgmt.trailingDropPct ?? Infinity)) {
        return {
          action: "TRAILING_TP",
          reason: `Trailing TP: peak ${trade.peak_pnl_pct.toFixed(2)}% → current ${pnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmt.trailingDropPct}%)`,
        };
      }
    }

    // Andromeda PR-A — DRAWDOWN_RECOVERY
    // Lock in a partial recovery after a deep dip. Distinct from Trailing TP:
    // Trailing TP requires peak >= trailingTriggerPct (default +3%). Positions
    // that never made a peak but recovered from a deep underwater move would
    // otherwise get NOTHING. Per Bro Dikta external-operator insight: "track
    // behavior from max drawdown — the clue is recovery."
    //
    // ARM:  max_drawdown_pct (peak − current low) >= armPct (default 10%)
    // FIRE: pnlPct − min_pnl_pct >= deltaPct (default 5%)
    // GUARD: stillBelowPeak — must not be near a new high (-0.5% slack), so
    //        a full recovery to a new peak is not mistaken for partial recovery.
    //
    // Reversibility: config.internalAgents.drawdownRecoveryEnabled=false →
    // silent revert to legacy behavior. Old trades w/o fields use `?? 0`.
    trade.min_pnl_pct = Math.min(trade.min_pnl_pct ?? 0, pnlPct);
    trade.max_drawdown_pct = Math.max(
      trade.max_drawdown_pct ?? 0,
      (trade.peak_pnl_pct ?? 0) - pnlPct,
    );

    if (config.internalAgents?.drawdownRecoveryEnabled !== false) {
      const armPct = mgmt.drawdownRecoveryArmPct ?? 10;
      const deltaPct = mgmt.drawdownRecoveryDeltaPct ?? 5;

      const droppedDeepEnough = (trade.max_drawdown_pct ?? 0) >= armPct;
      const recoveredFromTrough = pnlPct - (trade.min_pnl_pct ?? 0) >= deltaPct;
      const stillBelowPeak = pnlPct < (trade.peak_pnl_pct ?? 0) - 0.5;

      if (droppedDeepEnough && !trade.drawdown_recovery_armed_at) {
        trade.drawdown_recovery_armed_at = new Date().toISOString();
      }

      if (droppedDeepEnough && recoveredFromTrough && stillBelowPeak) {
        return {
          action: "DRAWDOWN_RECOVERY",
          reason: `Drawdown recovery: max_dd=${trade.max_drawdown_pct.toFixed(2)}% recovered to ${pnlPct.toFixed(2)}% from trough ${trade.min_pnl_pct.toFixed(2)}% (delta ${(pnlPct - trade.min_pnl_pct).toFixed(2)}% >= ${deltaPct}%)`,
        };
      }
    }
  }
  // OOR — paper proxy: snapshot.price compared to entry-band derived from bins.
  // We don't have live active_bin reliably in paper, so use price-band proxy:
  // OOR when price deviates more than ~25% from entry (conservative paper-only heuristic).
  const entry = Number(trade.entry_price);
  const cur = Number(snapshot.price);
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(cur) && cur > 0) {
    const deviationPct = Math.abs((cur - entry) / entry) * 100;
    const OOR_BAND_PCT = 25;
    if (deviationPct > OOR_BAND_PCT) {
      if (!trade.out_of_range_since) trade.out_of_range_since = new Date().toISOString();
    } else {
      trade.out_of_range_since = null;
    }
    if (trade.out_of_range_since) {
      const minutesOOR = Math.floor((Date.now() - new Date(trade.out_of_range_since).getTime()) / 60000);
      const limit = mgmt.outOfRangeWaitMinutes ?? 30;
      if (minutesOOR >= limit) {
        return { action: "OUT_OF_RANGE", reason: `Out of range for ${minutesOOR}m (limit: ${limit}m)` };
      }
    }
  }
  return null;
}

// Exported for tests (scripts/test-lessons-from-paper.js) so the lessons
// feedback path can be exercised without network-bound buildSnapshot calls.
// In production, only refreshPaperTrades() invokes this.
export async function closePaperTrade(trade, exit, snapshot) {
  trade.status = "closed";
  trade.closed_at = new Date().toISOString();
  trade.close_reason = exit.reason;
  trade.close_action = exit.action;
  trade.final_pnl_pct = snapshot?.price_proxy_pnl_pct ?? null;
  trade.final_fee_inclusive_pnl_pct = snapshot?.fee_inclusive_pnl_pct ?? null;
  trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
  trade.notes.push(`paper_close: ${exit.action} — ${exit.reason}`);
  const opened = Date.parse(trade.opened_at);
  const durationMin = Number.isFinite(opened) ? Math.floor((Date.now() - opened) / 60000) : null;
  // Fire Telegram pulse — DRY_RUN paper close.
  // Executive mode: only surface notable closes (|PnL| >= bigPnlThresholdPct).
  // Small-PnL paper closes stay silent and aggregate into daily boss-report.
  const shouldNotify = !isExecutiveMode() || isBigPnl(trade.final_pnl_pct);
  if (shouldNotify) {
    notifyClose({
      pair: trade.pool_name || trade.pool_address?.slice(0, 8),
      pnlPct: trade.final_pnl_pct ?? 0,
      pnlSol: trade.final_pnl_pct != null && trade.amount_sol
        ? Number(((trade.final_pnl_pct / 100) * trade.amount_sol).toFixed(6))
        : null,
      feesSol: trade.fees_claimed_sol ?? 0,
      durationMin,
      feeInclusivePnlPct: trade.final_fee_inclusive_pnl_pct,
      positionAddress: trade.id,
      dryRun: true,
    }).catch(() => {});
  }
  log("paper", `Paper trade closed: ${trade.pool_name} — ${exit.action} (${exit.reason})`);

  // PR-B — feed paper close into the lessons learning loop (DRY_RUN closes
  // were forensic-only before this). Gated by config.internalAgents.paperFeedsLessons
  // (default true). Reversibility: flip flag false → silent revert to forensic-only.
  if (config.internalAgents?.paperFeedsLessons !== false) {
    try {
      // Shape matches tools/dlmm.js:1551 / 1834 (live close path). Paper trades
      // operate in SOL, so we synthesize SOL-as-USD numbers (treat 1 USD == 1
      // unit of amount_sol) — recordPerformance only cares about ratios for
      // pnl_pct / range_efficiency, both already finite here.
      const initialValue = Number(trade.amount_sol) || 0;
      const pnlPct = Number(trade.final_pnl_pct) || 0;
      const finalValue = initialValue > 0
        ? Math.max(0, initialValue * (1 + pnlPct / 100))
        : 0;
      const feesEarnedSol = Number(trade.fees_claimed_sol) || 0;
      await recordPerformance({
        position: trade.id,
        pool: trade.pool_address,
        pool_name: trade.pool_name,
        base_mint: trade.base_mint || null,
        strategy: trade.strategy,
        bin_range: {
          bins_below: trade.bins_below ?? null,
          bins_above: trade.bins_above ?? null,
        },
        bin_step: trade.bin_step ?? null,
        volatility: trade.entry_volatility ?? null,
        fee_tvl_ratio: trade.entry_fee_tvl_ratio ?? null,
        organic_score: trade.entry_organic_score ?? null,
        amount_sol: initialValue,
        fees_earned_usd: feesEarnedSol, // paper: SOL units treated as USD-equivalent
        fees_earned_sol: feesEarnedSol,
        final_value_usd: finalValue,
        initial_value_usd: initialValue,
        minutes_in_range: durationMin ?? 0,
        minutes_held: durationMin ?? 0,
        close_reason: exit.reason,
        deployed_at: trade.opened_at,
        source: "paper",
      });
    } catch (err) {
      log("paper_warn", `recordPerformance failed for ${trade.pool_name}: ${err.message}`);
    }
  }
}

export async function refreshPaperTrades({ mgmtConfigOverride = null } = {}) {
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

    // Andromeda — evaluate close eligibility on every refresh.
    const exit = evaluatePaperExit(trade, snapshot, mgmtConfigOverride);
    if (exit) {
      await closePaperTrade(trade, exit, snapshot);
      changed = true;
      continue;
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

// Andromeda — one-shot legacy sweep for matured paper trades stranded by the
// pre-fix era (status=matured, no closed_at). New exit-eval logic skips them, so
// this closes them in-place using their last known snapshot PnL. Snapshot-based
// only — no market re-evaluation. CLI runner: scripts/sweep-paper-trades.js.
// Destructive: closed status cannot be undone without paper-trades.json backup.
export function sweepMaturedPaperTrades({ dryRun = false } = {}) {
  const data = load();
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const matured = trades.filter((t) => t.status === "matured" && !t.closed_at);
  if (matured.length === 0) return { swept: 0, totalPnlPct: 0, results: [] };

  const results = [];
  for (const trade of matured) {
    // Defensive fallback chain — real schema uses `latest_snapshot` (singular),
    // but spec also tolerates a `snapshots[]` array if ever introduced.
    const snapArray = Array.isArray(trade.snapshots) ? trade.snapshots : null;
    const lastSnap = (snapArray && snapArray[snapArray.length - 1]) || trade.latest_snapshot || null;
    const finalPnlPct = num(lastSnap?.price_proxy_pnl_pct ?? lastSnap?.pnl_pct) ?? num(trade.peak_pnl_pct) ?? 0;
    const finalFeeInclusivePnlPct = num(lastSnap?.fee_inclusive_pnl_pct) ?? finalPnlPct;

    if (!dryRun) {
      trade.status = "closed";
      trade.closed_at = new Date().toISOString();
      trade.close_reason = "legacy_sweep";
      trade.close_action = "matured_no_eval";
      trade.final_pnl_pct = finalPnlPct;
      trade.final_fee_inclusive_pnl_pct = finalFeeInclusivePnlPct;
      trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
      trade.notes.push("paper_close: LEGACY_SWEEP — snapshot-based, not market re-evaluated");
    }
    results.push({
      pool: trade.pool_address,
      symbol: trade.base_symbol || trade.pool_name || trade.pool_address?.slice(0, 8),
      pnl_pct: finalPnlPct,
    });
  }

  if (!dryRun) save(data);

  const totalPnlPct = results.length
    ? results.reduce((sum, r) => sum + (r.pnl_pct || 0), 0) / results.length
    : 0;
  return { swept: results.length, totalPnlPct, results };
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
