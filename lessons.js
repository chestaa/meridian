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
const PROPOSALS_FILE = path.join(__dirname, "threshold-proposals.json");
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MAX_MANUAL_LESSON_LENGTH = 400;
const LESSON_ARCHIVE_CAP = 400;   // merged/capped lessons are ARCHIVED, never deleted
const PROPOSAL_HISTORY_CAP = 50;

// ─── Lyra — dimension-aware bucket-aggregate learning defaults ───────────────
// Bro requirement #6: "selalu belajar dari kesalahan, jangan terus mengulang,
// kita punya data, jadikan training." The old engine pushed ONE PROSE lesson PER
// TRADE (70 lessons, 24% near-duplicate, no counts, no EV) and auto-applied
// threshold changes from an all-history min/max comparator (a self-locking
// ratchet). This engine replaces per-trade prose with ONE ROW PER BUCKET carrying
// n + realized-SOL EV, and makes threshold evolution PROPOSE-ONLY.
const DEFAULT_LEARNING = Object.freeze({
  bucketLessonsEnabled: true,  // bucket-aggregate rows replace per-trade prose
  bucketLessonMinN:     3,     // a bucket needs >= n closes before it becomes a lesson
  bucketLessonCap:      12,    // max bucket rows injected (prompt-bloat guard)
  lessonTotalCap:       60,    // hard cap on ACTIVE lessons (overflow → lesson_archive)
  bucketSignalMinN:     10,    // below this a bucket verdict is THIN (never "SIGNAL")
  bucketNoiseT:         2,     // |t| below this = NOISE (not a real edge)
  // evolveAutoApply — Lyra VETO GUARD. FALSE = threshold evolution is
  // PROPOSE-ONLY: proposals are queued to threshold-proposals.json + pushed to
  // Telegram, and NOTHING is written to user-config.json or the live config
  // object. Only Bro flips this (and a LOOSEN proposal additionally needs
  // Cassiopeia review). Never default this to true.
  evolveAutoApply:      false,
  evolveWindowN:        40,    // windowed comparator — most recent N real closes only
  evolveWinnerPercentile: 20,  // p20 of winners (robust low end) replaces all-history min
  evolveLoserPercentile:  80,  // p80 of losers (robust high end) replaces all-history max
  bucketProposalsEnabled: true, // bucket-EV-driven proposals (still propose-only)
});

/**
 * Learning-engine config, read from user-config.json at call time (reloadable,
 * same pattern as meaningfulProfitBarSol). Accepts either a nested `learning`
 * object or flat top-level keys. Never throws; unknown/invalid → default.
 * @returns {typeof DEFAULT_LEARNING}
 */
