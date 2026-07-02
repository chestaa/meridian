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

  // ── 3. 5-paper-close cadence triggers evolveThresholds ──────
  // We already have 2 records (paper + live). Add 4 more paper closes →
  // performance.length hits 5 then 6; the % 5 === 0 check fires at length 5.
  // To exercise it cleanly we'll reset and run exactly 5 paper closes with
  // winner/loser split that evolveThresholds will actually move on.
  {
    // Reset state
    fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons: [], performance: [] }, null, 2));
    // Reset config screening floors so evolution has headroom
    config.screening.minFeeActiveTvlRatio = 0.05;
    config.screening.minOrganic = 60;

    // 3 winners (high fee_tvl, high organic, +pnl) + 2 losers (low fee_tvl, low organic, -pnl)
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
    // evolveThresholds runs synchronously inside recordPerformance via dynamic import.
    // Successful evolution should push an [AUTO-EVOLVED ...] lesson.
    const evolved = lessons.lessons.some((l) =>
      typeof l.rule === "string" && l.rule.includes("AUTO-EVOLVED"),
    );
    assert(
      "evolveThresholds fired at the 5-close cadence",
      evolved,
      `lessons rules: ${lessons.lessons.map((l) => l.rule?.slice(0, 40)).join(" | ")}`,
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
