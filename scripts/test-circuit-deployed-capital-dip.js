// Regression: the deploy-path daily-loss guard must NEVER read a wallet-delta
// (day-start balance − current liquid balance) as a "daily loss."
//
// Incident 2026-07-14: a log line "[VEGA_DETERMINISTIC] blocked by safety check:
// circuit_breaker: daily loss reached" fired while a position was OPEN. The account
// circuit breaker itself never halted (realized_loss=0, halted=false, 2 winning
// closes). The scare came from misreading the mid-cycle LIQUID-balance dip (capital
// deployed, ~0.43 vs day-start ~0.688) as a loss. Same wallet-delta lie class killed
// in the notify path (f7abb852).
//
// This test PROVES the authoritative guard (account-circuit-breaker.assertCircuitOK,
// the same source runSafetyChecks uses at executor.js deploy-path) is honest:
//   1) mid-cycle deployed-capital dip (liquid low, realized_loss=0, halted=false)
//      → assertCircuitOK returns OK (NOT blocked). This is the bug that must not happen.
//   2) a genuine daily realized loss ≥ cap → STILL blocks (real halt preserved).
//   3) unreadable/corrupt CB state → fail-closed block (never opens the gate on error).
//
// No real RPC / LLM. Sandboxes the state file, restores after.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.OPENAI_API_KEY ||= "test-stub-key";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT, "circuit-breaker-state.json");
const BACKUP_FILE = STATE_FILE + ".dipbackup";

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
  CircuitBreakerError,
  DAILY_LOSS_CAP_SOL,
} = cb;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`PASS ${label}`); pass++; }
  else      { console.log(`FAIL ${label}`); fail++; }
}

// Day-start balance BEFORE any position was opened (matches incident: 0.688894).
const DAY_START = 0.688894;
// Mid-cycle LIQUID balance while ~0.25 SOL is deployed in an open position
// (matches incident: 0.431819). Recoverable capital, NOT a loss.
const MID_CYCLE_DIP = 0.431819;

// ─── Case 1: THE BUG — mid-cycle deployed-capital dip must NOT block ─────────
cleanState();
__setWalletFetchForTest(null);
// First deploy-check of the day seeds starting_balance from day-start balance.
await assertCircuitOK(DAY_START);
const seeded = getCircuitStatus();
assert(seeded.starting_balance_sol === DAY_START, "1a: seeded starting_balance = day-start 0.688894");
assert(seeded.realized_loss_sol === 0, "1b: realized_loss = 0 at day start");
assert(seeded.halted === false, "1c: not halted at day start");

// Now a position is OPEN — liquid balance has dipped hard. Deploy-check runs again
// and passes the DIPPED live balance (this is exactly what executor.js does:
// getWalletBalances().sol → assertCircuitOK). A wallet-delta guard would see
// 0.688894 − 0.431819 = 0.257 "loss" and block. The honest CB must NOT.
let blockedOnDip = false;
try {
  await assertCircuitOK(MID_CYCLE_DIP);
} catch (e) {
  blockedOnDip = true;
}
assert(blockedOnDip === false, "1d: mid-cycle deployed-capital dip does NOT block (the bug is gone)");

const afterDip = getCircuitStatus();
assert(afterDip.realized_loss_sol === 0, "1e: liquid dip did NOT register as realized loss (still 0)");
assert(afterDip.halted === false, "1f: liquid dip did NOT halt the breaker");
assert(
  afterDip.starting_balance_sol === DAY_START,
  "1g: starting_balance NOT re-seeded to the dipped 0.431819 (day already seeded)",
);

// ─── Case 2: REAL SAFETY — genuine daily realized loss ≥ cap STILL blocks ────
// (does not weaken the real halt)
cleanState();
__setWalletFetchForTest(null);
await assertCircuitOK(DAY_START);
await recordRealizedLoss({
  pnl_pct: -100,
  amount_sol: DAILY_LOSS_CAP_SOL + 0.01, // realized loss exceeds the 0.10 SOL cap
  pool: "real_loss_pool",
  pool_name: "LOSS/SOL",
  reason: "stop_loss",
});
const halted = getCircuitStatus();
assert(halted.halted === true, "2a: genuine realized loss ≥ cap sets halted=true");
assert(halted.realized_loss_sol >= DAILY_LOSS_CAP_SOL, "2b: realized_loss_sol >= cap");
let blockedOnRealLoss = false;
let realLossErr = null;
try {
  // Even a HEALTHY-looking liquid balance must not un-block a genuine halt.
  await assertCircuitOK(DAY_START);
} catch (e) {
  blockedOnRealLoss = true;
  realLossErr = e;
}
assert(blockedOnRealLoss === true, "2c: genuine realized-loss halt STILL blocks the deploy");
assert(realLossErr instanceof CircuitBreakerError, "2d: block is a CircuitBreakerError");
assert(/cap hit/i.test(realLossErr?.message || ""), "2e: reason cites the realized-loss cap (not a wallet dip)");

// ─── Case 3: FAIL-CLOSED — unreadable/corrupt CB state blocks ────────────────
cleanState();
fs.writeFileSync(STATE_FILE, "{ this is : not valid json ]");
__setWalletFetchForTest(null);
let blockedOnCorrupt = false;
let corruptErr = null;
try {
  await assertCircuitOK(DAY_START);
} catch (e) {
  blockedOnCorrupt = true;
  corruptErr = e;
}
assert(blockedOnCorrupt === true, "3a: corrupt CB state fails CLOSED (deploy blocked)");
assert(corruptErr instanceof CircuitBreakerError, "3b: fail-closed block is a CircuitBreakerError");
assert(/unreadable/i.test(corruptErr?.message || ""), "3c: reason indicates state_unreadable");

// Cleanup
__setWalletFetchForTest(null);
cleanState();
manualReset("test teardown");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