export function learningConfig() {
  const out = { ...DEFAULT_LEARNING };
  let u = {};
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) u = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) || {};
  } catch { /* ignore — defaults */ }
  const nested = (u.learning && typeof u.learning === "object") ? u.learning : {};
  for (const key of Object.keys(DEFAULT_LEARNING)) {
    const raw = nested[key] !== undefined ? nested[key] : u[key];
    if (raw === undefined || raw === null) continue;
    if (typeof DEFAULT_LEARNING[key] === "boolean") {
      if (typeof raw === "boolean") out[key] = raw;
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/**
 * Strict numeric coercion — null/undefined/""/booleans stay NULL instead of
 * coercing to 0 (anti-pattern #2: never fabricate a reading). Mirrors the
 * strictNumeric convention used across screening.js / journal.js.
 * @param {*} v
 * @returns {number|null}
 */
function strictNum(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
  // Spread FIRST so unknown top-level keys survive a save round-trip. The old
  // shape dropped everything except lessons/performance — which silently deleted
  // metadata (e.g. _lastEvolved) on every write. lesson_archive holds merged /
  // capped-out lessons: history is ARCHIVED, never deleted.
  return {
    ...data,
    lessons: Array.isArray(data.lessons) ? data.lessons : [],
    performance: Array.isArray(data.performance) ? data.performance : [],
    lesson_archive: Array.isArray(data.lesson_archive) ? data.lesson_archive : [],
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

// ─── exit_class — ONE enum derived from ~135 free-text close_reason variants ──
//
// The ledger's close_reason is operator/LLM prose ("⚡ Trailing TP: Stop loss:
// PnL -10.33% ≤ -10% — immediate close triggered"), so it can NEVER be grouped
// by string equality — 160 live closes produced 135 distinct strings. This maps
// the prose to a stable enum ONCE so outcomes become groupable.
//
// ORDERING IS LOAD-BEARING: "⚡ Trailing TP:" is a NOTIFICATION PREFIX that
// Andromeda prepends to EVERY exit (stop-loss, low-yield, OOR, harvest). Matching
// it first would misfile every loss as a take-profit. So the specific trigger is
// matched BEFORE the generic prefix.
//
// FAIL-SAFE (anti-pattern #2): no confident match → UNKNOWN. We would rather
// carry an honest UNKNOWN bucket than fabricate a class. Direction-less OOR
// timeouts (Rule 4 / max_hold_oor) map to OOR_TIMEOUT rather than OOR_DOWN —
// claiming a direction the text does not support would be a fabricated feature.
export const EXIT_CLASSES = Object.freeze({
  STOP_LOSS:      "STOP_LOSS",
  TRAILING_TP:    "TRAILING_TP",
  OOR_UP_HARVEST: "OOR_UP_HARVEST",
  OOR_DOWN:       "OOR_DOWN",
  OOR_TIMEOUT:    "OOR_TIMEOUT",
  LOW_YIELD:      "LOW_YIELD",
  PUMP_ABOVE:     "PUMP_ABOVE",
  MANUAL:         "MANUAL",
  UNKNOWN:        "UNKNOWN",
});

/**
 * Derive the exit_class enum from a free-text close_reason. Pure, total,
 * never throws.
 * @param {string|null|undefined} closeReason
 * @returns {string} one of EXIT_CLASSES
 */
export function classifyExitClass(closeReason) {
  if (typeof closeReason !== "string") return EXIT_CLASSES.UNKNOWN;
  const t = closeReason.toLowerCase().trim();
  if (!t) return EXIT_CLASSES.UNKNOWN;

  // 1. MANUAL — operator intervention (unambiguous, wins over everything).
  if (/user requested|\/close\b|manual(?:ly)? clos|closed by (?:the )?operator|operator clos/.test(t)) {
    return EXIT_CLASSES.MANUAL;
  }
  if (t === "manual" || t === "manual close") return EXIT_CLASSES.MANUAL;

  // 2. STOP_LOSS — hard downside cut. Checked before the trailing prefix.
  if (/stop[\s_-]?loss/.test(t)) return EXIT_CLASSES.STOP_LOSS;

  // 3. OOR_UP_HARVEST — Andromeda's idle-SOL harvest on a fast OOR-UP.
  if (/oor[_\s-]?up[_\s-]?fast[_\s-]?harvest|oor-up .*harvest|fast harvest|idle sol/.test(t)) {
    return EXIT_CLASSES.OOR_UP_HARVEST;
  }

  // 4. LOW_YIELD — fee velocity below the floor (Rule 5 / low-yield exit).
  if (/low[\s_]?yield|fee\/tvl\s*[\d.]+%?\s*<\s*min|fee_per_tvl(?:_24h)?\s*[\d.]+%?\s*(?:<|below)|fee decay|fee_decay/.test(t)) {
    return EXIT_CLASSES.LOW_YIELD;
  }

  // 5. TRAILING_TP — peak-armed give-back family (incl. break-even stop, which
  //    only arms AFTER a peak: same mechanism, so same bucket) + explicit TP.
  if (/peak\s*[+\-]?[\d.]+%?\s*(?:→|->)/.test(t)
      || /dropped\s*[\d.]+%\s*>=/.test(t)
      || /trailing[\s_]?tp\s*(?:triggered|:)?\s*peak/.test(t)
      || /trailing[\s_]?tp triggered/.test(t)
      || /break[\s-]?even stop/.test(t)
      || /take[\s_]?profit|\btp hit\b|profit target/.test(t)) {
    return EXIT_CLASSES.TRAILING_TP;
  }

  // 6. PUMP_ABOVE — price left the range UPWARD (Rule 3). Checked before the
  //    generic OOR match because these strings also say "out of range".
  if (/pumped far above range|pumped above range|above (?:the )?upper (?:bound|bin)|rule 3\b/.test(t)) {
    return EXIT_CLASSES.PUMP_ABOVE;
  }

  // 7. OOR_DOWN — OOR with EXPLICIT downside evidence only.
  if (/below (?:the )?lower (?:bound|bin)|price (?:fell|dropped|moved) below|oor[_\s-]?down|out of range (?:to the )?down/.test(t)) {
    return EXIT_CLASSES.OOR_DOWN;
  }

  // 8. OOR_TIMEOUT — direction-less OOR timeout / forced max-hold close.
  if (/out[\s-]?of[\s-]?range|\boor\b|rule 4\b|max[_\s]?hold/.test(t)) {
    return EXIT_CLASSES.OOR_TIMEOUT;
  }

  return EXIT_CLASSES.UNKNOWN;
}

// ─── Bucket dimensions ───────────────────────────────────────────────────────
// Bucket EDGES are frozen tables so the same definition drives (a) aggregation,
// (b) lesson text, and (c) threshold proposals — one source of truth.
// Volatility edges match Lyra's 39-real-trade EV study (the study that produced
// the minVolatility FLOOR: [0,2.5) was catastrophic, [3.5,4.5) was the best).
export const VOLATILITY_BUCKETS = Object.freeze([
  { key: "vol[0,2.5)",   min: 0,   max: 2.5 },
  { key: "vol[2.5,3.5)", min: 2.5, max: 3.5 },
  { key: "vol[3.5,4.5)", min: 3.5, max: 4.5 },
  { key: "vol4.5+",      min: 4.5, max: Infinity },
]);
export const FEE_TVL_BUCKETS = Object.freeze([
  { key: "fee[0,0.1)",   min: 0,    max: 0.1 },
  { key: "fee[0.1,0.2)", min: 0.1,  max: 0.2 },
  { key: "fee[0.2,0.4)", min: 0.2,  max: 0.4 },
  { key: "fee0.4+",      min: 0.4,  max: Infinity },
]);
// entry_direction — the pool's OWN 1h price move at deploy (entry_features
// .token_price_change_1h). Live ledger range: -3.7% … +32.1%.
export const ENTRY_DIRECTION_BUCKETS = Object.freeze([
  { key: "entry_down", min: -Infinity, max: -1 },
  { key: "entry_flat", min: -1,        max: 3 },
  { key: "entry_up",   min: 3,         max: 10 },
  { key: "entry_pump", min: 10,        max: Infinity },
]);
// regime — SOL 24h % at deploy (entry_features.sol_regime_24h_pct). REPORTING
// buckets only; the live market-regime GATE uses its own ±5% thresholds.
export const REGIME_BUCKETS = Object.freeze([
  { key: "regime_down", min: -Infinity, max: -1 },
  { key: "regime_flat", min: -1,        max: 1 },
  { key: "regime_up",   min: 1,         max: Infinity },
]);

function bucketOf(table, value) {
  const n = strictNum(value);
  if (n === null) return null;              // missing → unknown, NEVER a fake bucket
  for (const b of table) if (n >= b.min && n < b.max) return b.key;
  return null;
}

/** Volatility bucket key, or null when the reading is missing/unusable. */
export function volatilityBucket(v) {
  const n = strictNum(v);
  if (n === null || n < 0) return null;
  return bucketOf(VOLATILITY_BUCKETS, n);
}
/** fee/TVL bucket key, or null when the reading is missing/unusable. */
export function feeTvlBucket(v) {
  const n = strictNum(v);
  if (n === null || n < 0) return null;
  return bucketOf(FEE_TVL_BUCKETS, n);
}
/** entry_direction bucket from token_price_change_1h, or null when missing. */
export function entryDirectionBucket(v) {
  return bucketOf(ENTRY_DIRECTION_BUCKETS, v);
}
/** regime bucket from sol_regime_24h_pct, or null when missing. */
export function regimeBucket(v) {
  return bucketOf(REGIME_BUCKETS, v);
}

/**
 * All bucket dimensions for one closed-position record. entry_features is the
 * deploy-time snapshot Vega captures (write-only until now — nothing read it).
 * FAIL-SAFE: a missing/non-finite feature yields null for that dimension (the
 * record is then EXCLUDED from that dimension's aggregate and counted in
 * `unknown`), never a fabricated "flat"/"neutral" bucket.
 * @param {object} r - lessons.performance record
 * @returns {{volatility:string|null, fee_tvl:string|null, entry_direction:string|null, regime:string|null, exit_class:string}}
 */
export function recordDimensions(r) {
  const ef = (r && typeof r.entry_features === "object" && r.entry_features) ? r.entry_features : null;
  return {
    volatility:      volatilityBucket(r?.volatility),
    fee_tvl:         feeTvlBucket(r?.fee_tvl_ratio),
    entry_direction: entryDirectionBucket(ef?.token_price_change_1h),
    regime:          regimeBucket(ef?.sol_regime_24h_pct),
    exit_class:      classifyExitClass(r?.close_reason ?? r?.exit_class ?? null),
  };
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [], lesson_archive: [] };
  }
  try {
    return normalizeLessonsData(JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")));
  } catch {
    return { lessons: [], performance: [], lesson_archive: [] };
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
    // exit_class — derived ONCE from the free-text close_reason so the ledger is
    // groupable forever after (160 live closes had 135 distinct reason strings).
    // FAIL-SAFE: unrecognized → "UNKNOWN", never a guessed class.
    exit_class: classifyExitClass(perf.close_reason),
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // ── Learning write (Lyra bucket-aggregate engine) ────────────────────────
  // DEFAULT (bucketLessonsEnabled): the per-trade PROSE lesson is REPLACED by
  // dimension-aware bucket rows — one row per bucket carrying n + realized-SOL
  // EV, refreshed in place. That is the dedup fix: seeing the same pattern twice
  // increments a count instead of pushing a near-duplicate sentence (the old
  // path produced 70 lessons, 24% near-duplicate, with no counts and no EV).
  // Set learning.bucketLessonsEnabled=false in user-config.json to fall back to
  // the legacy per-trade prose derivation (fully reversible).
  const lc = learningConfig();
  const lesson = lc.bucketLessonsEnabled ? null : derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }
  if (lc.bucketLessonsEnabled) {
    try {
      const res = upsertBucketLessons(data, lc);
      log("lessons", `Bucket lessons refreshed: ${res.rows} row(s) (replaced ${res.replaced}, archived ${res.archived})`);
    } catch (e) {
      log("lessons_warn", `Bucket lesson refresh failed (journal still written): ${e.message}`);
    }
  }
  capLessons(data, lc.lessonTotalCap);

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
      // Cassiopeia — forward the TRUE realized SOL delta (net of IL+slippage+gas)
      // so the same-token-loss cooldown logs a real "-Y SOL" figure, not a USD proxy.
      // Optional plumbing: absent on legacy/paper records → cooldown falls back to
      // pnl_usd then pnl_pct sign (still fail-safe-inverse if none is finite).
      realized_sol_delta: entry.realized_sol_delta ?? perf.realized_sol_delta ?? null,
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
      // Only reachable when Bro has set learning.evolveAutoApply=true.
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    } else if (result?.queued) {
      log("evolve", `Threshold proposals queued (PROPOSE-ONLY, nothing applied): ${result.proposals.map((p) => `${p.key} ${p.current}→${p.proposed}`).join(", ")}`);
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

// ─── Bucket-Aggregate Learning (Lyra) ──────────────────────────
//
// ONE ROW PER BUCKET instead of one prose lesson per trade. Each row carries n +
// realized-SOL EV, so the same pattern seen twice INCREMENTS a count instead of
// pushing a near-duplicate sentence. Wallet-truth only: EV is computed from
// realized_sol_delta (net of IL + slippage + gas), NEVER from fee-inclusive
// pnl_pct (which mislabels slow-bleed-to-stop trades as wins).
//
// NEUTRAL BAND IS KEPT (spec #4): a close inside ±bar used to be DISCARDED (76%
// of records produced no lesson at all). Here it counts in n and contributes its
// realized delta to net/EV — it is only reported separately as `neutral`. Bigger
// n = better signal; we just never call a thin/noisy bucket an edge.

const MARGINAL_DIMENSIONS = Object.freeze(["volatility", "fee_tvl", "entry_direction", "regime", "exit_class"]);
// Pairs are the interaction the funnel actually turns on (e.g. Lyra's
// "vol[0,2.5) × entry_down" slow-bleed profile). Full cross-product would be
// sparse noise at n≈160, so only these are aggregated.
const PAIR_DIMENSIONS = Object.freeze([
  ["volatility", "entry_direction"],
  ["exit_class", "entry_direction"],
  ["volatility", "fee_tvl"],
  ["exit_class", "regime"],
]);

function dimValue(dims, name) {
  const v = dims?.[name] ?? null;
  // UNKNOWN exit_class is an honest gap, not a bucket → excluded like a null.
  if (name === "exit_class" && v === EXIT_CLASSES.UNKNOWN) return null;
  return v ?? null;
}

function bucketKeyOf(dimObj) {
  return Object.keys(dimObj).sort().map((k) => `${k}=${dimObj[k]}`).join("|");
}

function stddev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const m = avg(values);
  const variance = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Aggregate closed-position records into dimension-aware buckets with realized-SOL EV.
 *
 * @param {Array}  records         - lessons.performance rows
 * @param {object} [opts]
 * @param {boolean} [opts.includePaper=false] - paper closes NEVER teach by default
 * @param {number} [opts.bar]                 - meaningful-profit bar (SOL)
 * @param {number} [opts.signalMinN]          - below this a verdict is THIN
 * @param {number} [opts.noiseT]              - |t| below this is NOISE
 * @returns {{rows:Array, evaluated:number, skipped:object, unknown:object, bar:number}}
 */
export function aggregateBuckets(records, opts = {}) {
  const lc = learningConfig();
  const bar = Number.isFinite(opts.bar) ? opts.bar : meaningfulProfitBarSol();
  const signalMinN = Number.isFinite(opts.signalMinN) ? opts.signalMinN : lc.bucketSignalMinN;
  const noiseT = Number.isFinite(opts.noiseT) ? opts.noiseT : lc.bucketNoiseT;
  const includePaper = opts.includePaper === true;

  const acc = new Map();
  const skipped = { paper: 0, no_realized_sol: 0 };
  const unknown = {};
  let evaluated = 0;

  const bump = (dimObj, realized, r) => {
    const key = bucketKeyOf(dimObj);
    let row = acc.get(key);
    if (!row) {
      row = { key, dims: { ...dimObj }, n: 0, wins: 0, losses: 0, neutral: 0, net_sol: 0, samples: [], last_seen: null, pools: new Set() };
      acc.set(key, row);
    }
    row.n += 1;
    row.net_sol += realized;
    row.samples.push(realized);
    if (realized >= bar) row.wins += 1;
    else if (realized <= -bar) row.losses += 1;
    else row.neutral += 1;                       // NEUTRAL BAND KEPT, not discarded
    const ts = r?.recorded_at || r?.closed_at || null;
    if (ts && (!row.last_seen || ts > row.last_seen)) row.last_seen = ts;
    if (r?.pool_name) row.pools.add(r.pool_name);
  };

  for (const r of Array.isArray(records) ? records : []) {
    if (!includePaper && (r?.source || "live") === "paper") { skipped.paper += 1; continue; }
    const realized = strictNum(r?.realized_sol_delta);
    if (realized === null) { skipped.no_realized_sol += 1; continue; } // EV needs wallet-truth
    evaluated += 1;

    const dims = recordDimensions(r);
    for (const d of MARGINAL_DIMENSIONS) {
      const v = dimValue(dims, d);
      if (v === null) { unknown[d] = (unknown[d] || 0) + 1; continue; }
      bump({ [d]: v }, realized, r);
    }
    for (const [a, b] of PAIR_DIMENSIONS) {
      const va = dimValue(dims, a);
      const vb = dimValue(dims, b);
      const pairName = `${a}×${b}`;
      if (va === null || vb === null) { unknown[pairName] = (unknown[pairName] || 0) + 1; continue; }
      bump({ [a]: va, [b]: vb }, realized, r);
    }
  }

  const rows = [...acc.values()].map((row) => {
    const ev = row.net_sol / row.n;
    const sd = stddev(row.samples);
    const t = (sd && sd > 0) ? ev / (sd / Math.sqrt(row.n)) : null;
    const verdict = row.n < signalMinN ? "THIN"
      : (t === null || Math.abs(t) < noiseT) ? "NOISE"
      : "SIGNAL";
    return {
      key: row.key,
      dims: row.dims,
      dimension: Object.keys(row.dims).sort().join("×"),
      n: row.n,
      wins: row.wins,
      losses: row.losses,
      neutral: row.neutral,
      wr_pct: round((row.wins / row.n) * 100, 1),
      net_sol: round(row.net_sol, 6),
      ev_sol: round(ev, 6),
      sd_sol: sd === null ? null : round(sd, 6),
      t_stat: t === null ? null : round(t, 2),
      verdict,
      material: verdict === "SIGNAL",
      pools: [...row.pools].slice(0, 5),
      last_seen: row.last_seen,
    };
  }).sort((a, b) => Math.abs(b.net_sol) - Math.abs(a.net_sol) || b.n - a.n);

  return { rows, evaluated, skipped, unknown, bar };
}

const DIM_LABEL = Object.freeze({
  volatility: "vol", fee_tvl: "fee/TVL", entry_direction: "entry", regime: "regime", exit_class: "exit",
});

function dimsText(dims) {
  return Object.keys(dims).sort().map((k) => dims[k]).join(" × ");
}

function bucketTags(dims) {
  const tags = ["bucket", "ev"];
  if (dims.volatility)      tags.push("screening", "volatility");
  if (dims.fee_tvl)         tags.push("screening", "fees");
  if (dims.entry_direction) tags.push("entry", "screening");
  if (dims.regime)          tags.push("screening", "regime");
  if (dims.exit_class) {
    tags.push("close", "management");
    if (/OOR/.test(dims.exit_class)) tags.push("oor");
    if (dims.exit_class === EXIT_CLASSES.STOP_LOSS) tags.push("risk");
  }
  return [...new Set(tags)];
}

/**
 * Render one aggregate row as a lesson object. The rule text is machine-shaped
 * so the LLM (and boss-report) can read n / EV / verdict without prose parsing.
 * @param {object} row - aggregateBuckets row
 * @param {number} bar - meaningful-profit bar
 */
function bucketRowToLesson(row, bar) {
  const evStr = `${row.ev_sol >= 0 ? "+" : ""}${row.ev_sol.toFixed(4)}`;
  const netStr = `${row.net_sol >= 0 ? "+" : ""}${row.net_sol.toFixed(4)}`;
  const signal = row.verdict === "SIGNAL";
  // TWO SEPARATE questions, reported separately (spec #4 material-vs-noise):
  //   1. STATISTICAL: is EV distinguishable from zero?  → verdict (THIN/NOISE/SIGNAL)
  //   2. ECONOMIC: is it big enough to care about?      → micro flag vs the
  //      meaningful-profit bar. An EV of +0.0008 SOL/trade can be statistically
  //      solid and still economically trivial; saying "PREFER" without the
  //      micro tag would overstate it.
  const micro = Math.abs(row.ev_sol) < bar;
  const outcome = signal
    ? (row.ev_sol < 0 ? "bad" : "good")
    : (row.ev_sol >= bar ? "good" : row.ev_sol <= -bar ? "bad" : "neutral");
  const advice = !signal
    ? "WATCH (not significant yet)"
    : `${row.ev_sol < 0 ? "AVOID" : "PREFER"}${micro ? " (micro-EV — statistically real, economically small)" : ""}`;
  const confidence = signal ? (micro ? 0.6 : 0.8) : row.verdict === "NOISE" ? 0.4 : 0.25;
  return {
    id: `bucket:${row.key}`,
    bucketKey: row.key,
    sourceType: "bucket_aggregate",
    outcome,
    rule: `EV-BUCKET ${dimsText(row.dims)} — n=${row.n}, EV ${evStr} SOL/trade, net ${netStr} SOL, W${row.wins}/L${row.losses}/N${row.neutral} (WR ${row.wr_pct}%), ${row.verdict}${row.t_stat === null ? "" : ` t=${row.t_stat}`} → ${advice}`,
    tags: bucketTags(row.dims),
    dims: row.dims,
    dimension: row.dimension,
    n: row.n,
    ev_sol: row.ev_sol,
    net_sol: row.net_sol,
    wins: row.wins,
    losses: row.losses,
    neutral: row.neutral,
    wr_pct: row.wr_pct,
    sd_sol: row.sd_sol,
    t_stat: row.t_stat,
    verdict: row.verdict,
    material: row.material && !micro,   // material = statistically real AND economically non-trivial
    statistically_material: row.material,
    micro_ev: micro,
    confidence,
    example_pools: row.pools,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_close_at: row.last_seen,
  };
}

/**
 * Build the bucket-aggregate lesson set from performance records.
 * Ranked by MONEY MOVED (|net_sol|) so the prompt sees the buckets that actually
 * cost/earned SOL, then hard-capped (prompt-bloat guard).
 * @param {Array} records
 * @param {object} [opts] - { minN, cap, bar, includePaper }
 * @returns {Array} lesson objects
 */
export function buildBucketLessons(records, opts = {}) {
  const lc = learningConfig();
  const minN = Number.isFinite(opts.minN) ? opts.minN : lc.bucketLessonMinN;
  const cap  = Number.isFinite(opts.cap)  ? opts.cap  : lc.bucketLessonCap;
  const { rows, bar } = aggregateBuckets(records, opts);
  return rows
    .filter((r) => r.n >= minN)
    .sort((a, b) => {
      // SIGNAL buckets first, then by money moved, then by n.
      const rank = (x) => (x.verdict === "SIGNAL" ? 2 : x.verdict === "NOISE" ? 1 : 0);
      return rank(b) - rank(a) || Math.abs(b.net_sol) - Math.abs(a.net_sol) || b.n - a.n;
    })
    .slice(0, Math.max(0, cap))
    .map((r) => bucketRowToLesson(r, bar));
}

/**
 * Upsert bucket lessons into a lessons-data object. THIS IS THE DEDUP FIX: a
 * bucket that is seen again is REPLACED IN PLACE (its n increments) — we never
 * push a second lesson for the same bucket. created_at of the first observation
 * is preserved so the row keeps its age; a revision counter records how many
 * times the row was refreshed. Rows that fall out of the cap are ARCHIVED.
 * @param {object} data - { lessons, performance, lesson_archive }
 * @param {object} [opts]
 * @returns {{rows:number, replaced:number, archived:number}}
 */
export function upsertBucketLessons(data, opts = {}) {
  const fresh = buildBucketLessons(data?.performance || [], opts);
  const existing = (data.lessons || []).filter((l) => l?.sourceType === "bucket_aggregate");
  const byKey = new Map(existing.map((l) => [l.bucketKey, l]));

  for (const row of fresh) {
    const prev = byKey.get(row.bucketKey);
    if (prev) {
      row.created_at = prev.created_at || row.created_at;
      row.revision = (Number(prev.revision) || 0) + 1;
      if (prev.pinned) row.pinned = true;
    } else {
      row.revision = 0;
    }
  }

  const freshKeys = new Set(fresh.map((r) => r.bucketKey));
  const dropped = existing.filter((l) => !freshKeys.has(l.bucketKey));
  data.lessons = (data.lessons || []).filter((l) => l?.sourceType !== "bucket_aggregate").concat(fresh);
  if (dropped.length) {
    data.lesson_archive = [...(data.lesson_archive || []), ...dropped.map((l) => ({ ...l, archived_at: new Date().toISOString(), archived_reason: "bucket_row_superseded" }))].slice(-LESSON_ARCHIVE_CAP);
  }
  return { rows: fresh.length, replaced: existing.length, archived: dropped.length };
}

/**
 * Cap the ACTIVE lesson list so the prompt can't bloat. Nothing is deleted:
 * overflow moves to data.lesson_archive. Pinned + bucket-aggregate rows are
 * always kept; the rest are kept newest-first.
 * @param {object} data
 * @param {number} cap
 * @returns {{active:number, archived:number}}
 */
export function capLessons(data, cap) {
  const limit = Number.isFinite(cap) ? cap : learningConfig().lessonTotalCap;
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];
  if (!Number.isFinite(limit) || limit <= 0 || lessons.length <= limit) {
    return { active: lessons.length, archived: 0 };
  }
  const keepAlways = lessons.filter((l) => l?.pinned || l?.sourceType === "bucket_aggregate");
  const rest = lessons
    .filter((l) => !(l?.pinned || l?.sourceType === "bucket_aggregate"))
    .sort((a, b) => String(b?.created_at || "").localeCompare(String(a?.created_at || "")));
  const budget = Math.max(0, limit - keepAlways.length);
  const kept = rest.slice(0, budget);
  const overflow = rest.slice(budget);
  data.lessons = [...keepAlways, ...kept];
  if (overflow.length) {
    data.lesson_archive = [...(data.lesson_archive || []), ...overflow.map((l) => ({ ...l, archived_at: new Date().toISOString(), archived_reason: "lesson_cap_overflow" }))].slice(-LESSON_ARCHIVE_CAP);
  }
  return { active: data.lessons.length, archived: overflow.length };
}

// ─── Legacy lesson de-duplication (merge-with-count) ──────────────────────────

/**
 * Dimension-aware duplicate signature for a LEGACY prose lesson. Numbers and
 * pool names are dropped; what remains is the verb + outcome + exit_class +
 * volatility bucket + fee bucket. Two "FAILED: <pool>, volatility=2.9,
 * fee_tvl_ratio=0.08 → PnL -6.2%" lessons from different pools in the same
 * buckets collapse to ONE row with a count.
 * @param {object} lesson
 * @returns {string}
 */
export function lessonDedupSignature(lesson) {
  if (!lesson || typeof lesson !== "object") return "unknown";
  const rule = String(lesson.rule || "");
  const verb = (rule.match(/^\s*(AVOID|PREFER|WORKED|FAILED)\b/i)?.[1] || "OTHER").toUpperCase();
  const ctx = String(lesson.context || rule);
  const pick = (re) => { const m = ctx.match(re); return m ? m[1] : null; };
  const vol = volatilityBucket(pick(/volatility=([\d.]+)/)) || "vol_unknown";
  const fee = feeTvlBucket(pick(/fee_tvl_ratio=([\d.]+)/)) || "fee_unknown";
  const exit = classifyExitClass(lesson.close_reason || rule);
  return [verb, String(lesson.outcome || "?"), exit, vol, fee].join("|");
}

/**
 * Pure consolidation of a lesson list. Only derived PROSE lessons
 * (sourceType==="performance") are merged; pinned / manual / config_change /
 * bucket_aggregate rows are untouched. History is preserved: the merged
 * duplicates are RETURNED for archiving (never dropped on the floor) and the
 * canonical row records merged_count + merged_ids.
 * @param {Array} lessons
 * @returns {{lessons:Array, archived:Array, groups:number, merged:number}}
 */
export function consolidateLessonList(lessons) {
  const list = Array.isArray(lessons) ? lessons : [];
  const mergeable = list.filter((l) => l && l.sourceType === "performance" && !l.pinned);
  const untouched = list.filter((l) => !(l && l.sourceType === "performance" && !l.pinned));

  const groups = new Map();
  for (const l of mergeable) {
    const sig = lessonDedupSignature(l);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(l);
  }

  const merged = [];
  const archived = [];
  for (const [sig, group] of groups) {
    const sorted = [...group].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    const canonical = { ...sorted[0] };
    if (group.length === 1) { merged.push(canonical); continue; }
    const dupes = sorted.slice(1);
    const baseRule = String(canonical.rule || "").replace(/^\[×\d+ obs\]\s*/, "");
    canonical.rule = `[×${group.length} obs] ${baseRule}`;
    canonical.merged_count = (Number(canonical.merged_count) || 1) + dupes.length;
    canonical.merged_ids = [...new Set([...(canonical.merged_ids || []), ...dupes.map((d) => d.id)])];
    canonical.merged_signature = sig;
    canonical.confidence = Math.max(...group.map((g) => Number(g.confidence) || 0));
    canonical.updated_at = sorted[sorted.length - 1].created_at || canonical.created_at;
    merged.push(canonical);
    for (const d of dupes) {
      archived.push({ ...d, archived_at: new Date().toISOString(), archived_reason: "duplicate_merged", merged_into: canonical.id, merged_signature: sig });
    }
  }

  return {
    lessons: [...untouched, ...merged].sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || ""))),
    archived,
    groups: groups.size,
    merged: archived.length,
  };
}

