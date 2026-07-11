import fs from "fs";
import { getPoolDetail } from "./tools/screening.js";
import { getTokenInfo } from "./tools/token.js";
import { log } from "./logger.js";
import { setPoolAndTokenCooldown } from "./pool-memory.js";
import { config } from "./config.js";
import { notifyClose, isExecutiveMode, isBigPnl } from "./telegram.js";
import { recordPerformance } from "./lessons.js";
import { computePaperRealizedSolDelta } from "./realized-sol.js";

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

// Vega honesty-audit 2026-06-21 FIX #3 — sane price-proxy PnL for paper trades.
//
// ROOT CAUSE of the 6827% / 7585% garbage: the snapshot price source was NOT
// guaranteed to be the SAME unit as entry_price. entry_price is recorded from the
// pool-quoted price (`pool.price` at deploy). The snapshot fell back from
// `detail.pool_price` to `token.price` (a USD price from Jupiter) when the pool
// detail was missing — a DIFFERENT unit, off by the SOL/USD factor (~150x) → a
// fabricated multi-thousand-percent move on a position that barely moved.
//
// FIX: (1) only ever compare same-unit pool-quoted prices (caller drops the
// cross-unit token.price fallback for the PnL math); (2) a sanity band — a single
// LP holding cannot realistically swing past PROXY_SANE_RATIO_MAX/MIN within a
// paper-soak window; a ratio outside the band is a unit-mismatch / stale-snapshot
// artifact, NOT a real PnL. We return null (uncomputable) and a reason rather than
// recording absurd numbers. FAIL-SAFE: missing/non-finite price → null, never a
// fabricated figure.
//
// NOTE: a clamp would still poison the validation average with a fake boundary
// value, so for the absurd-ratio case we mark UNCOMPUTABLE (null) — the snapshot
// simply carries no PnL that cycle, exactly like a missing-price cycle. A genuine
// large memecoin move drives the position far OOR (earning nothing) and is handled
// by the OOR exit, so suppressing its unreliable price-proxy PnL loses no signal.
export const PROXY_SANE_RATIO_MAX = 10;   // > +900% in one holding window ⇒ suspect
export const PROXY_SANE_RATIO_MIN = 0.1;  // < -90% in one holding window ⇒ suspect

