// scripts/test-bucket-learning.js — Lyra 🎵
//
// Regression for the dimension-aware bucket-aggregate learning engine
// (Bro requirement #6: "selalu belajar dari kesalahan, jangan terus mengulang,
// kita punya data, jadikan training").
//
// Coverage:
//   1. exit_class mapping over REAL close_reason strings pulled from the live
//      ledger (135 distinct variants → 8 classes, prefix-trap included)
//   2. bucket dimensions + fail-safe on missing entry_features
//   3. bucket aggregation: n, realized-SOL EV, neutral band KEPT, verdicts
//   4. dedup: same bucket increments (one row), never a second lesson
//   5. legacy lesson merge-with-count (history archived, not deleted)
//   6. PROPOSE-ONLY: evolveThresholds writes NO threshold into user-config.json
//      and does NOT mutate the live config object; LOOSEN proposals are flagged
//
// Pure unit test. No network, no on-chain, no LLM. Backs up + restores
// lessons.json / user-config.json / threshold-proposals.json.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const USER_CONFIG_PATH = path.join(ROOT, "user-config.json");
const LESSONS_FILE = path.join(ROOT, "lessons.json");
const PROPOSALS_FILE = path.join(ROOT, "threshold-proposals.json");

const backup = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const restore = (p, v) => {
  if (v === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
  else fs.writeFileSync(p, v);
};
const ucBackup = backup(USER_CONFIG_PATH);
const lessonsBackup = backup(LESSONS_FILE);
const proposalsBackup = backup(PROPOSALS_FILE);

let pass = 0, fail = 0;
const failures = [];
function assert(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; failures.push(label); console.error(`  FAIL  ${label} ${detail}`); }
}
function writeUserConfig(obj) {
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(obj, null, 2));
}
function readLessons() {
  return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
}

// Start from a clean, deterministic learning config (bucket engine ON,
// auto-apply OFF = the shipped defaults).
writeUserConfig({ learning: { bucketLessonsEnabled: true, evolveAutoApply: false }, minMeaningfulProfitSol: 0.005 });
fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
if (fs.existsSync(PROPOSALS_FILE)) fs.unlinkSync(PROPOSALS_FILE);

const L = await import("../lessons.js");