/**
 * Consolidate the on-disk lesson list (merge-with-count) and optionally rebuild
 * the bucket rows. Safe to run repeatedly (idempotent).
 * @param {object} [opts]
 * @param {boolean} [opts.apply=true]         - false = dry-run summary only
 * @param {boolean} [opts.rebuildBuckets=true]
 * @returns {object} summary
 */
export function consolidateLessons({ apply = true, rebuildBuckets = true } = {}) {
  const data = load();
  const before = data.lessons.length;
  const res = consolidateLessonList(data.lessons);
  const summary = {
    before,
    after_merge: res.lessons.length,
    groups: res.groups,
    duplicates_merged: res.merged,
    applied: !!apply,
  };
  if (!apply) return summary;

  data.lessons = res.lessons;
  data.lesson_archive = [...(data.lesson_archive || []), ...res.archived].slice(-LESSON_ARCHIVE_CAP);
  if (rebuildBuckets && learningConfig().bucketLessonsEnabled) {
    summary.buckets = upsertBucketLessons(data);
  }
  summary.capped = capLessons(data, learningConfig().lessonTotalCap);
  summary.after = data.lessons.length;
  summary.archive_size = (data.lesson_archive || []).length;
  save(data);
  log("lessons", `Consolidated lessons: ${before} → ${summary.after} (merged ${res.merged}, archived kept)`);
  return summary;
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

// Risk gates — Cassiopeia's domain. A proposal touching any of these needs her
// review; a proposal that LOOSENS one additionally needs Bro's explicit decision
// (Lyra never lets the learning loop widen a risk gate on its own).
const RISK_GATE_KEYS = Object.freeze({
  minVolatility:        { kind: "floor",   owner: "Cassiopeia" },
  minOrganic:           { kind: "floor",   owner: "Cassiopeia" },
  minFeeActiveTvlRatio: { kind: "floor",   owner: "Cassiopeia" },
  minMcap:              { kind: "floor",   owner: "Cassiopeia" },
  signalMinMcap:        { kind: "floor",   owner: "Cassiopeia" },
  minHolders:           { kind: "floor",   owner: "Cassiopeia" },
  maxPositions:         { kind: "ceiling", owner: "Vega" },
});

/**
 * Does moving `key` from current → proposed LOOSEN the gate?
 * For a floor (minX) a DECREASE is looser; for a ceiling (maxX) an INCREASE is looser.
 * Unknown keys are treated conservatively as LOOSENING when they move at all in
 * the permissive direction is unknowable → returns false only for a clear tighten.
 * @returns {boolean}
 */
export function isLooseningChange(key, current, proposed) {
  const c = strictNum(current);
  const p = strictNum(proposed);
  if (c === null || p === null || c === p) return false;
  const meta = RISK_GATE_KEYS[key];
  if (meta?.kind === "ceiling") return p > c;
  if (meta?.kind === "floor")   return p < c;
  // Unknown key: /^max/ behaves like a ceiling, /^min/ like a floor.
  if (/^max/i.test(key)) return p > c;
  if (/^min/i.test(key)) return p < c;
  return false;
}

function makeProposal({ key, current, proposed, rationale, evidence }) {
  const loosening = isLooseningChange(key, current, proposed);
  const isRiskGate = Object.prototype.hasOwnProperty.call(RISK_GATE_KEYS, key);
  return {
    key,
    current,
    proposed,
    direction: loosening ? "LOOSEN" : "TIGHTEN",
    risk_gate: isRiskGate,
    owner: RISK_GATE_KEYS[key]?.owner || "Polaris",
    // Every LOOSEN of a risk gate is Bro-approval-gated (Lyra VETO guard);
    // tightening a risk gate still needs Cassiopeia's eyes (dormancy risk).
    requires_bro_approval: loosening,
    requires_cassiopeia_review: isRiskGate,
    approval_note: loosening
      ? "REQUIRES BRO APPROVAL + Cassiopeia review (loosens a risk gate)"
      : (isRiskGate ? "Cassiopeia review (risk gate — dormancy check)" : "informational"),
    rationale,
    evidence,
  };
}

/**
 * Compute threshold PROPOSALS from closed-position performance. PURE — reads no
 * files and writes nothing (the caller decides what to do with the proposals).
 *
 * Two integrity changes vs the old evolveThresholds comparator:
 *  1. WINDOWED — only the most recent `evolveWindowN` real closes are compared.
 *     The old code used all-history Math.min/Math.max, which built a SELF-LOCKING
 *     RATCHET: one ancient winner's fee/TVL pinned the floor forever and the
 *     floor could only ever go up, never release when the regime changed.
 *  2. PERCENTILE — p20 of winners / p80 of losers instead of min/max, so a single
 *     outlier trade cannot move a live gate.
 *
 * @param {Array}  perfData - performance records
 * @param {Object} config   - live config (READ-ONLY here)
 * @param {Object} [opts]   - override learningConfig values
 * @returns {{proposals:Array, rationale:Object, window:Object} | null}
 */
export function computeThresholdProposals(perfData, config, opts = {}) {
  if (!Array.isArray(perfData) || perfData.length < MIN_EVOLVE_POSITIONS) return null;
  const lc = { ...learningConfig(), ...opts };

  // Lyra integrity fix: propose ONLY from REAL closes. Paper trades poisoned the
  // evolution (fee-inclusive/optimistic PnL that never touched the wallet).
  const real = perfData.filter((p) => (p.source || "live") !== "paper");
  if (real.length < MIN_EVOLVE_POSITIONS) return null;

  const windowN = Math.max(MIN_EVOLVE_POSITIONS, Number(lc.evolveWindowN) || DEFAULT_LEARNING.evolveWindowN);
  const window = real.slice(-windowN);

  // Winner/loser classification is WALLET-TRUTH: realized SOL delta (net of
  // IL+fees+gas), NOT fee-inclusive pnl_pct. Legacy records with no realized
  // figure fall back to the pnl_pct sign.
  const bar = meaningfulProfitBarSol();
  const winners = window.filter((p) => evolveIsWinner(p, bar));
  const losers  = window.filter((p) => evolveIsLoser(p, bar));
  if (!(winners.length >= 2 || losers.length >= 2)) return null;

  const s = config?.screening || {};
  const proposals = [];
  const rationale = {};
  const push = (p) => { proposals.push(p); rationale[p.key] = p.rationale; };
  const already = (key) => proposals.some((p) => p.key === key);

  // ── 1. minFeeActiveTvlRatio ─────────────────────────────────────────────
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = strictNum(s.minFeeActiveTvlRatio);

    if (current !== null && winnerFees.length >= 2) {
      const winnerLow = percentile(winnerFees, lc.evolveWinnerPercentile); // p20, robust
      if (winnerLow > current * 1.2) {
        const target  = winnerLow * 0.85; // stay slightly below the winner low end
        const rounded = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0).toFixed(2));
        if (rounded > current) {
          push(makeProposal({
            key: "minFeeActiveTvlRatio", current, proposed: rounded,
            rationale: `Winner p${lc.evolveWinnerPercentile} fee/TVL=${winnerLow.toFixed(3)} (window n=${window.length}) — raise floor ${current} → ${rounded}`,
            evidence: { winners: winnerFees.length, losers: loserFees.length, winner_percentile: round(winnerLow, 4), window_n: window.length },
          }));
        }
      }
    }

    if (current !== null && loserFees.length >= 2 && winnerFees.length > 0 && !already("minFeeActiveTvlRatio")) {
      const loserHigh = percentile(loserFees, lc.evolveLoserPercentile);   // p80
      const winnerLow = percentile(winnerFees, lc.evolveWinnerPercentile); // p20
      if (loserHigh < current * 1.5 && winnerLow > loserHigh) {
        const target  = loserHigh * 1.2;
        const rounded = Number(clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0).toFixed(2));
        if (rounded > current) {
          push(makeProposal({
            key: "minFeeActiveTvlRatio", current, proposed: rounded,
            rationale: `Loser p${lc.evolveLoserPercentile} fee/TVL=${loserHigh.toFixed(3)} below winner p${lc.evolveWinnerPercentile}=${winnerLow.toFixed(3)} (window n=${window.length}) — raise floor ${current} → ${rounded}`,
            evidence: { winners: winnerFees.length, losers: loserFees.length, loser_percentile: round(loserHigh, 4), window_n: window.length },
          }));
        }
      }
    }
  }

  // ── 2. minOrganic ───────────────────────────────────────────────────────
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = strictNum(s.minOrganic);

    if (current !== null && loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoser  = avg(loserOrganics);
      const avgWinner = avg(winnerOrganics);
      if (avgWinner - avgLoser >= 10) {
        const winnerLow = percentile(winnerOrganics, lc.evolveWinnerPercentile);
        const target = Math.max(winnerLow - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          push(makeProposal({
            key: "minOrganic", current, proposed: newVal,
            rationale: `Winner avg organic ${avgWinner.toFixed(0)} vs loser avg ${avgLoser.toFixed(0)}, winner p${lc.evolveWinnerPercentile}=${winnerLow.toFixed(0)} (window n=${window.length}) — raise ${current} → ${newVal}`,
            evidence: { winners: winnerOrganics.length, losers: loserOrganics.length, winner_percentile: round(winnerLow, 2), window_n: window.length },
          }));
        }
      }
    }
  }

  // ── 3. Bucket-EV-driven: minVolatility floor ────────────────────────────
  // The learning loop's own finding, expressed as a PROPOSAL: if the lowest
  // volatility bucket is a SIGNAL-grade money loser and the live floor still
  // admits it, propose lifting the floor to that bucket's ceiling. Never applied
  // automatically — this is a risk gate (Cassiopeia + anti-dormancy review).
  if (lc.bucketProposalsEnabled) {
    const current = strictNum(s.minVolatility);
    const { rows } = aggregateBuckets(window, { bar });
    const volRows = rows.filter((r) => r.dimension === "volatility");
    for (const b of VOLATILITY_BUCKETS) {
      if (!Number.isFinite(b.max)) continue;
      const row = volRows.find((r) => r.dims.volatility === b.key);
      if (!row || row.verdict !== "SIGNAL" || row.ev_sol >= 0) continue;
      if (current !== null && current >= b.max) continue;       // already excluded
      if (already("minVolatility")) continue;
      push(makeProposal({
        key: "minVolatility", current: current ?? 0, proposed: b.max,
        rationale: `Bucket ${b.key} is a SIGNAL-grade loser: n=${row.n}, EV ${row.ev_sol.toFixed(4)} SOL/trade, net ${row.net_sol.toFixed(4)} SOL (t=${row.t_stat}) — propose floor ${current ?? 0} → ${b.max}`,
        evidence: { bucket: b.key, n: row.n, ev_sol: row.ev_sol, net_sol: row.net_sol, t_stat: row.t_stat, verdict: row.verdict, window_n: window.length },
      }));
    }
  }

  return {
    proposals,
    rationale,
    window: { n: window.length, of_real: real.length, winners: winners.length, losers: losers.length, bar },
  };
}