export function computePriceProxyPnl(entryPrice, currentPrice) {
  const e = Number(entryPrice);
  const c = Number(currentPrice);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(c) || c <= 0) {
    return { pnl_pct: null, uncomputable: true, reason: "missing_or_nonpositive_price" };
  }
  const ratio = c / e;
  if (ratio > PROXY_SANE_RATIO_MAX || ratio < PROXY_SANE_RATIO_MIN) {
    // Almost certainly a unit mismatch / stale snapshot — do NOT fabricate PnL.
    return {
      pnl_pct: null,
      uncomputable: true,
      reason: `implausible_price_ratio ${ratio.toFixed(2)} (entry=${e}, current=${c}) — likely unit mismatch/stale`,
    };
  }
  return { pnl_pct: Number(((ratio - 1) * 100).toFixed(2)), uncomputable: false, reason: null };
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
    entry_organic_score: num(entry.entry_organic_score ?? entry.organic_score),
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
    // Vega Item 2B — paper mirror of partial-TP scale-out. Fires ONCE; on fire
    // we reduce amount_sol by partialTpPct% (the scaled-out portion is realized
    // and removed from the running position) so subsequent PnL reflects only
    // the remainder. original_amount_sol preserves the pre-partial size for
    // accounting/forensics. partial_tp_done is the idempotency guard.
    partial_tp_done: false,
    partial_tp_at: null,
    original_amount_sol: Number(entry.amount_sol || 0),
    // Vega EXIT-3 #1 — paper mirror of break-even stop arm flag (idempotent).
    // Peaks >= breakEvenArmPct → be_armed true; stop ratchets to breakEvenStopPct
    // and NEVER ratchets back down. Default false (fixed SL is the only floor).
    be_armed: false,
    be_armed_at: null,
    // Vega EXIT-3 #2 — paper mirror of fee-decay baseline. entry_fee_tvl_ratio
    // (set above) is the deploy-time baseline; fee_decay_baseline records the
    // first post-warmup snapshot rate (a real early reading). null until then
    // → no baseline → no fee-decay exit (fail-safe).
    fee_decay_baseline: null,
    fee_decay_baseline_at: null,
    // Vega Item 9 — paper mirror of rebalance-on-OOR. When the position goes
    // OOR past the limit AND is high-organic AND under maxRebalances, the paper
    // model RE-CENTERS (reset the OOR timer, bump rebalance_count, keep the
    // trade open) instead of closing — mirroring the live re-center keeping fee
    // exposure. Once the cap is hit, OOR closes as today. Default flag OFF.
    rebalance_count: 0,
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
  // FIX #3 — entry_price is the POOL-QUOTED price (pool.price at deploy). The
  // snapshot MUST compare a same-unit pool-quoted price. We read detail.pool_price
  // ONLY — the old `?? token.price` fallback pulled a USD price (different unit,
  // ~150x off) and produced the 6827%/7585% garbage. If pool_price is unavailable
  // the proxy is uncomputable this cycle (null), NOT fabricated from a wrong unit.
  const currentPrice = num(detail?.pool_price);
  const proxy = computePriceProxyPnl(trade.entry_price, currentPrice);
  const priceProxy = proxy.pnl_pct; // null when missing-price OR implausible ratio
  if (proxy.uncomputable && currentPrice != null) {
    log("paper_warn", `Price-proxy uncomputable for ${trade.pool_name}: ${proxy.reason}`);
  }
  const feeInclusive = computeFeeInclusivePnl(trade, priceProxy);
  const snapshot = {
    ts: nowIso(),
    price: currentPrice,
    price_proxy_pnl_pct: priceProxy,
    price_proxy_uncomputable: proxy.uncomputable || undefined,
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

  // Andromeda X2 + Vega EXIT-3 #3 — Max-hold-time forced exit (HIGHEST PRECEDENCE).
  // Time-based forced close runs BEFORE SL/TP/Trailing/DD_RECOVERY so a stuck
  // position cannot dodge the gate via PnL fluctuation.
  //   - age >= maxHoldOorMinutes (720m) AND OUT OF RANGE → close (max_hold_oor):
  //     a stale OOR paper position earns nothing; don't babysit past 12h.
  //   - age >= maxHoldMinutes (1440m / 24h) → close (max_hold_hard) regardless of
  //     range: entry thesis structurally dead past 24h.
  //   - age in [720, 1440) AND IN RANGE → keep running (ZINC-type winner tail).
  // OOR here is the paper price-band proxy (mirrors the OOR block below): the
  // position is OOR when |price − entry| / entry > OOR_BAND_PCT (25%). FAIL-SAFE:
  // missing/non-finite age OR price → skip the gate (never force-close on a guess).
  // BLUECHIP-AWARE: structure ready for a longer/exempt window once bluechip paper
  // trades carry an is_bluechip flag. Reversibility: maxHoldMinutes=0 → legacy.
  const maxHoldMin = mgmt.maxHoldMinutes;
  if (Number.isFinite(maxHoldMin) && maxHoldMin > 0 && trade.opened_at) {
    const openedMs = new Date(trade.opened_at).getTime();
    if (Number.isFinite(openedMs)) {
      const heldMin = (Date.now() - openedMs) / 60000;
      if (heldMin >= maxHoldMin) {
        return {
          action: "MAX_HOLD_EXPIRED",
          reason: `held ${heldMin.toFixed(0)}m exceeds maxHold ${maxHoldMin}m — forced close (max_hold_hard)`,
        };
      }
      const oorLimit = Math.min(
        Number.isFinite(Number(mgmt.maxHoldOorMinutes))
          ? Number(mgmt.maxHoldOorMinutes)
          : maxHoldMin / 2,
        maxHoldMin,
      );
      if (heldMin >= oorLimit) {
        // Paper OOR proxy: price deviation from entry beyond the 25% band.
        const e = Number(trade.entry_price);
        const c = Number(snapshot.price);
        if (Number.isFinite(e) && e > 0 && Number.isFinite(c) && c > 0) {
          const devPct = Math.abs(((c - e) / e) * 100);
          if (devPct > 25) {
            return {
              action: "MAX_HOLD_EXPIRED",
              reason: `held ${heldMin.toFixed(0)}m >= ${oorLimit}m AND out-of-range (dev ${devPct.toFixed(1)}%) — forced close (max_hold_oor)`,
            };
          }
        }
        // in-range past oorLimit but under hard limit → fall through (tail).
      }
    }
  }

  // Vega fix #1 — exit DECISION metric is the fee-inclusive net economic
  // position (price proxy + fees earned − IL), NOT raw price. This is the
  // root-cause fix for the 1:2 loss/win asymmetry: SL/TP/trailing/partial/
  // velocity/drawdown all now read where the position TRULY sits net of fees.
  // FAIL-SAFE (anti-pattern #2): if fee_inclusive_pnl_pct is null/non-finite
  // (missing fees/IL data) we fall back to the price proxy — we never assume
  // fees are large, and the stop loss still fires. NOTE: paper IL is naive 0%
  // (computeFeeInclusivePnl), so paper fee-inclusive is OPTIMISTIC; live uses
  // real IL via derived PnL. Reversibility: feeInclusiveExitEnabled=false →
  // decisions revert to price-only. OOR (below) stays a price-deviation proxy.
  // NOTE: guard null/undefined BEFORE Number() — Number(null) === 0 would
  // silently treat "no fee data" as a real 0% position (anti-pattern #2).
  const rawFeeInclusive = snapshot.fee_inclusive_pnl_pct;
  const feeInclusive = rawFeeInclusive == null ? NaN : Number(rawFeeInclusive);
  const priceProxyPnl = Number(snapshot.price_proxy_pnl_pct);
  const useFeeInclusive =
    config.internalAgents?.feeInclusiveExitEnabled !== false &&
    Number.isFinite(feeInclusive);
  const pnlPct = useFeeInclusive ? feeInclusive : priceProxyPnl;
  if (Number.isFinite(pnlPct)) {
    // Track peak for trailing TP
    if (trade.peak_pnl_pct == null || pnlPct > trade.peak_pnl_pct) {
      trade.peak_pnl_pct = pnlPct;
    }

    // ── Give-back protection (Andromeda Track-B PROFIT, paper mirror) ───────
    // Same rule as state.js#updatePnlAndCheckExits: once the peak >= giveBackPeakPct
    // (4%) but BELOW the trailing arm (trailingTriggerPct), a decay of >=
    // giveBackDropPct (2%) from peak closes in profit — locks ~+3% instead of the
    // reptilecoin round-trip (+5.43% → −0.96%). COMPLEMENTS trailing (owns the
    // sub-trailing zone; ceiling ∞ when trailing disabled). HARD-guarded to
    // pnlPct > 0 → never shields a loss / SL untouched. Runs BEFORE break-even so
    // the harvest lands higher. FAIL-SAFE: non-finite peak/PnL → skip. Default OFF.
    if (
      mgmt.giveBackProtectEnabled === true &&
      Number.isFinite(pnlPct) &&
      pnlPct > 0 &&
      trade.peak_pnl_pct != null &&
      Number.isFinite(Number(trade.peak_pnl_pct))
    ) {
      const peak = Number(trade.peak_pnl_pct);
      const armPct = Number(mgmt.giveBackPeakPct ?? 4);
      const dropPct = Number(mgmt.giveBackDropPct ?? 2);
      const ceil =
        mgmt.trailingTakeProfit && Number.isFinite(Number(mgmt.trailingTriggerPct))
          ? Number(mgmt.trailingTriggerPct)
          : Infinity;
      const gaveBack = peak - pnlPct;
      if (
        Number.isFinite(armPct) &&
        Number.isFinite(dropPct) &&
        dropPct > 0 &&
        peak >= armPct &&
        peak < ceil &&
        gaveBack >= dropPct
      ) {
        return {
          action: "GIVE_BACK_PROTECT",
          reason: `give_back_protect: peak ${peak.toFixed(2)}% → current ${pnlPct.toFixed(2)}% (gave back ${gaveBack.toFixed(2)}% >= ${dropPct}%, below trailing arm ${ceil === Infinity ? "∞" : ceil + "%"}) — harvesting before round-trip`,
        };
      }
    }

    // Vega EXIT-3 #1 — Break-even stop ARM (paper mirror). Once peak crosses
    // breakEvenArmPct, be_armed flips true (idempotent, never disarms) and the
    // effective floor ratchets UP to breakEvenStopPct. Default OFF.
    if (
      mgmt.breakEvenStopEnabled === true &&
      !trade.be_armed &&
      trade.peak_pnl_pct != null &&
      Number.isFinite(Number(trade.peak_pnl_pct)) &&
      Number(trade.peak_pnl_pct) >= Number(mgmt.breakEvenArmPct ?? 5)
    ) {
      trade.be_armed = true;
      trade.be_armed_at = new Date().toISOString();
      trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
      trade.notes.push(`break_even_armed: peak ${Number(trade.peak_pnl_pct).toFixed(2)}% >= ${mgmt.breakEvenArmPct ?? 5}% — floor → ${mgmt.breakEvenStopPct ?? 0}%`);
    }

    // Vega EXIT-3 #1 — Break-even stop (paper mirror). Runs BEFORE the fixed SL
    // so the HIGHER floor wins: an armed position that round-trips to the
    // break-even floor exits there instead of riding to -8%. Only TIGHTENS the
    // stop upward on a winner; never loosens the fixed SL below.
    if (
      mgmt.breakEvenStopEnabled === true &&
      trade.be_armed &&
      Number(pnlPct) <= Number(mgmt.breakEvenStopPct ?? 0)
    ) {
      return {
        action: "BREAK_EVEN_STOP",
        reason: `Break-even stop: net PnL ${pnlPct.toFixed(2)}% <= ${mgmt.breakEvenStopPct ?? 0}% after arming at peak ${Number(trade.peak_pnl_pct ?? 0).toFixed(2)}% — modal locked, NOT round-tripping to ${mgmt.stopLossPct}%`,
      };
    }

    // Stop loss
    if (mgmt.stopLossPct != null && pnlPct <= mgmt.stopLossPct) {
      return { action: "STOP_LOSS", reason: `Stop loss: PnL ${pnlPct.toFixed(2)}% <= ${mgmt.stopLossPct}%` };
    }
    // Take profit (basic)
    if (mgmt.takeProfitPct != null && pnlPct >= mgmt.takeProfitPct) {
      return { action: "TAKE_PROFIT", reason: `Take profit: PnL ${pnlPct.toFixed(2)}% >= ${mgmt.takeProfitPct}%` };
    }

    // Vega Item 2B — Partial TP scale-out (paper mirror). NOT a close: when
    // peak >= partialTpTriggerPct and not yet done, realize partialTpPct% of
    // the position by reducing amount_sol, mark fire-once, and DO NOT return an
    // exit. The remainder keeps running with trailing/velocity. Idempotent via
    // trade.partial_tp_done. SL/TP above already pre-empt (crash = full close).
    if (
      mgmt.partialTpEnabled !== false &&
      !trade.partial_tp_done &&
      trade.peak_pnl_pct != null &&
      trade.peak_pnl_pct >= (mgmt.partialTpTriggerPct ?? Infinity)
    ) {
      const pct = Number(mgmt.partialTpPct ?? 50);
      if (Number.isFinite(pct) && pct > 0 && pct < 100) {
        const orig = Number(trade.original_amount_sol ?? trade.amount_sol) || 0;
        const remaining = Number((Number(trade.amount_sol || 0) * (1 - pct / 100)).toFixed(6));
        trade.original_amount_sol = trade.original_amount_sol ?? orig;
        trade.amount_sol = Math.max(0, remaining);
        trade.partial_tp_done = true;
        trade.partial_tp_at = new Date().toISOString();
        trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
        trade.notes.push(`partial_tp: scaled out ${pct}% at peak ${trade.peak_pnl_pct.toFixed(2)}% (pnl ${pnlPct.toFixed(2)}%) — remainder ${trade.amount_sol} SOL`);
        log("paper", `Paper partial TP ${trade.pool_name}: scaled out ${pct}% at peak ${trade.peak_pnl_pct.toFixed(2)}%`);
        // fall through — no exit returned; remainder keeps running.
      }
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

    // Vega Item 6 — Velocity-drop exit (paper mirror). In profit + hard 1h
    // reversal (price_change_1h < -velocityDropPct AND net_buyers_1h < 0).
    // Precedence: after partial TP + trailing, before DRAWDOWN_RECOVERY/OOR.
    // Reversibility: velocityExitEnabled=false → silent skip.
    if (mgmt.velocityExitEnabled !== false && pnlPct > 0) {
      const pc1h = Number(snapshot.price_change_1h_pct);
      const nb1h = Number(snapshot.net_buyers_1h);
      if (
        Number.isFinite(pc1h) &&
        Number.isFinite(nb1h) &&
        pc1h < -(mgmt.velocityDropPct ?? 15) &&
        nb1h < 0
      ) {
        return {
          action: "VELOCITY_EXIT",
          reason: `Velocity exit: 1h price ${pc1h.toFixed(2)}% < -${mgmt.velocityDropPct ?? 15}% AND net_buyers_1h ${nb1h} < 0 while in profit (${pnlPct.toFixed(2)}%) — momentum reversal`,
        };
      }
    }

    // Vega EXIT-3 #2 — Fee-decay exit (paper mirror, the BIGGEST gap).
    // Community trigger #1: exit when fees slow down. Track current fee/TVL rate
    // (snapshot.fee_tvl_ratio) vs a per-trade BASELINE (lazily-captured first
    // post-warmup reading, else entry_fee_tvl_ratio). Exit when current collapses
    // below feeDecayThreshold × baseline (default 0.30) WHILE in profit — take
    // profit as fees die. HARD GUARD: in-profit only (pnlPct > 0); a loser is
    // owned by SL / break-even / OOR. Coordinated with VELOCITY_EXIT: velocity =
    // PRICE reversal, this = FEE-rate collapse (different inputs, no double-fire —
    // velocity returns first if both hit). FAIL-SAFE (anti-pattern #2): missing/
    // non-finite current rate OR no usable baseline → SKIP. Default OFF.
    if (mgmt.feeDecayExitEnabled === true && pnlPct > 0) {
      const warmupMin = Number(mgmt.feeDecayWarmupMinutes ?? 30);
      const minAgeMin = Number(mgmt.feeDecayMinAgeMinutes ?? 60);
      const threshold = Number(mgmt.feeDecayThreshold ?? 0.30);
      const curRate = Number(snapshot.fee_tvl_ratio);
      const openedMs = new Date(trade.opened_at).getTime();
      const ageMin = Number.isFinite(openedMs) ? (Date.now() - openedMs) / 60000 : NaN;

      // Resolve baseline: the deploy-time entry_fee_tvl_ratio is the PRIMARY
      // baseline (a real early reading). Only when it is missing/<=0 do we fall
      // back to a lazily-captured first post-warmup rate. Capturing only when no
      // entry baseline exists prevents the capture from poisoning the same-tick
      // check (capturing curRate then comparing curRate against it would never
      // fire).
      const entryBaseline =
        Number.isFinite(Number(trade.entry_fee_tvl_ratio)) && Number(trade.entry_fee_tvl_ratio) > 0
          ? Number(trade.entry_fee_tvl_ratio)
          : null;

      if (
        entryBaseline == null &&
        trade.fee_decay_baseline == null &&
        Number.isFinite(curRate) &&
        curRate > 0 &&
        Number.isFinite(ageMin) &&
        ageMin >= warmupMin
      ) {
        trade.fee_decay_baseline = curRate;
        trade.fee_decay_baseline_at = new Date().toISOString();
        trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
        trade.notes.push(`fee_decay_baseline: ${curRate}% fee/TVL at ${ageMin.toFixed(0)}m`);
      }

      const baseline =
        entryBaseline != null
          ? entryBaseline
          : Number.isFinite(Number(trade.fee_decay_baseline)) && Number(trade.fee_decay_baseline) > 0
            ? Number(trade.fee_decay_baseline)
            : null;

      if (
        baseline != null &&
        Number.isFinite(curRate) &&
        Number.isFinite(threshold) &&
        threshold > 0 &&
        Number.isFinite(minAgeMin) &&
        Number.isFinite(ageMin) &&
        ageMin >= minAgeMin &&
        curRate < baseline * threshold
      ) {
        return {
          action: "FEE_DECAY_EXIT",
          reason: `Fee-decay exit: fee/TVL ${curRate}% < ${(threshold * 100).toFixed(0)}% of baseline ${baseline}% (= ${(baseline * threshold).toFixed(3)}%) while in profit (${pnlPct.toFixed(2)}%) — fees slowed, taking profit`,
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
    const signedDeviationPct = ((cur - entry) / entry) * 100;
    const deviationPct = Math.abs(signedDeviationPct);
    const OOR_BAND_PCT = 25;
    // Vega FIX#1 — paper mirror of OOR direction. No active_bin in paper, so the
    // price-vs-entry sign IS the direction proxy: price above entry-band = UP
    // (token pumped), below = DOWN (dumped). Mirrors state.js#oorDirection.
    const directionalOn = mgmt.oorDirectionalExitEnabled === true;
    const paperDirection = signedDeviationPct > 0 ? "UP" : "DOWN";
    if (deviationPct > OOR_BAND_PCT) {
      if (!trade.out_of_range_since) trade.out_of_range_since = new Date().toISOString();
    } else {
      trade.out_of_range_since = null;
    }
    if (trade.out_of_range_since) {
      const minutesOOR = Math.floor((Date.now() - new Date(trade.out_of_range_since).getTime()) / 60000);
      const normalLimit = mgmt.outOfRangeWaitMinutes ?? 30;

      // ── Fast OOR-UP harvest (Andromeda Track-B PROFIT, paper mirror) ──────
      // Mirrors state.js#updatePnlAndCheckExits: an OOR-UP single-side-SOL position
      // is 100% idle SOL (zero fee accrual), so harvest FAST (default 3m ≈ one
      // management cycle of whipsaw tolerance) to FREE capital rather than parking
      // it for the generic 30m timer. Direction is the paper price-vs-entry sign
      // proxy (paperDirection), read INDEPENDENT of oorDirectionalExitEnabled (own
      // flag). Takes PRECEDENCE over the "ride the pump" hold below — real 12-trade
      // data refuted that hold for this instrument (OOR-UP is idle SOL, not an
      // appreciating token). CLOSES (never holds) so it cannot shield a loss —
      // STOP_LOSS + break-even already ran ABOVE this block on the fee-inclusive
      // net PnL. FAIL-SAFE (anti-pattern #2): non-finite timer → skip → legacy
      // timer / directional path owns it. Default OFF (oorUpFastExitEnabled).
      if (mgmt.oorUpFastExitEnabled === true && paperDirection === "UP") {
        const fastMin = Number(mgmt.oorUpFastExitMinutes ?? 3);
        if (Number.isFinite(fastMin) && fastMin >= 0 && minutesOOR >= fastMin) {
          return {
            action: "OOR_UP_FAST_HARVEST",
            reason: `oor_up_fast_harvest: OOR-UP ${minutesOOR}m >= ${fastMin}m — 100% idle SOL (zero fee accrual), harvesting to free capital`,
          };
        }
      }

      // OOR-UP + in-profit (fee-inclusive pnl already computed above) → ARM
      // trailing, do NOT hard-close on the OOR timer. Pump captured; trailing
      // drop / SL govern the exit. FAIL-SAFE: if flag off → legacy single-timer.
      if (directionalOn && paperDirection === "UP" && Number.isFinite(pnlPct) && pnlPct > 0) {
        if (trade.peak_pnl_pct == null || pnlPct > trade.peak_pnl_pct) trade.peak_pnl_pct = pnlPct;
        trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
        if (!trade.notes.includes("oor_up_trailing_armed")) {
          trade.notes.push("oor_up_trailing_armed");
          log("paper", `Paper OOR-UP in-profit ${trade.pool_name} (${pnlPct.toFixed(2)}%) — trailing armed, holding pump (Vega FIX#1)`);
        }
        return null; // no exit — ride the pump
      }

      // OOR-DOWN → faster cut timer; clamp to never exceed the normal limit.
      const downLimit = Math.min(
        Number(mgmt.outOfRangeWaitMinutesDown ?? normalLimit),
        Number(normalLimit),
      );
      const limit =
        directionalOn && paperDirection === "DOWN" && Number.isFinite(downLimit)
          ? downLimit
          : normalLimit;
      // Guard: never re-center an OOR-UP pump (paper mirror of live guard).
      const rebalanceAllowed = !(directionalOn && paperDirection === "UP");
      if (minutesOOR >= limit) {
        // Vega Item 9 — paper re-center mirror. High-organic + under cap +
        // flag on → re-center (NOT a close): reset OOR timer, bump count, keep
        // running. Mirrors live agents/rebalance.js keeping fee exposure on a
        // token that may re-enter range. Once maxRebalances is hit, fall
        // through to OUT_OF_RANGE (hard close). Flag default OFF → unchanged.
        const organic = Number(trade.entry_organic_score);
        const count = Number(trade.rebalance_count ?? 0);
        const maxRebalances = Number(mgmt.maxRebalances ?? 3);
        if (
          rebalanceAllowed &&
          mgmt.rebalanceOnOorEnabled === true &&
          Number.isFinite(organic) &&
          organic >= (mgmt.rebalanceOnOorMinOrganic ?? 80) &&
          Number.isFinite(count) &&
          count < maxRebalances
        ) {
          trade.rebalance_count = count + 1;
          trade.out_of_range_since = null; // re-centered → back in range
          trade.notes = Array.isArray(trade.notes) ? trade.notes : [];
          trade.notes.push(`paper_rebalance: re-centered (#${trade.rebalance_count}) after OOR ${minutesOOR}m at price ${cur} — organic ${organic} >= ${mgmt.rebalanceOnOorMinOrganic ?? 80}`);
          log("paper", `Paper re-center ${trade.pool_name}: rebalance #${trade.rebalance_count} after OOR ${minutesOOR}m`);
          return null; // no exit — remainder keeps running
        }
        return {
          action: "OUT_OF_RANGE",
          reason: directionalOn && paperDirection === "DOWN"
            ? `Out of range DOWN for ${minutesOOR}m (down-limit: ${limit}m) — token dumped, cutting fast (Vega FIX#1)`
            : `Out of range for ${minutesOOR}m (limit: ${limit}m)`,
        };
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

  // Vega fix #1 — TRUE realized SOL delta (paper). lp_pnl_pct (final_pnl_pct) is
  // PRICE-ONLY. Paper has no wallet, so simulate the exit: apply an exit-slippage
  // haircut + gas estimate to the price-proxy outcome and add fees earned. The
  // result is the SOL the operator would actually net — strictly <= lp_pnl_pct.
  // Additive; gated by config.internalAgents.realizedSolAccounting (default ON).
  if (config.internalAgents?.realizedSolAccounting !== false) {
    const rsd = computePaperRealizedSolDelta({
      amountSol: trade.amount_sol,
      lpPnlPct: trade.final_pnl_pct,
      feesClaimedSol: trade.fees_claimed_sol,
    });
    trade.lp_pnl_pct = trade.final_pnl_pct ?? null; // explicit label: price-only
    trade.realized_sol_delta = rsd.realized_sol_delta;
    trade.realized_sol_delta_pct = rsd.realized_sol_delta_pct;
    trade.realized_sol_method = rsd.method;
    trade.realized_sol_estimate = rsd.estimate;
  }
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
      lpPnlPct: trade.lp_pnl_pct ?? trade.final_pnl_pct ?? null,
      realizedSolDelta: trade.realized_sol_delta,
      realizedSolDeltaPct: trade.realized_sol_delta_pct,
      realizedSolEstimate: trade.realized_sol_estimate,
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
        // Vega 2026-06-23 — propagate the live-tracked peak so Lyra can analyze
        // trailing/exit timing offline (logging only, no new fetch).
        peak_pnl_pct: trade.peak_pnl_pct ?? null,
        // Vega fix #1 — carry the simulated realized SOL delta into the lessons
        // record so digest/snapshot read TRUE economics, not just price-only PnL.
        realized_sol_delta: trade.realized_sol_delta ?? null,
        realized_sol_delta_pct: trade.realized_sol_delta_pct ?? null,
        realized_sol_method: trade.realized_sol_method ?? null,
        realized_sol_estimate: trade.realized_sol_estimate ?? null,
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