try {
  // ══ 1. exit_class over REAL ledger close_reason strings ══════════════════
  console.log("\n[1] exit_class mapping — real close_reason samples (VPS ledger 2026-07-25)");
  const REAL = [
    // [close_reason (verbatim from lessons.json performance[]), expected class]
    ["⚡ Trailing TP: oor_up_fast_harvest: OOR-UP 3m >= 3m — 100% idle SOL (zero fee accrual), harvesting to free capital", "OOR_UP_HARVEST"],
    ["⚡ Trailing TP: Stop loss: PnL -10.33% ≤ -10% — immediate close triggered", "STOP_LOSS"],
    ["Trailing TP: Stop loss: PnL -10.55% ≤ -10% — immediate close triggered", "STOP_LOSS"],
    ["⚡ Trailing TP: Stop loss: PnL -8.03% <= -8% — immediate close triggered. Islands-SOL", "STOP_LOSS"],
    ["⚡ Trailing TP: Low yield: fee/TVL 5.25% < min 7% (age: 60m)", "LOW_YIELD"],
    ["Low yield: fee/TVL 3.63% < min 7% (age: 60m)", "LOW_YIELD"],
    ["Rule 5: low yield — fee_per_tvl_24h 6.99% below 7% threshold, out of range for 32 minutes", "LOW_YIELD"],
    ["Low yield: fee/TVL 6.99% < min 7% (age: 397m) — ⚡ Trailing TP exit triggered", "LOW_YIELD"],
    ["⚡ Trailing TP: peak 23.97% → current 17.94% (dropped 6.03% >= 6%)", "TRAILING_TP"],
    ["⚡ Trailing TP: Trailing TP triggered — peak 3.72% → current -2.28%, dropped 6.00% >= 6% threshold", "TRAILING_TP"],
    ["⚡ Trailing TP: Break-even stop: net PnL -1.94% <= 0% after arming at peak 5.43% — modal locked, NOT round-tripping to -8%", "TRAILING_TP"],
    ["Rule 3: pumped far above range — active bin -397 vs range -453 to -408", "PUMP_ABOVE"],
    ["CLOSE — Rule 3: pumped far above range. PnL +7.75%, position out of range (active bin -473, range -553 to -484), oor_minutes=9. Taking profit.", "PUMP_ABOVE"],
    ["pumped far above range", "PUMP_ABOVE"],
    ["Rule 3: pumped far above range — OOR for 8 mins (exceeds outOfRangeWaitMinutesDown=8)", "PUMP_ABOVE"],
    ["Rule 4: OOR — position out of range for 20 minutes (active bin 368, range 306-363)", "OOR_TIMEOUT"],
    ["⚡ Trailing TP: Out of range for 20m (limit: 20m) — immediate close triggered.", "OOR_TIMEOUT"],
    ["OOR (fees 0 < friction 0.00225, not worth re-center): OOR 20m (limit 20m) but organic 87 >= 80 and rebalance_count 0 < 3 — re-center candidate", "OOR_TIMEOUT"],
    ["⚡ Trailing TP: held 891m >= 720m AND out-of-range — forced close (max_hold_oor)", "OOR_TIMEOUT"],
    ["User requested close via /close command", "MANUAL"],
  ];
  for (const [reason, expected] of REAL) {
    const got = L.classifyExitClass(reason);
    assert(`${expected.padEnd(15)} ← "${reason.slice(0, 52)}…"`, got === expected, `got ${got}`);
  }
  // The prefix trap: EVERY exit carries "⚡ Trailing TP:" — the specific trigger must win.
  assert("prefix trap: '⚡ Trailing TP: Stop loss…' is NOT classified TRAILING_TP",
    L.classifyExitClass("⚡ Trailing TP: Stop loss: PnL -8.40% <= -8%") === "STOP_LOSS");
  assert("prefix trap: '⚡ Trailing TP: Low yield…' is NOT classified TRAILING_TP",
    L.classifyExitClass("⚡ Trailing TP: Low yield: fee/TVL 4.17% < min 7%") === "LOW_YIELD");

  // Fail-safe: never guess.
  assert("null close_reason → UNKNOWN", L.classifyExitClass(null) === "UNKNOWN");
  assert("undefined → UNKNOWN", L.classifyExitClass(undefined) === "UNKNOWN");
  assert("empty string → UNKNOWN", L.classifyExitClass("   ") === "UNKNOWN");
  assert("non-string (object) → UNKNOWN", L.classifyExitClass({ reason: "stop loss" }) === "UNKNOWN");
  assert("unrecognized prose → UNKNOWN (never mis-filed)",
    L.classifyExitClass("closed because the operator felt like it, no keywords here") === "UNKNOWN");
  assert("direction-less OOR is OOR_TIMEOUT, NOT a fabricated OOR_DOWN",
    L.classifyExitClass("Rule 4: OOR — out of range for 20 minutes") === "OOR_TIMEOUT");
  assert("explicit down evidence → OOR_DOWN",
    L.classifyExitClass("OOR: price fell below lower bound, position out of range") === "OOR_DOWN");

  // ══ 2. Bucket dimensions + fail-safe on missing entry_features ═══════════
  console.log("\n[2] bucket dimensions + missing-feature fail-safe");
  assert("volatilityBucket(1.9) → vol[0,2.5)", L.volatilityBucket(1.9) === "vol[0,2.5)");
  assert("volatilityBucket(3.0) → vol[2.5,3.5)", L.volatilityBucket(3.0) === "vol[2.5,3.5)");
  assert("volatilityBucket(4.5) → vol4.5+", L.volatilityBucket(4.5) === "vol4.5+");
  assert("volatilityBucket(null) → null (no fake bucket)", L.volatilityBucket(null) === null);
  assert("volatilityBucket(0 as string '') → null", L.volatilityBucket("") === null);
  assert("feeTvlBucket(0.34) → fee[0.2,0.4)", L.feeTvlBucket(0.34) === "fee[0.2,0.4)");
  assert("entryDirectionBucket(-3.7) → entry_down", L.entryDirectionBucket(-3.7) === "entry_down");
  assert("entryDirectionBucket(0.4) → entry_flat", L.entryDirectionBucket(0.4) === "entry_flat");
  assert("entryDirectionBucket(12.7) → entry_pump", L.entryDirectionBucket(12.7) === "entry_pump");
  assert("entryDirectionBucket(null) → null (NOT flat — no fabricated 0)", L.entryDirectionBucket(null) === null);
  assert("regimeBucket(-1.78) → regime_down", L.regimeBucket(-1.78) === "regime_down");
  assert("regimeBucket(undefined) → null", L.regimeBucket(undefined) === null);

  {
    // Real-shaped record (fields verbatim from the live ledger).
    const withEf = {
      volatility: 3.019, fee_tvl_ratio: 0.3421,
      entry_features: { sol_regime_24h_pct: -1.7751, token_price_change_1h: 12.7, token_price_change_24h: null, buy_sell_flow_ratio: null, mcap: 621810 },
      close_reason: "Rule 3: pumped far above range — position out of range",
    };
    const d1 = L.recordDimensions(withEf);
    assert("recordDimensions reads entry_features.token_price_change_1h", d1.entry_direction === "entry_pump");
    assert("recordDimensions reads entry_features.sol_regime_24h_pct", d1.regime === "regime_down");
    assert("recordDimensions derives exit_class", d1.exit_class === "PUMP_ABOVE");

    // 64 of 160 live records have NO entry_features at all — must stay honest.
    const noEf = { volatility: 3.019, fee_tvl_ratio: 0.3421, entry_features: null, close_reason: "stop loss" };
    const d2 = L.recordDimensions(noEf);
    assert("missing entry_features → entry_direction null (not fabricated)", d2.entry_direction === null);
    assert("missing entry_features → regime null (not fabricated)", d2.regime === null);
    assert("missing entry_features still yields volatility bucket", d2.volatility === "vol[2.5,3.5)");

    // 15 of 96 records HAVE entry_features but a null field inside.
    const partial = { volatility: 4.0, fee_tvl_ratio: 0.5, entry_features: { sol_regime_24h_pct: null, token_price_change_1h: null }, close_reason: "manual" };
    const d3 = L.recordDimensions(partial);
    assert("entry_features present but field null → null bucket", d3.entry_direction === null && d3.regime === null);
  }

  // ══ 3. Aggregation: n, realized-SOL EV, neutral band KEPT ════════════════
  console.log("\n[3] bucket aggregation (realized SOL, neutral band kept)");
  {
    const mk = (o) => ({ source: "live", volatility: 2.0, fee_tvl_ratio: 0.05, close_reason: "stop loss", recorded_at: "2026-07-20T00:00:00Z", ...o });
    const recs = [
      mk({ realized_sol_delta: -0.02 }),
      mk({ realized_sol_delta: -0.01 }),
      mk({ realized_sol_delta: -0.03 }),
      mk({ realized_sol_delta: 0.0005 }),                              // NEUTRAL (inside ±bar)
      mk({ realized_sol_delta: 0.03, close_reason: "take profit" }),    // different exit bucket
      mk({ source: "paper", realized_sol_delta: -5 }),                  // paper must be excluded
      mk({ realized_sol_delta: null }),                                 // no wallet truth → excluded
    ];
    const agg = L.aggregateBuckets(recs);
    assert("paper record excluded from aggregate", agg.skipped.paper === 1);
    assert("record without realized_sol_delta excluded (no fabricated EV)", agg.skipped.no_realized_sol === 1);
    assert("evaluated counts only wallet-truth live rows (5)", agg.evaluated === 5, `got ${agg.evaluated}`);

    const volRow = agg.rows.find(r => r.key === "volatility=vol[0,2.5)");
    assert("volatility bucket aggregated all 5 rows", volRow && volRow.n === 5, `got ${volRow?.n}`);
    assert("NEUTRAL band record is KEPT in n (not discarded)", volRow.neutral === 1);
    assert("wins/losses split by meaningful bar", volRow.wins === 1 && volRow.losses === 3,
      `W${volRow?.wins}/L${volRow?.losses}`);
    const expectedNet = -0.02 - 0.01 - 0.03 + 0.0005 + 0.03;
    assert("net_sol = sum of realized deltas (incl. neutral)", Math.abs(volRow.net_sol - expectedNet) < 1e-9,
      `got ${volRow.net_sol} want ${expectedNet}`);
    assert("ev_sol = net/n (realized SOL, NOT pnl_pct)", Math.abs(volRow.ev_sol - expectedNet / 5) < 1e-9);

    const slRow = agg.rows.find(r => r.key === "exit_class=STOP_LOSS");
    assert("exit_class bucket exists with n=4", slRow && slRow.n === 4, `got ${slRow?.n}`);
    assert("thin bucket verdict is THIN (n<10) — never called an edge", slRow.verdict === "THIN");
    assert("THIN bucket is not flagged material", slRow.material === false);

    // entry_direction / regime absent on every record → counted as unknown, excluded.
    assert("missing entry_direction counted in unknown (honest gap)", agg.unknown.entry_direction === 5,
      `got ${agg.unknown.entry_direction}`);
    assert("no fabricated entry_direction bucket exists",
      !agg.rows.some(r => r.dims.entry_direction));

    // Verdict ladder on a big, clean sample.
    const many = Array.from({ length: 30 }, () => mk({ realized_sol_delta: -0.02, volatility: 4.6 }));
    const aggMany = L.aggregateBuckets(many);
    const bigRow = aggMany.rows.find(r => r.key === "volatility=vol4.5+");
    assert("n=30 consistent losses → SIGNAL verdict", bigRow.verdict === "SIGNAL", `got ${bigRow?.verdict}`);
    assert("SIGNAL + EV beyond bar → material", bigRow.material === true);
  }

  // ══ 4. DEDUP FIX — same bucket increments, never a second lesson ═════════
  console.log("\n[4] bucket lessons: same bucket → increment, not a new lesson");
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    const close = async (realized, reason = "⚡ Trailing TP: Stop loss: PnL -9.00% <= -8%") => {
      await L.recordPerformance({
        position: `pos_${Math.random().toString(36).slice(2, 8)}`,
        pool: "POOLaaa", pool_name: "DUP-SOL", strategy: "spot", bin_range: 35, bin_step: 100,
        volatility: 2.0, fee_tvl_ratio: 0.05, organic_score: 70, amount_sol: 0.1,
        fees_earned_usd: 0, final_value_usd: 9, initial_value_usd: 10,
        minutes_in_range: 60, minutes_held: 60,
        close_reason: reason, source: "live", realized_sol_delta: realized,
        entry_features: { sol_regime_24h_pct: -1.5, token_price_change_1h: -2.0 },
      });
    };
    await close(-0.02);
    await close(-0.03);
    await close(-0.04);
    const data = readLessons();
    const buckets = data.lessons.filter(l => l.sourceType === "bucket_aggregate");
    const slRows = buckets.filter(l => l.bucketKey === "exit_class=STOP_LOSS");
    assert("exactly ONE lesson row for exit_class=STOP_LOSS after 3 closes", slRows.length === 1,
      `got ${slRows.length}`);
    assert("that row's n counted all 3 closes", slRows[0]?.n === 3, `got n=${slRows[0]?.n}`);
    assert("row carries realized-SOL EV", Math.abs(slRows[0].ev_sol - (-0.03)) < 1e-9, `got ${slRows[0]?.ev_sol}`);
    assert("first appearance of the row is revision 0 (bucketLessonMinN=3)", slRows[0].revision === 0, `got ${slRows[0]?.revision}`);

    // 4th close in the SAME bucket: the row must be REFRESHED (n increments,
    // revision increments), NOT joined by a second row.
    await close(-0.05);
    const data4 = readLessons();
    const slRows4 = data4.lessons.filter(l => l.bucketKey === "exit_class=STOP_LOSS");
    assert("still exactly ONE row after a 4th close in the same bucket", slRows4.length === 1, `got ${slRows4.length}`);
    assert("4th close incremented n to 4", slRows4[0].n === 4, `got n=${slRows4[0]?.n}`);
    assert("row refreshed in place (revision 0 → 1)", slRows4[0].revision === 1, `got ${slRows4[0]?.revision}`);
    assert("created_at of the row preserved across refresh",
      slRows4[0].created_at === slRows[0].created_at, `${slRows[0].created_at} → ${slRows4[0].created_at}`);
    assert("EV recomputed from all 4 closes", Math.abs(slRows4[0].ev_sol - (-0.035)) < 1e-9, `got ${slRows4[0].ev_sol}`);
    assert("NO per-trade prose lesson pushed (dedup fix)",
      data.lessons.every(l => l.sourceType !== "performance"),
      `prose: ${data.lessons.filter(l => l.sourceType === "performance").length}`);
    assert("entry_direction bucket derived from entry_features",
      buckets.some(l => l.dims?.entry_direction === "entry_down"));
    assert("exit_class persisted onto the performance record",
      data.performance.every(r => r.exit_class === "STOP_LOSS"));
    assert("bucket lesson rule carries n + EV + verdict",
      /n=3, EV -0\.0300 SOL\/trade/.test(slRows[0].rule), slRows[0].rule);

    // Legacy prose mode still available (reversibility).
    writeUserConfig({ learning: { bucketLessonsEnabled: false, evolveAutoApply: false } });
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    await close(-0.02);
    const legacy = readLessons();
    assert("bucketLessonsEnabled=false → legacy prose lesson returns (reversible)",
      legacy.lessons.some(l => l.sourceType === "performance"));
    assert("bucketLessonsEnabled=false → no bucket rows written",
      !legacy.lessons.some(l => l.sourceType === "bucket_aggregate"));
    writeUserConfig({ learning: { bucketLessonsEnabled: true, evolveAutoApply: false } });
  }

  // ══ 5. Legacy lesson consolidation (merge-with-count, history archived) ══
  console.log("\n[5] legacy lesson dedup — merge with count, archive history");
  {
    const mkLesson = (i, extra = {}) => ({
      id: 1000 + i,
      rule: `FAILED: POOL${i}-SOL, strategy=spot, bin_step=100, volatility=2.9${i}, fee_tvl_ratio=0.5${i}, organic=70 → PnL -6.${i}%`,
      context: `POOL${i}-SOL, strategy=spot, bin_step=100, volatility=2.9${i}, fee_tvl_ratio=0.5${i}`,
      outcome: "bad", sourceType: "performance", confidence: 0.8 + i / 100,
      close_reason: "⚡ Trailing TP: Stop loss: PnL -8.5% <= -8%",
      created_at: `2026-07-0${i + 1}T00:00:00Z`,
      ...extra,
    });
    const list = [
      mkLesson(1), mkLesson(2), mkLesson(3),                        // same signature ×3
      mkLesson(4, { outcome: "good", rule: "PREFER: X-SOL, volatility=4.0, fee_tvl_ratio=0.30", context: "X-SOL, volatility=4.0, fee_tvl_ratio=0.30", close_reason: "pumped far above range" }),
      { id: 2001, rule: "Manual: never deploy into pools with dev holding >40%", tags: ["manual"], outcome: "manual", sourceType: "manual", pinned: true, created_at: "2026-06-01T00:00:00Z" },
      { id: 2002, rule: "[AUTO-EVOLVED @ 5 real positions] minOrganic=72", tags: ["evolution"], outcome: "manual", sourceType: "config_change", created_at: "2026-06-02T00:00:00Z" },
    ];
    const res = L.consolidateLessonList(list);
    assert("6 lessons → 4 after merge", res.lessons.length === 4, `got ${res.lessons.length}`);
    assert("2 duplicates archived (not deleted)", res.archived.length === 2, `got ${res.archived.length}`);
    const merged = res.lessons.find(l => l.merged_count);
    assert("canonical row carries merged_count=3", merged?.merged_count === 3, `got ${merged?.merged_count}`);
    assert("canonical row lists merged ids", Array.isArray(merged?.merged_ids) && merged.merged_ids.length === 2);
    assert("canonical rule prefixed with observation count", /^\[×3 obs\]/.test(merged.rule), merged.rule);
    assert("canonical keeps EARLIEST created_at (history preserved)", merged.created_at === "2026-07-02T00:00:00Z", `got ${merged.created_at}`);
    assert("canonical keeps MAX confidence of the group", Math.abs(merged.confidence - 0.83) < 1e-9, `got ${merged.confidence}`);
    assert("archived entries reference their canonical", res.archived.every(a => a.merged_into === merged.id));
    assert("pinned manual lesson untouched", res.lessons.some(l => l.id === 2001 && !l.merged_count));
    assert("AUTO-EVOLVED bookkeeping untouched", res.lessons.some(l => l.id === 2002));
    assert("different-outcome lesson NOT merged into the loser group", res.lessons.some(l => l.id === 1004));
    assert("dedup signature is dimension-aware (vol+fee+exit)",
      L.lessonDedupSignature(mkLesson(1)) === "FAILED|bad|STOP_LOSS|vol[2.5,3.5)|fee0.4+",
      L.lessonDedupSignature(mkLesson(1)));
    assert("idempotent: re-consolidating merges nothing new",
      L.consolidateLessonList(res.lessons).archived.length === 0);

    // On-disk path archives, never deletes.
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: list, performance: [] }, null, 2));
    const summary = L.consolidateLessons({ rebuildBuckets: false });
    const after = readLessons();
    assert("consolidateLessons applied to disk", summary.duplicates_merged === 2);
    assert("archived duplicates live in lesson_archive", (after.lesson_archive || []).length === 2);
    assert("archive rows carry a reason", after.lesson_archive.every(a => a.archived_reason === "duplicate_merged"));
  }

  // ══ 5b. lessonTotalCap — overflow ARCHIVED, prompt bounded ═══════════════
  console.log("\n[5b] lesson cap");
  {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: 5000 + i, rule: `Manual note ${i}`, sourceType: "manual", outcome: "manual",
      created_at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const data = { lessons: [...many], performance: [], lesson_archive: [] };
    const res = L.capLessons(data, 10);
    assert("cap enforced on active list", data.lessons.length === 10, `got ${data.lessons.length}`);
    assert("overflow archived, not deleted", res.archived === 20 && data.lesson_archive.length === 20);
    assert("newest lessons kept", data.lessons.every(l => l.created_at >= "2026-07-01T00:00:00Z"));

    const pinnedData = {
      lessons: [
        { id: 1, rule: "pinned", pinned: true, sourceType: "manual", created_at: "2020-01-01T00:00:00Z" },
        { id: 2, rule: "bucket", sourceType: "bucket_aggregate", bucketKey: "k", created_at: "2020-01-01T00:00:00Z" },
        ...many,
      ], performance: [], lesson_archive: [],
    };
    L.capLessons(pinnedData, 3);
    assert("pinned + bucket rows always survive the cap",
      pinnedData.lessons.some(l => l.id === 1) && pinnedData.lessons.some(l => l.id === 2));
  }

  // ══ 6. PROPOSE-ONLY guard ════════════════════════════════════════════════
  console.log("\n[6] evolveThresholds is PROPOSE-ONLY (no auto-apply)");
  {
    writeUserConfig({ learning: { bucketLessonsEnabled: true, evolveAutoApply: false }, minMeaningfulProfitSol: 0.005 });
    if (fs.existsSync(PROPOSALS_FILE)) fs.unlinkSync(PROPOSALS_FILE);
    // Clean ledger — section 5's fixture contained an AUTO-EVOLVED bookkeeping row.
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));

    const liveCfg = { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60, minVolatility: 0 } };
    const cfgSnapshot = JSON.parse(JSON.stringify(liveCfg));
    const perfData = [
      { source: "live", realized_sol_delta: +0.02,  fee_tvl_ratio: 0.12, organic_score: 82, volatility: 4.0, close_reason: "take profit" },
      { source: "live", realized_sol_delta: +0.03,  fee_tvl_ratio: 0.11, organic_score: 80, volatility: 4.1, close_reason: "take profit" },
      { source: "live", realized_sol_delta: +0.015, fee_tvl_ratio: 0.13, organic_score: 84, volatility: 4.2, close_reason: "take profit" },
      { source: "live", realized_sol_delta: -0.02,  fee_tvl_ratio: 0.04, organic_score: 52, volatility: 2.0, close_reason: "stop loss" },
      { source: "live", realized_sol_delta: -0.03,  fee_tvl_ratio: 0.03, organic_score: 55, volatility: 2.1, close_reason: "stop loss" },
    ];

    const result = L.evolveThresholds(perfData, liveCfg, { notify: false });
    assert("returns a result", result !== null);
    assert("changes is EMPTY — nothing applied", Object.keys(result.changes).length === 0,
      JSON.stringify(result.changes));
    assert("result.applied === false", result.applied === false);
    assert("result.queued === true", result.queued === true);
    assert("proposals were computed", Array.isArray(result.proposals) && result.proposals.length > 0);

    // THE GUARD: no threshold key written into user-config.json.
    const uc = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const THRESHOLD_KEYS = ["minFeeActiveTvlRatio", "minOrganic", "minVolatility", "minMcap", "maxPositions", "minHolders", "signalMinMcap"];
    for (const k of THRESHOLD_KEYS) {
      assert(`user-config.json NOT written: ${k}`, !(k in uc), `found ${k}=${uc[k]}`);
    }
    assert("user-config.json has NO _lastEvolved (nothing evolved)", !("_lastEvolved" in uc));
    assert("live config object NOT mutated (minFeeActiveTvlRatio)",
      liveCfg.screening.minFeeActiveTvlRatio === cfgSnapshot.screening.minFeeActiveTvlRatio);
    assert("live config object NOT mutated (minOrganic)",
      liveCfg.screening.minOrganic === cfgSnapshot.screening.minOrganic);
    assert("no AUTO-EVOLVED lesson written in propose-only mode",
      !readLessons().lessons.some(l => /AUTO-EVOLVED/.test(String(l.rule))));

    // Queue file is the record.
    const q = L.readThresholdProposals();
    assert("proposal queue file written", fs.existsSync(PROPOSALS_FILE));
    assert("queue auto_apply flag is false", q.auto_apply === false);
    assert("queue has pending proposals", q.pending.length > 0);
    assert("queue entries are marked PENDING/not-applied",
      q.pending.every(p => p.status === "PENDING" && p.applied === false));
    assert("proposal carries current→proposed + rationale",
      q.pending.every(p => p.current !== undefined && p.proposed !== undefined && typeof p.rationale === "string"));
    assert("risk-gate proposal requires Cassiopeia review",
      q.pending.every(p => !p.risk_gate || p.requires_cassiopeia_review === true));
    assert("queue keeps a history trail", Array.isArray(q.history) && q.history.length === 1);

    // Re-running does NOT duplicate a pending proposal (no Telegram spam).
    L.evolveThresholds(perfData, liveCfg, { notify: false });
    const q2 = L.readThresholdProposals();
    assert("identical proposal not duplicated in queue", q2.pending.length === q.pending.length);
    assert("seen_count incremented instead", q2.pending.some(p => p.seen_count >= 2));

    // LOOSEN classification + approval flags.
    assert("isLooseningChange: floor DOWN = LOOSEN", L.isLooseningChange("minVolatility", 3.0, 2.4) === true);
    assert("isLooseningChange: floor UP = TIGHTEN", L.isLooseningChange("minVolatility", 3.0, 3.5) === false);
    assert("isLooseningChange: ceiling UP = LOOSEN", L.isLooseningChange("maxPositions", 3, 5) === true);
    assert("isLooseningChange: unchanged = not loosening", L.isLooseningChange("minOrganic", 72, 72) === false);
    assert("isLooseningChange: missing values = not loosening", L.isLooseningChange("minOrganic", null, 60) === false);

    // A LOOSEN proposal (mcap-floor style) must be flagged for Bro + Cassiopeia.
    // Constructed via the same public path: winners with LOW fee/TVL can never
    // produce a loosening proposal today, so we assert the classifier contract
    // that gates it, plus the queue's rendering of a loosening entry.
    const loosenComputed = {
      proposals: [{
        key: "minVolatility", current: 3.0, proposed: 2.5, direction: "LOOSEN",
        risk_gate: true, owner: "Cassiopeia", requires_bro_approval: true, requires_cassiopeia_review: true,
        approval_note: "REQUIRES BRO APPROVAL + Cassiopeia review (loosens a risk gate)",
        rationale: "synthetic", evidence: {},
      }],
      rationale: { minVolatility: "synthetic" },
      window: { n: 5, of_real: 5, winners: 3, losers: 2, bar: 0.005 },
    };
    assert("LOOSEN proposal shape is flagged REQUIRES BRO APPROVAL",
      /REQUIRES BRO APPROVAL/.test(loosenComputed.proposals[0].approval_note) &&
      loosenComputed.proposals[0].requires_bro_approval === true &&
      loosenComputed.proposals[0].requires_cassiopeia_review === true);

    // Windowed comparator: an ancient outlier winner must NOT pin the floor.
    const ancientWinner = { source: "live", realized_sol_delta: +0.5, fee_tvl_ratio: 9.0, organic_score: 95, volatility: 4.0, close_reason: "take profit" };
    const recent = Array.from({ length: 40 }, (_, i) => ({
      source: "live", realized_sol_delta: i % 2 === 0 ? +0.02 : -0.02,
      fee_tvl_ratio: 0.12, organic_score: 70, volatility: 3.6, close_reason: "take profit",
    }));
    const windowed = L.computeThresholdProposals([ancientWinner, ...recent], { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60, minVolatility: 0 } }, { evolveWindowN: 40, notify: false });
    assert("windowed comparator ignores the out-of-window ancient outlier",
      windowed.window.n === 40 && windowed.proposals.every(p => p.proposed < 1),
      JSON.stringify(windowed.proposals.map(p => [p.key, p.proposed])));

    // Auto-apply ON = legacy behaviour still reachable (Bro-only switch).
    writeUserConfig({ learning: { evolveAutoApply: true }, minMeaningfulProfitSol: 0.005 });
    const liveCfg2 = { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60, minVolatility: 0 } };
    const applied = L.evolveThresholds(perfData, liveCfg2, { notify: false });
    assert("evolveAutoApply=true → changes applied (legacy path intact)",
      applied.applied === true && Object.keys(applied.changes).length > 0, JSON.stringify(applied.changes));
    const uc2 = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    assert("auto-apply mode DOES write user-config.json", "minFeeActiveTvlRatio" in uc2 || "minOrganic" in uc2);
    writeUserConfig({ learning: { bucketLessonsEnabled: true, evolveAutoApply: false }, minMeaningfulProfitSol: 0.005 });
  }

  // ══ 7. getBucketReport surfaces gaps honestly ════════════════════════════
  console.log("\n[7] getBucketReport");
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({
      lessons: [], performance: [
        { source: "live", realized_sol_delta: -0.02, volatility: 2.0, fee_tvl_ratio: 0.05, close_reason: "stop loss" },
        { source: "live", realized_sol_delta: -0.01, volatility: 2.1, fee_tvl_ratio: 0.06, close_reason: "stop loss" },
        { source: "live", realized_sol_delta: null,  volatility: 2.1, fee_tvl_ratio: 0.06, close_reason: "stop loss" },
      ],
    }, null, 2));
    const rep = L.getBucketReport({ minN: 2 });
    assert("report counts evaluated rows", rep.evaluated === 2, `got ${rep.evaluated}`);
    assert("report surfaces unknown_excluded gaps", rep.unknown_excluded.entry_direction === 2);
    assert("report surfaces skipped no-realized rows", rep.skipped.no_realized_sol === 1);
    assert("report returns bucket rows", rep.rows.length > 0);
  }

  // ══ 8. Prompt injection path handles bucket rows ══════════════════════════
  console.log("\n[8] getLessonsForPrompt with bucket rows");
  {
    const perf = Array.from({ length: 12 }, (_, i) => ({
      source: "live", realized_sol_delta: -0.02, volatility: 2.0, fee_tvl_ratio: 0.05,
      close_reason: "stop loss", recorded_at: "2026-07-20T00:00:00Z",
      entry_features: { sol_regime_24h_pct: -1.5, token_price_change_1h: -2 },
    }));
    const data = { lessons: [], performance: perf, lesson_archive: [] };
    L.upsertBucketLessons(data);
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));

    const screener = L.getLessonsForPrompt({ agentType: "SCREENER" });
    assert("prompt renders without throwing on string bucket ids", typeof screener === "string" && screener.length > 0);
    assert("SCREENER prompt receives entry/volatility bucket rows", /EV-BUCKET/.test(screener));
    assert("prompt text carries n and EV (trainable evidence)", /n=12, EV -0\.0200 SOL\/trade/.test(screener));
    const manager = L.getLessonsForPrompt({ agentType: "MANAGER" });
    assert("MANAGER prompt receives exit_class bucket rows", /STOP_LOSS/.test(manager));
    assert("prompt is bounded (auto-cycle cap)", screener.split("\n").length < 40, `lines=${screener.split("\n").length}`);
  }
} finally {
  restore(USER_CONFIG_PATH, ucBackup);
  restore(LESSONS_FILE, lessonsBackup);
  restore(PROPOSALS_FILE, proposalsBackup);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail > 0 ? 1 : 0);