/** Read the proposal queue file (never throws). */
export function readThresholdProposals() {
  try {
    if (fs.existsSync(PROPOSALS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        return {
          ...raw,
          pending: Array.isArray(raw.pending) ? raw.pending : [],
          history: Array.isArray(raw.history) ? raw.history : [],
        };
      }
    }
  } catch { /* ignore — treat as empty queue */ }
  return { updated_at: null, auto_apply: false, pending: [], history: [] };
}

/**
 * Queue proposals (PROPOSE-ONLY path). Writes threshold-proposals.json ONLY —
 * never user-config.json, never the live config object — and pushes a Telegram
 * notice for proposals that are NEW (same key+value is not re-notified, so the
 * 5-close cadence can't spam Bro).
 * @returns {{queued:number, new:number, file:string}}
 */
function queueThresholdProposals(computed, { notify = true } = {}) {
  const queue = readThresholdProposals();
  const nowIso = new Date().toISOString();
  const pending = [...queue.pending];
  const fresh = [];

  for (const p of computed.proposals) {
    const idx = pending.findIndex((q) => q.key === p.key && Number(q.proposed) === Number(p.proposed));
    if (idx >= 0) {
      pending[idx] = { ...pending[idx], ...p, first_seen: pending[idx].first_seen || nowIso, last_seen: nowIso, seen_count: (Number(pending[idx].seen_count) || 1) + 1 };
      continue;
    }
    // A different proposed value for the same key supersedes the older entry
    // (kept in history, not silently dropped).
    const stale = pending.findIndex((q) => q.key === p.key);
    if (stale >= 0) pending.splice(stale, 1);
    const entry = { ...p, first_seen: nowIso, last_seen: nowIso, seen_count: 1, status: "PENDING", applied: false };
    pending.push(entry);
    fresh.push(entry);
  }

  const out = {
    updated_at: nowIso,
    auto_apply: false,
    guard: "PROPOSE-ONLY — Lyra guard. Nothing here is applied automatically. Apply manually via user-config.json / update_config after review.",
    window: computed.window,
    pending,
    history: [
      ...queue.history,
      { ts: nowIso, window: computed.window, proposals: computed.proposals.map((p) => ({ key: p.key, current: p.current, proposed: p.proposed, direction: p.direction })) },
    ].slice(-PROPOSAL_HISTORY_CAP),
  };
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(out, null, 2));
  log("evolve", `PROPOSE-ONLY: ${computed.proposals.length} threshold proposal(s) queued (${fresh.length} new) — NOT applied`);

  if (notify && fresh.length > 0) void notifyProposals(fresh, computed.window);
  return { queued: computed.proposals.length, new: fresh.length, file: PROPOSALS_FILE };
}

