/**
 * Tests for boss-report.js new section generators.
 * Run: node scripts/test-boss-report-sections.js
 *
 * No real Telegram calls. No file I/O — section generators take in-memory
 * mock data. Each assertion logs pass/fail; non-zero exit on any failure.
 */
import {
  buildLessonsSection,
  buildDrawdownSection,
  buildOrionRejectionsSection,
} from "./boss-report.js";

let pass = 0;
let fail = 0;
const failures = [];

function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}

// ── Mock data ────────────────────────────────────────────────────
const nowIso = new Date().toISOString();
const recentIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
const oldIso = new Date(Date.now() - 48 * 3_600_000).toISOString();

const mockLessonsState = {
  lessons: [
    { id: 1, rule: "PREFER: high-organic tokens with bin_step=100",
      confidence: 0.88, outcome: "good", created_at: recentIso, tags: ["worked"] },
    { id: 2, rule: "AVOID: micro-cap pools with high bundle pct",
      confidence: 0.82, outcome: "bad", created_at: recentIso, tags: ["bundler"] },
    { id: 3, rule: "FAILED: low fee_tvl ratio under volume collapse",
      confidence: 0.55, outcome: "poor", created_at: oldIso, tags: ["volume_collapse"] },
    { id: 4, rule: "Manual: don't trade on weekend low liquidity",
      confidence: 0.30, outcome: "manual", created_at: oldIso, tags: ["manual"] },
  ],
  performance: [
    { source: "live",  pnl_pct: 4.2,  recorded_at: recentIso },
    { source: "paper", pnl_pct: -3.0, recorded_at: recentIso },
    { source: "paper", pnl_pct: 8.5,  recorded_at: recentIso },
    { source: "paper", pnl_pct: -7.0, recorded_at: oldIso },
  ],
};

const mockUserConfig = {
  minOrganic: 65,                // evolved from 60
  minFeeActiveTvlRatio: 0.05,    // default
  _lastEvolved: "2026-05-15T10:30:00Z",
};

const mockTrades = [
  {
    id: "p1", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "TKN-SOL", amount_sol: 0.1,
    max_drawdown_pct: 12.5, min_pnl_pct: -10, peak_pnl_pct: 2,
    final_pnl_pct: -3.0, close_action: "DRAWDOWN_RECOVERY",
  },
  {
    id: "p2", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "ABC-SOL", amount_sol: 0.1,
    max_drawdown_pct: 22.0, min_pnl_pct: -20, peak_pnl_pct: 0,
    final_pnl_pct: -20.0, close_action: "STOP_LOSS",
  },
  {
    id: "p3", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "XYZ-SOL", amount_sol: 0.1,
    max_drawdown_pct: 5.0, min_pnl_pct: -2, peak_pnl_pct: 6,
    final_pnl_pct: 5.5, close_action: "TAKE_PROFIT",
  },
  {
    // Older than 24h — should be excluded
    id: "p4", status: "closed", opened_at: oldIso, closed_at: oldIso,
    pool_name: "OLD-SOL", amount_sol: 0.1,
    max_drawdown_pct: 30.0, close_action: "STOP_LOSS",
  },
  {
    // Still open — should be ignored
    id: "p5", status: "open", opened_at: recentIso,
    pool_name: "OPEN-SOL", amount_sol: 0.1, max_drawdown_pct: 4.0,
  },
];

const mockSignalEntries = [
  { ts: recentIso, llm: { decision: "skip", reason: "Micro-cap with wash trading suggested by 5m vol/mcap ratio" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Micro-cap with wash trading suggested by 5m vol/mcap ratio" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Holder concentration above 60% top10" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "pass", reason: "passed" } }, // not a skip
  { ts: oldIso,    llm: { decision: "skip", reason: "Old skip outside 24h window" } }, // excluded
];

// ── Test: buildLessonsSection ───────────────────────────────────
console.log("\n[buildLessonsSection]");
{
  const text = buildLessonsSection(mockLessonsState, mockUserConfig);
  assert("returns non-null", text != null);
  assert("uses plain header 'Apa yang Dipelajari Bot'", text.includes("Apa yang Dipelajari Bot"));
  assert("states live close count (1) in plain language", text.includes("<b>1</b> posisi sungguhan"));
  assert("mentions tightened standards (minOrganic evolved)", text.includes("memperketat"));
  assert("includes last evolution timestamp", text.includes("2026-05-15"));
  assert("NO raw bin_step jargon", !/bin_step/.test(text));
  assert("NO raw fee_tvl_ratio jargon", !/fee_tvl_ratio/.test(text));
  assert("NO raw volatility= jargon", !/volatility=/.test(text));
  assert("renders plain insight sentence", /cenderung (menguntungkan|merugi)/.test(text));

  // Graceful degradation
  const empty = buildLessonsSection(null, {});
  assert("returns null on missing state", empty === null);
}

// ── Test: buildDrawdownSection ──────────────────────────────────
console.log("\n[buildDrawdownSection]");
{
  const text = buildDrawdownSection(mockTrades);
  assert("returns non-null", text != null);
  assert("contains header 'Drawdown Stats'", text.includes("Drawdown Stats"));
  assert("counts 3 closed (24h, excludes old + open)", text.includes("Closed paper: <b>3</b>"));
  assert("shows DD-Rec exit count = 1", /DD-Rec 1/.test(text));
  assert("shows SL exit count = 1", /SL 1/.test(text));
  assert("shows TP exit count = 1", /TP 1/.test(text));
  assert("worst drawdown is 22.00%", text.includes("22.00%"));

  const emptyText = buildDrawdownSection([]);
  assert("returns null on empty trades", emptyText === null);
}

// ── Test: buildOrionRejectionsSection ───────────────────────────
console.log("\n[buildOrionRejectionsSection]");
{
  const text = buildOrionRejectionsSection(mockSignalEntries);
  assert("returns non-null", text != null);
  assert("contains header 'Orion rejected'", text.includes("Orion rejected"));
  assert("total skip count is 6 (24h only)", text.includes("6 signals"));
  assert("top bucket: bundle pct (3 occurrences)", /3×.*Bundle pct/.test(text));
  assert("includes Micro-cap reason (2×)", /2×.*Micro-cap/.test(text));
  assert("excludes old skips (outside 24h)", !text.includes("Old skip"));
  assert("excludes pass decisions", !text.includes("passed"));

  const emptyText = buildOrionRejectionsSection([]);
  assert("returns null on empty signal entries", emptyText === null);
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
