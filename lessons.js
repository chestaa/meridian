/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MAX_MANUAL_LESSON_LENGTH = 400;

// PIECE 2 — meaningful-profit bar (Lyra). A close counts a "win" in reporting
// only when its TRUE realized SOL delta (net of IL+slippage+gas) clears this.
// REPORTING ONLY — never gates exit/close/money. Reloadable via user-config.
const DEFAULT_MIN_MEANINGFUL_PROFIT_SOL = 0.005;

/**
 * Read the meaningful-profit bar from user-config.json (reloadable), with a
 * safe default. Pure read; never throws.
 * @returns {number}
 */
function meaningfulProfitBarSol() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const u = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      const v = Number(u.minMeaningfulProfitSol);
      if (Number.isFinite(v) && v >= 0) return v;
    }
  } catch { /* ignore — use default */ }
  return DEFAULT_MIN_MEANINGFUL_PROFIT_SOL;
}

/**
 * HONEST win test for a closed-position record (PIECE 2). Uses the TRUE realized
 * SOL delta when present (net of IL+slippage+gas): a win is realized_sol_delta
 * >= the meaningful bar — micro-profits below it are NOISE, not wins. Falls back
 * to LP-PnL sign only when the record predates realized-SOL accounting.
 * @param {object} r        - performance record
 * @param {number} barSol   - meaningful-profit bar in SOL
 * @returns {boolean}
 */
export function isMeaningfulWin(r, barSol = DEFAULT_MIN_MEANINGFUL_PROFIT_SOL) {
  const realized = Number(r?.realized_sol_delta);
  if (Number.isFinite(realized)) return realized >= barSol;
  // Legacy fallback — no realized figure on this record. LP-PnL sign.
  return Number(r?.pnl_usd ?? r?.pnl_pct ?? 0) > 0;
}

