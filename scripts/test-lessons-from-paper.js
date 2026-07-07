// scripts/test-lessons-from-paper.js
// PR-B regression — paper-trade closes feed lessons.recordPerformance().
//
// Pure unit test. No network, no on-chain, no real LLM. Backs up + restores
// lessons.json + user-config.json so the test is idempotent and safe to re-run.
//
// Coverage:
//   - closePaperTrade appends a `source: "paper"` performance row
//   - Live close path remains backward-compat (no source field → defaults "live")
//   - 5-paper-close cadence triggers evolveThresholds
//   - Feature flag (config.internalAgents.paperFeedsLessons = false) silences the feed

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const USER_CONFIG_PATH = path.join(ROOT, "user-config.json");
const LESSONS_FILE = path.join(ROOT, "lessons.json");

// ── Backup state ──────────────────────────────────────────────
const userConfigBackup = fs.existsSync(USER_CONFIG_PATH)
  ? fs.readFileSync(USER_CONFIG_PATH, "utf8")
  : null;
const lessonsBackup = fs.existsSync(LESSONS_FILE)
  ? fs.readFileSync(LESSONS_FILE, "utf8")
  : null;

// Reset lessons.json so cadence math (% 5) starts clean from this test
fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));

const { closePaperTrade } = await import("../paper-trades.js");
const { recordPerformance } = await import("../lessons.js");
const { config } = await import("../config.js");

