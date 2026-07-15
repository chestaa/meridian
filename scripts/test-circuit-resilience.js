// Test: circuit-breaker resilience to null wallet balance on day-rollover.
// - No real RPC, no real LLM. Uses __setWalletFetchForTest() injection hook.
// - Sandboxes state file by renaming pre-existing state before run, restores after.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.OPENAI_API_KEY ||= "test-stub-key";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "circuit-breaker-state.json");
const BACKUP_FILE = STATE_FILE + ".testbackup";

// Sandbox: move any existing state aside.
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

const cb = await import("../account-circuit-breaker.js");
const {
  assertCircuitOK,
  recordRealizedLoss,
  getCircuitStatus,
  manualReset,
  __setWalletFetchForTest,
  __setOpenCapitalReaderForTest,
  CircuitBreakerError,
  DAILY_LOSS_CAP_SOL,
} = cb;

// This suite tests wallet-balance resilience on a FLAT account (no open
// positions). Pin the open-capital reader to 0 so the seed = liquid balance
// deterministically, independent of the ambient state.json on disk.
__setOpenCapitalReaderForTest(() => 0);

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`PASS ${label}`); pass++; }
  else      { console.log(`FAIL ${label}`); fail++; }
}

// --- Case A: caller supplies valid balance → state seeded, returns OK ---
cleanState();
__setWalletFetchForTest(null);
try {
  await assertCircuitOK(0.5);
  assert(true, "A1: assertCircuitOK(0.5) returned without throw");
  const status = getCircuitStatus();
  assert(status.starting_balance_sol === 0.5, "A2: state seeded with starting_balance_sol=0.5");
  assert(status.halted === false, "A3: state not halted");
} catch (e) {
  assert(false, `A: unexpected throw: ${e.message}`);
}

// --- Case B: null balance + mocked wallet returns sol → seeds with fetched value (NEW) ---
cleanState();
__setWalletFetchForTest(async () => ({ sol: 0.4 }));
try {
  await assertCircuitOK(null);
  assert(true, "B1: assertCircuitOK(null) with mocked fetch returned without throw");
  const status = getCircuitStatus();
  assert(status.starting_balance_sol === 0.4, "B2: state seeded with self-fetched 0.4 SOL");
  assert(status.halted === false, "B3: not halted after recovery");
} catch (e) {
  assert(false, `B: unexpected throw: ${e.message}`);
}

// --- Case C: null balance + mocked wallet throws → preserved fail-safe halt ---
cleanState();
__setWalletFetchForTest(async () => { throw new Error("RPC down"); });
try {
  await assertCircuitOK(null);
  assert(false, "C1: should have thrown CircuitBreakerError (fail-safe)");
} catch (e) {
  assert(e instanceof CircuitBreakerError, "C1: threw CircuitBreakerError as fail-safe");
  assert(/unreadable/i.test(e.message), "C2: error message indicates state_unreadable");
}

// --- Case D: state already seeded for today + null balance → still OK (no rollover) ---
cleanState();
__setWalletFetchForTest(null);
await assertCircuitOK(1.0); // seed today
try {
  // Even with no fetch override, passing null should be fine — not on rollover branch.
  await assertCircuitOK(null);
  assert(true, "D1: null balance on already-seeded day returns OK (no rollover retry needed)");
  const status = getCircuitStatus();
  assert(status.starting_balance_sol === 1.0, "D2: starting balance unchanged (1.0)");
} catch (e) {
  assert(false, `D: unexpected throw: ${e.message}`);
}

// --- Case E: realized loss exceeds cap → CircuitBreakerError on next assert ---
cleanState();
__setWalletFetchForTest(null);
await assertCircuitOK(1.0);
// Force a loss >= DAILY_LOSS_CAP_SOL (0.10 SOL).
await recordRealizedLoss({
  pnl_pct: -100,
  amount_sol: DAILY_LOSS_CAP_SOL + 0.01,
  pool: "test_pool",
  pool_name: "TEST/SOL",
  reason: "test_loss",
});
const after = getCircuitStatus();
assert(after.halted === true, "E1: state.halted=true after loss exceeds cap");
try {
  await assertCircuitOK(null);
  assert(false, "E2: should have thrown CircuitBreakerError (cap hit)");
} catch (e) {
  assert(e instanceof CircuitBreakerError, "E2: threw CircuitBreakerError when halted");
  assert(/cap hit/i.test(e.message) || /loss/i.test(e.message), "E3: error message mentions cap/loss");
}

// Cleanup test hook
__setWalletFetchForTest(null);
__setOpenCapitalReaderForTest(null);
manualReset("test teardown");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
