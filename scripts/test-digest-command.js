/**
 * Test: /digest command builder
 * Validates digest data shape, format string, and section coverage.
 * Sirius signal-collector forensic harness.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatDigest, gatherDigestData, buildDigest } from "../digest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PAPER_FILE = path.join(ROOT, "paper-trades.json");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("=== /digest command tests ===\n");

// --- Test 1: formatDigest with synthetic mock data ---
console.log("[1] formatDigest with full mock data");
const mockData = {
  now: Date.now(),
  paper: {
    open_count: 3,
    today_realized_avg_pct: 4.2,
    biggest_winner: { label: "BONK-SOL", pnl: 12.5 },
    biggest_loser: { label: "PEPE-SOL", pnl: -3.1 },
  },
  verdicts: [
    { label: "POOL1", decision: "ENTER", confidence: 78, reason: "strong narrative + smart wallet" },
    { label: "POOL2", decision: "SKIP", confidence: 92, reason: "dev sold all" },
    { label: "POOL3", decision: "SKIP", confidence: 85, reason: "too late, mcap > 50k" },
  ],
  thresholds: {
    minOrganic: { current: 72, default: 60 },
    minFeeActiveTvlRatio: { current: 0.06, default: 0.05 },
  },
  llm_cost_today_usd: 0.012,
  circuit: { halted: false, realized_loss_sol: 0, cap_sol: 0.10, halt_reason: null },
  last_cycle_ago_ms: 4 * 60_000,
};

const html = formatDigest(mockData);
console.log("\n--- sample digest output ---");
console.log(html);
console.log("--- end sample ---\n");

assert(html.includes("MERIDIAN DIGEST"), "title present");
assert(html.includes("Paper trading"), "paper trading section present");
assert(html.includes("Open: 3 trades"), "open trade count rendered");
assert(html.includes("+4.2%"), "today realized avg formatted with sign");
assert(html.includes("BONK-SOL"), "biggest winner label rendered");
assert(html.includes("+12.5%"), "biggest winner pnl signed");
assert(html.includes("PEPE-SOL"), "biggest loser label rendered");
assert(html.includes("-3.1%"), "biggest loser pnl signed");
assert(html.includes("Last 3 Orion verdicts"), "orion verdicts section present");
assert(html.includes("POOL1 ENTER (78%)"), "verdict 1 formatted with confidence");
assert(html.includes("strong narrative"), "verdict 1 reason rendered");
assert(html.includes("POOL2 SKIP (92%)"), "verdict 2 formatted");
assert(html.includes("Evolved thresholds"), "thresholds section present");
assert(html.includes("minOrganic: 72 (default 60)"), "minOrganic current vs default");
assert(html.includes("minFeeActiveTvlRatio: 0.06 (default 0.05)"), "minFeeActiveTvlRatio rendered");
assert(html.includes("LLM cost today: $0.012"), "llm cost formatted with 3 decimals");
assert(html.includes("Circuit: armed"), "circuit armed status");
assert(html.includes("0.0000/0.1 SOL loss"), "circuit loss progress rendered");
assert(html.includes("Last cycle: 4 min ago"), "heartbeat freshness rendered");

// --- Test 2: halted circuit ---
console.log("\n[2] formatDigest with halted circuit");
const haltedData = {
  ...mockData,
  circuit: { halted: true, realized_loss_sol: 0.082, cap_sol: 0.10, halt_reason: "daily_loss_cap_sol" },
};
const haltedHtml = formatDigest(haltedData);
assert(haltedHtml.includes("halted"), "halted status rendered");
assert(haltedHtml.includes("daily_loss_cap_sol"), "halt reason rendered");
assert(haltedHtml.includes("0.0820/0.1 SOL"), "halted loss rendered");

// --- Test 3: empty state (no trades, no verdicts) ---
console.log("\n[3] formatDigest with empty state");
const emptyData = {
  now: Date.now(),
  paper: { open_count: 0, today_realized_avg_pct: null, biggest_winner: null, biggest_loser: null },
  verdicts: [],
  thresholds: {
    minOrganic: { current: 60, default: 60 },
    minFeeActiveTvlRatio: { current: 0.05, default: 0.05 },
  },
  llm_cost_today_usd: 0,
  circuit: { halted: false, realized_loss_sol: 0, cap_sol: 0.10, halt_reason: null },
  last_cycle_ago_ms: null,
};
const emptyHtml = formatDigest(emptyData);
assert(emptyHtml.includes("Open: 0 trades"), "zero open trades rendered");
assert(emptyHtml.includes("today realized: no closes yet"), "no realized closes fallback");
assert(emptyHtml.includes("no recent verdicts"), "empty verdicts fallback");
assert(emptyHtml.includes("Last cycle: never"), "no heartbeat fallback");

// --- Test 4: integration — gatherDigestData runs against real repo state ---
console.log("\n[4] gatherDigestData smoke test (real repo state)");
const real = gatherDigestData({ timers: { managementLastRun: Date.now() - 60_000, screeningLastRun: null } });
assert(typeof real === "object" && real !== null, "returns an object");
assert(typeof real.paper.open_count === "number", "paper.open_count is number");
assert(Array.isArray(real.verdicts), "verdicts is array");
assert(typeof real.thresholds.minOrganic.current === "number", "minOrganic current is number");
assert(typeof real.llm_cost_today_usd === "number" && real.llm_cost_today_usd >= 0, "llm cost is non-negative number");
assert(typeof real.circuit.halted === "boolean", "circuit.halted is boolean");
assert(real.last_cycle_ago_ms != null && real.last_cycle_ago_ms >= 0, "heartbeat computed from timers");

// --- Test 5: buildDigest end-to-end ---
console.log("\n[5] buildDigest end-to-end");
const built = buildDigest({ timers: { managementLastRun: Date.now(), screeningLastRun: Date.now() } });
assert(typeof built.html === "string" && built.html.length > 100, "produces non-trivial html");
assert(typeof built.data === "object", "exposes data alongside html");

// --- Test 6: WIB today-realized filter (synthetic paper-trades.json swap) ---
console.log("\n[6] WIB-local today-realized filter");
const paperBackup = fs.existsSync(PAPER_FILE) ? fs.readFileSync(PAPER_FILE, "utf8") : null;
try {
  const now = Date.now();
  const yesterdayWib = new Date(now - 30 * 60 * 60 * 1000).toISOString(); // ~30h ago
  const recentWib = new Date(now - 60 * 1000).toISOString(); // 1 min ago
  const synthetic = {
    trades: [
      { status: "closed", closed_at: yesterdayWib, fee_inclusive_pnl_pct: -15, pool_name: "OLD1" },
      { status: "closed", closed_at: yesterdayWib, fee_inclusive_pnl_pct: -15, pool_name: "OLD2" },
      { status: "closed", closed_at: yesterdayWib, fee_inclusive_pnl_pct: -15, pool_name: "OLD3" },
      { status: "closed", closed_at: recentWib, fee_inclusive_pnl_pct: 5, pool_name: "NEW1" },
      { status: "closed", closed_at: recentWib, fee_inclusive_pnl_pct: 5, pool_name: "NEW2" },
    ],
  };
  fs.writeFileSync(PAPER_FILE, JSON.stringify(synthetic));
  const dataMixed = gatherDigestData({ now });
  assert(dataMixed.paper.today_realized_avg_pct !== null, "mixed: today_realized_avg_pct is not null");
  assert(Math.abs(dataMixed.paper.today_realized_avg_pct - 5) < 0.01,
    `mixed: today avg is +5.0% (got ${dataMixed.paper.today_realized_avg_pct})`);
  const mixedHtml = formatDigest(dataMixed);
  assert(mixedHtml.includes("+5.0%"), "mixed: digest html shows +5.0%");
  assert(!mixedHtml.includes("-12") && !mixedHtml.includes("-15"), "mixed: no legacy losses bleeding into label");

  // All-legacy case
  const legacyOnly = {
    trades: synthetic.trades.filter((t) => t.pool_name.startsWith("OLD")),
  };
  fs.writeFileSync(PAPER_FILE, JSON.stringify(legacyOnly));
  const dataLegacy = gatherDigestData({ now });
  assert(dataLegacy.paper.today_realized_avg_pct === null, "all-legacy: today_realized_avg_pct is null");
  const legacyHtml = formatDigest(dataLegacy);
  assert(legacyHtml.includes("today realized: no closes yet"), "all-legacy: digest shows 'no closes yet'");
} finally {
  if (paperBackup !== null) fs.writeFileSync(PAPER_FILE, paperBackup);
  else fs.unlinkSync(PAPER_FILE);
}

// --- summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
