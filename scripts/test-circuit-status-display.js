// P3 — CB display fix (Cassiopeia).
// Verifies getCircuitStatus() distinguishes:
//   (1) benign "not-yet-seeded-today" (no state / stale-day state) → NOT halted (armed_pending_seed)
//   (2) real corrupt/unreadable file → halted / state_unreadable
// And confirms a genuinely halted today-state still reports halted (no deploy-safety loosening).
// No RPC, no LLM. Sandboxes the state file.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.OPENAI_API_KEY ||= "test-stub-key";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "circuit-breaker-state.json");
const BACKUP_FILE = STATE_FILE + ".testbackup2";

let hadExisting = false;
if (fs.existsSync(STATE_FILE)) {
  fs.renameSync(STATE_FILE, BACKUP_FILE);
  hadExisting = true;
}
function cleanState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
function restore() {
  cleanState();
  if (hadExisting && fs.existsSync(BACKUP_FILE)) fs.renameSync(BACKUP_FILE, STATE_FILE);
}
process.on("exit", restore);

const todayUtc = () => new Date().toISOString().slice(0, 10);
const yesterdayUtc = () =>
  new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

const { getCircuitStatus } = await import("../account-circuit-breaker.js");

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`PASS ${label}`); pass++; }
  else      { console.log(`FAIL ${label}`); fail++; }
}

// --- Case 1a: no state file at all (fresh install) → benign, NOT halted ---
cleanState();
{
  const s = getCircuitStatus();
  assert(s.halted === false, "1a: no-file → halted=false");
  assert(s.halt_reason === null, "1a: no-file → halt_reason null");
  assert(s.pending_seed === true, "1a: no-file → pending_seed=true");
  assert(s.status === "armed_pending_seed", "1a: no-file → status armed_pending_seed");
}

// --- Case 1b: stale (yesterday) state on disk → benign day-rollover, NOT halted ---
cleanState();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  date: yesterdayUtc(),
  starting_balance_sol: 1.0,
  realized_loss_sol: 0,
  realized_loss_pct: 0,
  positions_closed_today: 0,
  halted: false,
  halt_reason: null,
}));
{
  const s = getCircuitStatus();
  assert(s.halted === false, "1b: stale-day → halted=false (not state_unreadable)");
  assert(s.pending_seed === true, "1b: stale-day → pending_seed=true");
  assert(s.date === todayUtc(), "1b: stale-day → date reported as today");
}

// --- Case 1c: stale (yesterday) state that WAS halted yesterday → new day re-arms, NOT halted ---
cleanState();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  date: yesterdayUtc(),
  starting_balance_sol: 1.0,
  realized_loss_sol: 0.2,
  realized_loss_pct: 20,
  positions_closed_today: 3,
  halted: true,
  halt_reason: "Daily SOL loss cap hit",
}));
{
  const s = getCircuitStatus();
  assert(s.halted === false, "1c: yesterday-halted rolls to new day → halted=false");
  assert(s.pending_seed === true, "1c: yesterday-halted → pending_seed=true");
}

// --- Case 2: corrupt/unreadable file → REAL halt / state_unreadable ---
cleanState();
fs.writeFileSync(STATE_FILE, "{ this is not valid json ]]]");
{
  const s = getCircuitStatus();
  assert(s.halted === true, "2: corrupt file → halted=true");
  assert(s.halt_reason === "state_unreadable", "2: corrupt file → halt_reason state_unreadable");
}

// --- Case 3: genuinely halted TODAY state → still reports halted (no loosening) ---
cleanState();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  date: todayUtc(),
  starting_balance_sol: 1.0,
  realized_loss_sol: 0.12,
  realized_loss_pct: 12,
  positions_closed_today: 5,
  losing_closes_today: 4,
  winning_closes_today: 1,
  halted: true,
  halt_reason: "Daily SOL loss cap hit (0.1200 SOL ≥ 0.1 SOL)",
  halted_at: new Date().toISOString(),
}));
{
  const s = getCircuitStatus();
  assert(s.halted === true, "3: today halted → halted=true (genuine halt still surfaces)");
  assert(s.halt_reason.includes("Daily SOL loss cap"), "3: today halted → real halt_reason preserved");
  assert(s.pending_seed === undefined, "3: today halted → no pending_seed flag");
}

// --- Case 4: healthy TODAY state → not halted, normal fields ---
cleanState();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  date: todayUtc(),
  starting_balance_sol: 1.0,
  realized_loss_sol: 0.01,
  realized_loss_pct: 1,
  positions_closed_today: 2,
  losing_closes_today: 1,
  winning_closes_today: 1,
  halted: false,
  halt_reason: null,
}));
{
  const s = getCircuitStatus();
  assert(s.halted === false, "4: healthy today → halted=false");
  assert(s.realized_loss_sol === 0.01, "4: healthy today → real loss figures passed through");
  assert(s.pending_seed === undefined, "4: healthy today → no pending_seed flag");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