/** Telegram notice for newly-queued proposals. Best-effort; never throws. */
async function notifyProposals(fresh, window) {
  try {
    const tg = await import("./telegram.js");
    if (typeof tg.sendHTML !== "function") return;
    const lines = [
      "🧠 <b>USULAN PERUBAHAN STANDAR — BELUM DITERAPKAN</b>",
      `<i>Dari ${window?.n ?? "?"} posisi real terakhir (${window?.winners ?? "?"} menang / ${window?.losers ?? "?"} rugi). Bot TIDAK mengubah setelan sendiri.</i>`,
      "",
    ];
    for (const p of fresh) {
      const tag = p.direction === "LOOSEN" ? "⚠️ LONGGAR" : "KETAT";
      lines.push(`• <b>${p.key}</b>: ${p.current} → ${p.proposed} (${tag})`);
      lines.push(`  <i>${p.rationale}</i>`);
      if (p.requires_bro_approval) lines.push("  <b>WAJIB PERSETUJUAN BRO + review Cassiopeia</b>");
      else if (p.requires_cassiopeia_review) lines.push("  <i>Perlu review Cassiopeia (risk gate)</i>");
    }
    lines.push("", "<i>Semua usulan menunggu keputusan Bro. File: threshold-proposals.json</i>");
    await tg.sendHTML(lines.join("\n"));
  } catch { /* telegram optional — queue file is the source of truth */ }
}