function normalizeLessonsData(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    lessons: Array.isArray(data.lessons) ? data.lessons : [],
    performance: Array.isArray(data.performance) ? data.performance : [],
  };
}

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return normalizeLessonsData(JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(normalizeLessonsData(data), null, 2));
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} [perf.apiPnlUsd]      - SDK/API realized price PnL (USD); preferred over recompute when finite
 * @param {number} [perf.apiPnlPct]      - SDK/API realized price PnL (%); preferred over recompute when finite
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  // ponytail: prefer the SDK/API realized figure (apiPnlUsd/apiPnlPct) when the
  // producer supplies it — that number is price-only by design (fees stay tracked
  // separately in fees_earned_usd / fees_earned_sol so fee income and price move
  // stay independently auditable). Fall back to the legacy value-delta recompute
  // (fee-inclusive) only when no API figure is present, preserving old behavior.
  const pnl_usd = Number.isFinite(perf.apiPnlUsd)
    ? perf.apiPnlUsd
    : (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = Number.isFinite(perf.apiPnlPct)
    ? perf.apiPnlPct
    : perf.initial_value_usd > 0
      ? (pnl_usd / perf.initial_value_usd) * 100
      : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  // PR-B — source distinguishes paper vs live closes. Defaults to "live" so
  // pre-existing records and the live close path stay backward-compatible.
  const source = perf.source === "paper" ? "paper" : "live";

  // Lyra — entry_features JOURNAL INTEGRITY (data-collection mode, 2026-07-10).
  // WHY: the money-path close sites (tools/dlmm.js recordPerformance calls) forward
  // tracked.volatility/fee_tvl_ratio/etc. but do NOT forward tracked.entry_features —
  // so the deploy-time market/token snapshot Vega captures would be DROPPED on close
  // and never joined to the realized outcome, making data-mode worthless. The journal
  // is Lyra's domain, so we resolve it here without touching any money/gate code:
  // prefer the value the producer passed, else read it from the live state record by
  // position address (positions persist with closed:true, never deleted, so the record
  // is still present at record time). FAIL-SAFE (anti-pattern #2): unknown → null,
  // NEVER fabricated. Paper closes (not in state.json) keep whatever perf carried.
  let entryFeatures = (perf.entry_features && typeof perf.entry_features === "object")
    ? perf.entry_features
    : null;
  if (!entryFeatures && perf.position) {
    try {
      const { getTrackedPosition } = await import("./state.js");
      const tracked = getTrackedPosition(perf.position);
      if (tracked?.entry_features && typeof tracked.entry_features === "object") {
        entryFeatures = tracked.entry_features;
      }
    } catch { /* ignore — journal still writes; entry_features stays null (honest gap) */ }
  }

  const entry = {
    ...perf,
    source,
    entry_features: entryFeatures ?? null,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  if (lesson) {
    void pushHiveLesson(lesson);
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  void pushHivePerformanceEvent({
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });

}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  // Lyra integrity fix: NEVER derive a lesson from a paper trade. Paper PnL is
  // fee-inclusive/optimistic and never touched the wallet — it poisoned the
  // "PREFER" lessons (SPCX-SOL paper +11.57% became a top lesson, then live
  // stop-lossed -10.8%). Only REAL closes teach the bot.
  if ((perf.source || "live") === "paper") return null;

  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Categorize outcome — WALLET-TRUTH first. A trade is a WIN only when its
  // realized SOL delta (net of IL+fees+gas) clears the meaningful bar, and a
  // LOSS only when it drops below it. This inverts the old fee-inclusive
  // pnl_pct signal that mislabeled slow-bleed-to-stop trades (100% in-range,
  // price walked straight down) as wins. Legacy records with no realized
  // figure fall back to the pnl_pct heuristic.
  const realized = realizedSol(perf);
  const bar = meaningfulProfitBarSol();
  const outcome = realized !== null
    ? (realized >= bar ? "good" : realized <= -bar ? "bad" : "neutral")
    : (perf.pnl_pct >= 5 ? "good"
      : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
      : perf.pnl_pct >= 0 ? "neutral"
      : perf.pnl_pct >= -5 ? "poor"
      : "bad");

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good" && realized !== null && realized > 0) {
      // 100%-in-range is a PREFER signal ONLY when paired with a positive
      // realized SOL delta. Range-efficiency alone selects the slow-bleed
      // profile: price walking straight DOWN through the range reads 100%
      // in-range yet loses money. Never reward in-range efficiency in isolation.
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, realized +${realized.toFixed(4)} SOL (PnL +${perf.pnl_pct}%).`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  // Lyra integrity fix: evolve thresholds ONLY from REAL closes. Paper trades
  // poisoned the evolution (fee-inclusive/optimistic PnL that never touched the
  // wallet). Exclude source==="paper" before any winner/loser math.
  const real = perfData.filter((p) => (p.source || "live") !== "paper");
  if (real.length < MIN_EVOLVE_POSITIONS) return null;

  // Winner/loser classification is WALLET-TRUTH: realized SOL delta (net of
  // IL+fees+gas), NOT fee-inclusive pnl_pct. A winner cleared the meaningful
  // profit bar; a loser dropped below it. Legacy records with no realized
  // figure fall back to the pnl_pct sign.
  const bar = meaningfulProfitBarSol();
  const winners = real.filter((p) => evolveIsWinner(p, bar));
  const losers  = real.filter((p) => evolveIsLoser(p, bar));

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. minFeeActiveTvlRatio ──────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  // (PR-C: maxVolatility evolution removed — config.js has no such key, and
  // volatility is positively gated in screening, never capped.)
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 2. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = real.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic           != null) s.minOrganic           = changes.minOrganic;

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${real.length} real positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

/**
 * Wallet-truth realized SOL delta for a performance record (net of IL+fees+gas),
 * or null when the record predates realized-SOL accounting. This is the ONLY
 * honest win/loss signal — pnl_pct is fee-inclusive and masks principal bleed.
 * @param {object} perf
 * @returns {number|null}
 */
function realizedSol(perf) {
  const v = Number(perf?.realized_sol_delta);
  return Number.isFinite(v) ? v : null;
}

/** evolveThresholds winner test — realized SOL clears the meaningful bar (wallet-truth); legacy fallback = pnl_pct>0. */
function evolveIsWinner(p, bar) {
  const r = realizedSol(p);
  if (r !== null) return r >= bar;
  return Number(p?.pnl_pct) > 0;
}

/** evolveThresholds loser test — realized SOL below the negative bar (wallet-truth); legacy fallback = pnl_pct<-5. */
function evolveIsLoser(p, bar) {
  const r = realizedSol(p);
  if (r !== null) return r <= -bar;
  return Number(p?.pnl_pct) < -5;
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  data.lessons.push(lesson);
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  // PIECE 2 — honest win count: realized SOL >= meaningful bar (NOISE excluded).
  // Re-read the raw records (filtered is projected) so realized_sol_delta survives.
  const bar = meaningfulProfitBarSol();
  const rawInWindow = p.filter((r) => r.recorded_at >= cutoff).slice(-limit);
  const wins = rawInWindow.filter((r) => isMeaningfulWin(r, bar)).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    win_bar_sol: bar,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}

/**
 * Trade journal for the operator (Sirius — /journal). Returns the most recent
 * `limit` CLOSED trades plus an honest summary, NOT time-windowed (unlike
 * getPerformanceHistory which is a 24h ops view).
 *
 * HONESTY (money-honesty fix): each row carries the TRUE realized SOL delta
 * (`realized_sol_delta`, net of IL+slippage+gas) when present — that is the
 * number Bro sees. We NEVER use the buggy wallet_delta. The pnl_pct shown is
 * the LP-PnL pct (price move on the position), realized_sol is the cash truth.
 * Win/loss/breakeven classification uses the meaningful-profit bar:
 *   - realized >=  bar      → win  (meaningful profit)
 *   - realized <= -bar      → loss (meaningful loss)
 *   - within ±bar           → breakeven (noise)
 * Legacy records with no realized figure fall back to pnl_usd sign.
 *
 * @param {object} opts
 * @param {number} opts.limit  - how many recent closes to return (default 10)
 * @returns {{ rows: Array, summary: object|null }}
 */
export function getTradeJournal({ limit = 10 } = {}) {
  const data = load();
  const p = data.performance;
  if (p.length === 0) return { rows: [], summary: null };

  const bar = meaningfulProfitBarSol();

  const classify = (r) => {
    const realized = Number(r?.realized_sol_delta);
    if (Number.isFinite(realized)) {
      if (realized >= bar) return "win";
      if (realized <= -bar) return "loss";
      return "breakeven";
    }
    // Legacy fallback — no realized SOL on record; use LP-PnL sign.
    const fallback = Number(r?.pnl_usd ?? 0);
    if (fallback > 0) return "win";
    if (fallback < 0) return "loss";
    return "breakeven";
  };

  // Whole-ledger honest summary (all closes, not just the displayed page).
  let netSol = 0;
  let netSolKnown = false;
  let netUsd = 0;
  let wins = 0;
  for (const r of p) {
    const realized = Number(r?.realized_sol_delta);
    if (Number.isFinite(realized)) { netSol += realized; netSolKnown = true; }
    netUsd += Number(r?.pnl_usd ?? 0);
    if (classify(r) === "win") wins += 1;
  }

  const summary = {
    total_trades: p.length,
    net_sol: netSolKnown ? Math.round(netSol * 10000) / 10000 : null,
    net_usd: Math.round(netUsd * 100) / 100,
    win_rate_pct: Math.round((wins / p.length) * 100),
    win_bar_sol: bar,
  };

  const rows = p.slice(-limit).reverse().map((r) => {
    const realized = Number(r?.realized_sol_delta);
    return {
      pool_name: r.pool_name || r.pool || "?",
      closed_at: r.recorded_at || null,
      pnl_pct: Number.isFinite(Number(r.pnl_pct)) ? Number(r.pnl_pct) : null,
      pnl_usd: Number.isFinite(Number(r.pnl_usd)) ? Number(r.pnl_usd) : null,
      realized_sol: Number.isFinite(realized) ? Math.round(realized * 10000) / 10000 : null,
      fees_earned_usd: Number.isFinite(Number(r.fees_earned_usd)) ? Number(r.fees_earned_usd) : null,
      fees_earned_sol: Number.isFinite(Number(r.fees_earned_sol)) ? Number(r.fees_earned_sol) : null,
      // Close reason surfaced for /journal (formatCloseReason maps it to plain
      // Indonesian, incl. Andromeda's oor_up_fast_harvest / give_back_protect
      // when they appear). null when the record predates reason capture.
      close_reason: r.close_reason || null,
      source: r.source === "paper" ? "paper" : "live",
      result: classify(r),
    };
  });

  return { rows, summary };
}