let passed = 0;
let failed = 0;
function assert(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label} ${detail}`);
  }
}

function readLessons() {
  return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
}

function mkTrade(overrides = {}) {
  return {
    id: `paper_test_${Math.random().toString(36).slice(2, 8)}`,
    status: "open",
    opened_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    pool_address: "TESTpool1111111111111111111111111111111111",
    pool_name: "TEST-SOL",
    base_mint: "TESTmint1111111111111111111111111111111111",
    strategy: "bid_ask",
    amount_sol: 0.1,
    bins_below: 35,
    bins_above: 0,
    bin_step: 100,
    entry_price: 1.0,
    entry_fee_tvl_ratio: 0.10,
    entry_volatility: 2.0,
    entry_organic_score: 75,
    fees_claimed_sol: 0,
    notes: [],
    ...overrides,
  };
}

try {
  // Ensure flag ON for primary tests
  config.internalAgents.paperFeedsLessons = true;

  // ── 1. Single paper close appends a performance row with source="paper" ──
  {
    const trade = mkTrade();
    const exit = { action: "STOP_LOSS", reason: "Stop loss: PnL -25.00% <= -20%" };
    const snapshot = { price_proxy_pnl_pct: -25, fee_inclusive_pnl_pct: -25, price: 0.75 };
    await closePaperTrade(trade, exit, snapshot);

    const lessons = readLessons();
    assert(
      "performance row appended after paper close",
      lessons.performance.length === 1,
      `got length=${lessons.performance.length}`,
    );
    const row = lessons.performance[0];
    assert(
      "performance row tagged source=paper",
      row && row.source === "paper",
      `got: ${row?.source}`,
    );
    assert(
      "performance row carries pool_name from trade",
      row && row.pool_name === "TEST-SOL",
    );
    assert(
      "performance row pnl_pct reflects -25%",
      row && Math.abs(row.pnl_pct - (-25)) < 0.5,
      `got pnl_pct=${row?.pnl_pct}`,
    );
    assert(
      "trade marked closed after closePaperTrade",
      trade.status === "closed" && typeof trade.closed_at === "string",
    );
  }

  // ── 2. Backward compat — live record without source defaults to "live" ──
  {
    const lessonsBefore = readLessons().performance.length;
    await recordPerformance({
      position: "live_compat_pos",
      pool: "LIVEpool111",
      pool_name: "LIVE-SOL",
      strategy: "spot",
      bin_range: 35,
      bin_step: 100,
      volatility: 2.0,
      fee_tvl_ratio: 0.10,
      organic_score: 70,
      amount_sol: 0.5,
      fees_earned_usd: 5,
      final_value_usd: 55,
      initial_value_usd: 50,
      minutes_in_range: 60,
      minutes_held: 60,
      close_reason: "manual",
      // NOTE: no `source` field — must default to "live"
    });
    const lessons = readLessons();
    const liveRow = lessons.performance[lessons.performance.length - 1];
    assert(
      "live record without source defaults to 'live'",
      liveRow && liveRow.source === "live",
      `got: ${liveRow?.source}`,
    );
    assert(
      "live record appended (length grew by 1)",
      lessons.performance.length === lessonsBefore + 1,
    );
  }

  // ── 3. Paper closes DO NOT evolve thresholds (Lyra integrity fix) ──
  // Paper PnL is fee-inclusive/optimistic and never touched the wallet — it
  // poisoned the learning loop. 5 paper closes hit the % 5 cadence but must be
  // EXCLUDED from evolveThresholds → no [AUTO-EVOLVED] lesson, no derived
  // PREFER/AVOID lessons from paper rows.
  {
    // Reset state
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    // Reset config screening floors so evolution WOULD have headroom (proving
    // the block is about source=paper, not lack of headroom).
    config.screening.minFeeActiveTvlRatio = 0.05;
    config.screening.minOrganic = 60;

    // 3 winners + 2 losers — a split that WOULD move thresholds if these were real.
    const scenarios = [
      { pnl: +8,  fee_tvl: 0.10, organic: 80 },
      { pnl: +12, fee_tvl: 0.11, organic: 82 },
      { pnl: +6,  fee_tvl: 0.09, organic: 78 },
      { pnl: -12, fee_tvl: 0.04, organic: 52 },
      { pnl: -18, fee_tvl: 0.03, organic: 55 },
    ];
    for (const s of scenarios) {
      const trade = mkTrade({
        entry_fee_tvl_ratio: s.fee_tvl,
        entry_organic_score: s.organic,
      });
      const exit = { action: "TEST", reason: "scenario close" };
      const snapshot = { price_proxy_pnl_pct: s.pnl, fee_inclusive_pnl_pct: s.pnl, price: 1 + s.pnl / 100 };
      await closePaperTrade(trade, exit, snapshot);
    }
    const lessons = readLessons();
    assert(
      "5 paper closes produced 5 performance rows",
      lessons.performance.length === 5,
      `got: ${lessons.performance.length}`,
    );
    assert(
      "all 5 rows tagged source=paper",
      lessons.performance.every((r) => r.source === "paper"),
    );
    const evolved = lessons.lessons.some((l) =>
      typeof l.rule === "string" && l.rule.includes("AUTO-EVOLVED"),
    );
    assert(
      "paper closes DID NOT evolve thresholds (no AUTO-EVOLVED lesson)",
      !evolved,
      `unexpected evolution: ${lessons.lessons.map((l) => l.rule?.slice(0, 40)).join(" | ")}`,
    );
    assert(
      "paper closes derived NO lessons at all (paper excluded from derivation)",
      lessons.lessons.length === 0,
      `got ${lessons.lessons.length} lessons`,
    );
  }

  // ── 4. Feature flag OFF silences the lessons feed ───────────
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    config.internalAgents.paperFeedsLessons = false;

    const trade = mkTrade();
    const exit = { action: "STOP_LOSS", reason: "flag off test" };
    const snapshot = { price_proxy_pnl_pct: -25, fee_inclusive_pnl_pct: -25, price: 0.75 };
    await closePaperTrade(trade, exit, snapshot);

    const lessons = readLessons();
    assert(
      "flag OFF — no performance row appended",
      lessons.performance.length === 0,
      `got length=${lessons.performance.length}`,
    );
    assert(
      "flag OFF — trade still marked closed (close path otherwise intact)",
      trade.status === "closed",
    );
  }

  // ── 5. Finite apiPnlUsd/apiPnlPct override the value-delta recompute ──
  // Recompute from these values would be pnl_usd=10, pnl_pct=20. The API
  // figures (7.5 / 15) must win when finite.
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    config.internalAgents.paperFeedsLessons = true;

    await recordPerformance({
      position: "api_pnl_pos",
      pool: "APIpool111",
      pool_name: "API-SOL",
      strategy: "spot",
      bin_range: 35,
      bin_step: 100,
      volatility: 2.0,
      fee_tvl_ratio: 0.10,
      organic_score: 70,
      amount_sol: 0.5,
      fees_earned_usd: 5,
      final_value_usd: 55,      // recompute → (55 + 5) - 50 = 10 usd, 20%
      initial_value_usd: 50,
      minutes_in_range: 60,
      minutes_held: 60,
      close_reason: "manual",
      source: "live",
      apiPnlUsd: 7.5,           // preferred over recompute 10
      apiPnlPct: 15,            // preferred over recompute 20
    });
    const row = readLessons().performance[0];
    assert(
      "finite apiPnlUsd stored verbatim (7.5), not recompute (10)",
      row && Math.abs(row.pnl_usd - 7.5) < 1e-6,
      `got pnl_usd=${row?.pnl_usd}`,
    );
    assert(
      "finite apiPnlPct stored verbatim (15), not recompute (20)",
      row && Math.abs(row.pnl_pct - 15) < 1e-6,
      `got pnl_pct=${row?.pnl_pct}`,
    );
  }

  // ── 6. Legacy path — no API figures → value-delta recompute intact ──
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    config.internalAgents.paperFeedsLessons = true;

    await recordPerformance({
      position: "legacy_pnl_pos",
      pool: "LEGACYpool111",
      pool_name: "LEGACY-SOL",
      strategy: "spot",
      bin_range: 35,
      bin_step: 100,
      volatility: 2.0,
      fee_tvl_ratio: 0.10,
      organic_score: 70,
      amount_sol: 0.5,
      fees_earned_usd: 5,
      final_value_usd: 55,      // recompute → (55 + 5) - 50 = 10 usd, 20%
      initial_value_usd: 50,
      minutes_in_range: 60,
      minutes_held: 60,
      close_reason: "manual",
      source: "live",
      // NOTE: no apiPnlUsd / apiPnlPct — must recompute, no crash
    });
    const row = readLessons().performance[0];
    assert(
      "legacy no-api recompute pnl_usd intact (10)",
      row && Math.abs(row.pnl_usd - 10) < 1e-6,
      `got pnl_usd=${row?.pnl_usd}`,
    );
    assert(
      "legacy no-api recompute pnl_pct intact (20)",
      row && Math.abs(row.pnl_pct - 20) < 1e-6,
      `got pnl_pct=${row?.pnl_pct}`,
    );
  }

  // ── 7. 100%-in-range but NET-LOSING trade is NOT a PREFER lesson ──
  // This is the poison signature: price walks straight DOWN through the range
  // (range_efficiency=100%) while realized SOL is negative. The old code saw
  // fee-inclusive pnl_pct>0 + high range-eff and derived a "PREFER" lesson.
  // Now realized_sol_delta drives the outcome → this must NOT be a PREFER.
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    config.internalAgents.paperFeedsLessons = true;

    await recordPerformance({
      position: "bleed_pos",
      pool: "BLEEDpool111",
      pool_name: "BLEED-SOL",
      strategy: "spot",
      bin_range: 35,
      bin_step: 100,
      volatility: 1.5,
      fee_tvl_ratio: 0.10,
      organic_score: 75,
      amount_sol: 0.5,
      fees_earned_usd: 6,            // fee-inclusive pnl_pct would look positive
      final_value_usd: 47,
      initial_value_usd: 50,
      minutes_in_range: 60,
      minutes_held: 60,              // range_efficiency = 100%
      close_reason: "stop loss",
      source: "live",
      realized_sol_delta: -0.03,     // WALLET-TRUTH: net loss
    });
    const lessons = readLessons();
    const hasPrefer = lessons.lessons.some((l) =>
      typeof l.rule === "string" && l.rule.startsWith("PREFER"),
    );
    assert(
      "100%-in-range but net-losing trade did NOT derive a PREFER lesson",
      !hasPrefer,
      `lessons: ${lessons.lessons.map((l) => l.rule?.slice(0, 50)).join(" | ")}`,
    );
    // Should be classified bad (negative realized) → AVOID/FAILED, not PREFER/WORKED.
    const derived = lessons.lessons.find((l) => l.sourceType === "performance");
    assert(
      "net-losing 100%-range trade derived a negative-outcome lesson (bad)",
      derived && derived.outcome === "bad",
      `got outcome=${derived?.outcome}`,
    );
  }

  // ── 8. 100%-in-range WITH positive realized SOL IS a PREFER lesson ──
  {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    config.internalAgents.paperFeedsLessons = true;

    await recordPerformance({
      position: "good_range_pos",
      pool: "GOODpool111",
      pool_name: "GOOD-SOL",
      strategy: "bid_ask",
      bin_range: 35,
      bin_step: 100,
      volatility: 4.2,
      fee_tvl_ratio: 0.15,
      organic_score: 80,
      amount_sol: 0.5,
      fees_earned_usd: 8,
      final_value_usd: 56,
      initial_value_usd: 50,
      minutes_in_range: 60,
      minutes_held: 60,              // range_efficiency = 100%
      close_reason: "take profit",
      source: "live",
      realized_sol_delta: +0.04,     // WALLET-TRUTH: net win
    });
    const lessons = readLessons();
    const hasPrefer = lessons.lessons.some((l) =>
      typeof l.rule === "string" && l.rule.startsWith("PREFER"),
    );
    assert(
      "100%-in-range WITH positive realized SOL DID derive a PREFER lesson",
      hasPrefer,
      `lessons: ${lessons.lessons.map((l) => l.rule?.slice(0, 50)).join(" | ")}`,
    );
  }

  // ── 9. evolveThresholds is realized-SOL-driven on LIVE records ──
  // A record whose fee-inclusive pnl_pct is POSITIVE but whose realized SOL is
  // NEGATIVE must count as a LOSER (not a winner). Build a split that only
  // resolves correctly under realized-SOL classification.
  {
    const { evolveThresholds } = await import("../lessons.js");
    const bar = 0.005; // matches DEFAULT_MIN_MEANINGFUL_PROFIT_SOL
    const cfg = { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 } };

    // 3 real winners: positive realized SOL, high fee_tvl + organic.
    // 2 real losers: pnl_pct LOOKS positive (fee-inclusive) but realized SOL NEGATIVE,
    //                low fee_tvl + organic → should push floors up if counted as losers.
    const perfData = [
      { source: "live", pnl_pct: +8,  realized_sol_delta: +0.02, fee_tvl_ratio: 0.12, organic_score: 82 },
      { source: "live", pnl_pct: +6,  realized_sol_delta: +0.03, fee_tvl_ratio: 0.11, organic_score: 80 },
      { source: "live", pnl_pct: +5,  realized_sol_delta: +0.015, fee_tvl_ratio: 0.13, organic_score: 84 },
      { source: "live", pnl_pct: +2,  realized_sol_delta: -0.02, fee_tvl_ratio: 0.04, organic_score: 52 },
      { source: "live", pnl_pct: +1,  realized_sol_delta: -0.03, fee_tvl_ratio: 0.03, organic_score: 55 },
    ];
    const result = evolveThresholds(perfData, cfg);
    assert(
      "evolveThresholds returned a result on 5 real records",
      result !== null,
      `got: ${result}`,
    );
    // Under fee-inclusive pnl_pct all 5 look like winners (all >0) → no losers,
    // no signal to raise floors. Under realized-SOL the last 2 are losers with
    // low fee_tvl/organic → floors should rise. Prove realized drove it.
    assert(
      "realized-SOL classification produced threshold changes (fee-inclusive would not)",
      result && result.changes && Object.keys(result.changes).length > 0,
      `changes: ${JSON.stringify(result?.changes)}`,
    );

    // Control: same records but with paper source → excluded → no evolution.
    const paperData = perfData.map((p) => ({ ...p, source: "paper" }));
    const paperResult = evolveThresholds(paperData, { screening: { minFeeActiveTvlRatio: 0.05, minOrganic: 60 } });
    assert(
      "all-paper dataset yields no evolution (paper excluded)",
      paperResult === null,
      `got: ${JSON.stringify(paperResult)}`,
    );
    void bar;
  }
} finally {
  // ── Restore state ────────────────────────────────────────────
  if (userConfigBackup === null) {
    if (fs.existsSync(USER_CONFIG_PATH)) fs.unlinkSync(USER_CONFIG_PATH);
  } else {
    fs.writeFileSync(USER_CONFIG_PATH, userConfigBackup);
  }
  if (lessonsBackup === null) {
    if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
  } else {
    fs.writeFileSync(LESSONS_FILE, lessonsBackup);
  }
  // Restore flag default
  config.internalAgents.paperFeedsLessons = true;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