/**
 * Threshold evolution entry point.
 *
 * DEFAULT (learning.evolveAutoApply === false) → PROPOSE-ONLY: proposals are
 * queued + notified, `changes` comes back EMPTY, and NOTHING is written to
 * user-config.json or the live config object. This is Lyra's VETO guard against
 * a learning loop silently re-tuning live risk gates.
 *
 * Only when Bro sets evolveAutoApply=true does the legacy auto-apply path run
 * (unchanged semantics: persist to user-config.json + mutate live config).
 *
 * @param {Array}  perfData - performance records (from lessons.json)
 * @param {Object} config   - live config object
 * @param {Object} [opts]   - { notify:false } to suppress Telegram (tests)
 * @returns {{ changes:Object, rationale:Object, proposals?:Array, applied?:boolean, queued?:boolean } | null}
 */
export function evolveThresholds(perfData, config, opts = {}) {
  const lc = { ...learningConfig(), ...opts };
  const computed = computeThresholdProposals(perfData, config, lc);
  if (!computed) return null;
  if (computed.proposals.length === 0) {
    return { changes: {}, rationale: {}, proposals: [], applied: false, auto_apply: !!lc.evolveAutoApply };
  }

  // ── PROPOSE-ONLY (default) ───────────────────────────────────
  if (!lc.evolveAutoApply) {
    const queued = queueThresholdProposals(computed, { notify: opts.notify !== false });
    return {
      changes: {},                 // nothing applied — callers must not reload config
      rationale: computed.rationale,
      proposals: computed.proposals,
      applied: false,
      queued: true,
      auto_apply: false,
      proposal_file: queued.file,
      new_proposals: queued.new,
      window: computed.window,
    };
  }

  // ── LEGACY AUTO-APPLY (only when Bro explicitly enables it) ──
  const changes = {};
  for (const p of computed.proposals) changes[p.key] = p.proposed;

  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }
  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = computed.window.of_real;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  for (const [k, v] of Object.entries(changes)) {
    if (s && Object.prototype.hasOwnProperty.call(s, k)) s[k] = v;
  }

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${computed.window.of_real} real positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(computed.rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale: computed.rationale, proposals: computed.proposals, applied: true, auto_apply: true };
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
      // exit_class — stable enum (derived on the fly for legacy records that
      // predate the field) so the journal is groupable without prose parsing.
      exit_class: r.exit_class || classifyExitClass(r.close_reason),
      source: r.source === "paper" ? "paper" : "live",
      result: classify(r),
    };
  });

  return { rows, summary };
}

/**
 * Bucket-aggregate report for the operator / weekly audit (READ-ONLY).
 * @param {object} [opts]
 * @param {number} [opts.limit=20]        - max rows returned
 * @param {number} [opts.minN=2]          - drop buckets thinner than this
 * @param {string} [opts.dimension]       - filter e.g. "volatility" or "exit_class×entry_direction"
 * @param {boolean} [opts.includePaper=false]
 * @returns {object}
 */
export function getBucketReport({ limit = 20, minN = 2, dimension = null, includePaper = false } = {}) {
  const data = load();
  const agg = aggregateBuckets(data.performance, { includePaper });
  let rows = agg.rows.filter((r) => r.n >= minN);
  if (dimension) rows = rows.filter((r) => r.dimension === dimension);
  return {
    evaluated: agg.evaluated,
    win_bar_sol: agg.bar,
    // Honest gaps: records excluded per dimension because a feature was missing.
    // NOT fabricated into a bucket — surfaced so the gap is visible.
    unknown_excluded: agg.unknown,
    skipped: agg.skipped,
    total_buckets: agg.rows.length,
    rows: rows.slice(0, limit),
  };
}
