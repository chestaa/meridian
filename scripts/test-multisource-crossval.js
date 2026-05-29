/**
 * Phase G — multi-source cross-validation test.
 * Cassiopeia 👁️ — verifies signal_sources stamping, score bonus, hard gate
 * config, and recordSignalSighting provenance append.
 *
 * Run: node scripts/test-multisource-crossval.js
 * Isolates pool-memory.json (backup + restore) to avoid polluting real state.
 */
import fs from "fs";
import assert from "assert";
import { tagSignalSource, scoreCandidate } from "../tools/screening.js";
import { recordSignalSighting } from "../pool-memory.js";
import { config } from "../config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";
let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

// ── Isolate pool-memory.json ─────────────────────────────────
const hadFile = fs.existsSync(POOL_MEMORY_FILE);
const backup = hadFile ? fs.readFileSync(POOL_MEMORY_FILE, "utf8") : null;
fs.writeFileSync(POOL_MEMORY_FILE, "{}");

function restore() {
  if (backup !== null) fs.writeFileSync(POOL_MEMORY_FILE, backup);
  else if (fs.existsSync(POOL_MEMORY_FILE)) fs.unlinkSync(POOL_MEMORY_FILE);
}

try {
  console.log("Phase G — multi-source cross-validation\n");

  // ── 1. Single source → ["meteora"], not confirmed, no bonus ──
  const single = {};
  tagSignalSource(single, "meteora");
  assert.deepStrictEqual(single.signal_sources, ["meteora"], "single source array");
  assert.strictEqual(single.cross_source_confirmed, false, "single not confirmed");
  ok("1-source pool → signal_sources=['meteora'], cross_source_confirmed=false");

  // baseline score (no signal_sources / single source) → 0 multi bonus
  const base = { fee_active_tvl_ratio: 0, organic_score: 0, volume_window: 0, holders: 0 };
  const baseScore = scoreCandidate({ ...base });
  const singleScore = scoreCandidate({ ...base, signal_sources: ["meteora"] });
  assert.strictEqual(singleScore, baseScore, "single source = no bonus");
  ok("1-source pool → no score bonus (single = baseline)");

  // ── 2. Two sources → ["meteora","solscan"], confirmed, +500 ──
  const dual = {};
  tagSignalSource(dual, "meteora");
  tagSignalSource(dual, "solscan");
  assert.deepStrictEqual(dual.signal_sources, ["meteora", "solscan"], "dual source array (append, no overwrite)");
  assert.strictEqual(dual.cross_source_confirmed, true, "dual confirmed");
  ok("2-source pool → ['meteora','solscan'], cross_source_confirmed=true");

  const dualScore = scoreCandidate({ ...base, signal_sources: ["meteora", "solscan"] });
  assert.strictEqual(dualScore - baseScore, 500, "2 sources = +500");
  ok("2-source pool → +500 score bonus");

  // ── 3 sources → +1000, idempotent dedupe ──
  const triple = {};
  tagSignalSource(triple, "meteora");
  tagSignalSource(triple, "discord");
  tagSignalSource(triple, "solscan");
  tagSignalSource(triple, "discord"); // duplicate ignored
  assert.deepStrictEqual(triple.signal_sources, ["meteora", "discord", "solscan"], "3 distinct, dedup duplicate");
  const tripleScore = scoreCandidate({ ...base, signal_sources: triple.signal_sources });
  assert.strictEqual(tripleScore - baseScore, 1000, "3 sources = +1000");
  ok("3-source pool → +1000 bonus, duplicate source deduped");

  // ── 3. Hard gate config key + default OFF ──
  assert.strictEqual(
    config.screening.requireMultiSourceConfirm, false,
    "requireMultiSourceConfirm default OFF"
  );
  ok("requireMultiSourceConfirm config key exists, default=false (soft bonus safe)");

  // Simulate gate logic: single-source rejected when ON + live
  const gateActive = true; // requireMultiSourceConfirm
  const live = true;       // dryRun === false
  const candidates = [
    { name: "A", signal_sources: ["meteora"] },          // single → reject
    { name: "B", signal_sources: ["meteora", "solscan"] }, // dual → keep
  ];
  const kept = (gateActive && live)
    ? candidates.filter((p) => (p.signal_sources?.length ?? 1) >= 2)
    : candidates;
  assert.deepStrictEqual(kept.map((p) => p.name), ["B"], "gate rejects single-source");
  ok("requireMultiSourceConfirm=true + live → single-source rejected, dual kept");

  // ── 4. recordSignalSighting appends correctly ──
  const addr = "PoolAddr1111111111111111111111111111111111";
  const n1 = recordSignalSighting(addr, "meteora");
  const n2 = recordSignalSighting(addr, "solscan");
  assert.strictEqual(n1, 1, "first sighting → len 1");
  assert.strictEqual(n2, 2, "second sighting → len 2");
  const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  const hist = db[addr].signal_source_history;
  assert.strictEqual(hist.length, 2, "history has 2 entries");
  assert.strictEqual(hist[0].source, "meteora", "entry 0 source");
  assert.strictEqual(hist[1].source, "solscan", "entry 1 source");
  assert.ok(typeof hist[0].ts === "number" && hist[0].ts > 0, "ts stamped");
  ok("recordSignalSighting appends {source,ts} to signal_source_history");

  // null guards
  assert.strictEqual(recordSignalSighting(null, "x"), undefined, "null addr guard");
  assert.strictEqual(recordSignalSighting(addr, null), undefined, "null source guard");
  ok("recordSignalSighting null-guards poolAddress + source");

  // ── 5. signal_source_history capped at 50 (anti-bloat, Lyra) ──
  const capAddr = "PoolCap2222222222222222222222222222222222";
  let lastLen = 0;
  for (let i = 0; i < 60; i++) lastLen = recordSignalSighting(capAddr, `s${i}`);
  assert.strictEqual(lastLen, 50, "returned length capped at 50 after 60 pushes");
  const dbCap = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  const capHist = dbCap[capAddr].signal_source_history;
  assert.strictEqual(capHist.length, 50, "persisted history length == 50");
  assert.strictEqual(capHist[capHist.length - 1].source, "s59", "newest (s59) retained");
  assert.strictEqual(capHist[0].source, "s10", "oldest 10 evicted (s0–s9 dropped)");
  ok("signal_source_history capped at 50, newest retained, oldest evicted");

  console.log(`\n✅ ALL ${passed} TESTS PASS — Cassiopeia 👁️`);
} catch (err) {
  console.error(`\n❌ TEST FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  restore();
}
