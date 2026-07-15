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
  __setOpenCapitalReaderForTest,
  computeSeedBalance,
  CircuitBreakerError,
  DAILY_LOSS_CAP_SOL,
} = cb;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`PASS ${label}`); pass++; }
  else      { console.log(`FAIL ${label}`); fail++; }
}

// Default fixture: FLAT account (no open positions) so the day-start seed equals
// the liquid balance for Cases 1-3, independent of the ambient state.json. New
// Cases 4-6 override this to simulate mid-cycle open capital.
__setOpenCapitalReaderForTest(() => 0);

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

// ─── Case 4: THE BASELINE FIX — day-rollover seed WHILE a position is OPEN ────
// This is the 2026-07-15 recurrence: the DAILY-RESET itself captured the baseline
// mid-cycle while ~0.23 SOL was deployed, so starting_balance was seeded at the
// dipped LIQUID 0.43 instead of the true ~0.69 total → realized_loss_pct inflated
// → false "drain" in the reports. With the fix, the seed = liquid + committed
// open capital = TOTAL ACCOUNT VALUE, so the baseline is honest.
cleanState();
__setWalletFetchForTest(null);
const OPEN_CAPITAL = 0.23;          // committed principal in the open position
const LIQUID_AT_ROLLOVER = 0.43;    // depressed liquid (capital is deployed)
__setOpenCapitalReaderForTest(() => OPEN_CAPITAL);
await assertCircuitOK(LIQUID_AT_ROLLOVER); // first deploy-check of the new day → seeds
const seededMidCycle = getCircuitStatus();
assert(
  Math.abs(seededMidCycle.starting_balance_sol - (LIQUID_AT_ROLLOVER + OPEN_CAPITAL)) < 1e-9,
  "4a: mid-cycle seed = liquid + open-capital (total value 0.66), NOT dipped liquid 0.43",
);
assert(seededMidCycle.starting_balance_sol > LIQUID_AT_ROLLOVER, "4b: baseline strictly above dipped liquid");
assert(seededMidCycle.realized_loss_sol === 0, "4c: no realized loss at seed");
assert(seededMidCycle.halted === false, "4d: not halted at seed");
// A small REAL realized loss now reads as a small pct against the HONEST baseline,
// not an inflated one — no phantom drain. (0.02 SOL loss / 0.66 = ~3.0%, not ~4.6%.)
await recordRealizedLoss({ pnl_pct: -100, amount_sol: 0.02, pool: "p", pool_name: "X/SOL", reason: "sl" });
const afterSmallLoss = getCircuitStatus();
const honestPct = (0.02 / (LIQUID_AT_ROLLOVER + OPEN_CAPITAL)) * 100;
assert(
  Math.abs(afterSmallLoss.realized_loss_pct - honestPct) < 0.05,
  "4e: realized_loss_pct computed against TOTAL-value baseline (honest ~3.0%, not inflated ~4.6%)",
);
assert(afterSmallLoss.halted === false, "4f: small real loss does NOT halt (well under 0.10 SOL cap)");

// ─── Case 5: REAL HALT PRESERVED with the larger (correct) baseline ──────────
// The absolute SOL cap is baseline-independent — a genuine loss ≥ 0.10 SOL still
// halts even though the baseline is now larger (which only relaxes the % cap).
cleanState();
__setWalletFetchForTest(null);
__setOpenCapitalReaderForTest(() => 0.23); // baseline padded by committed capital
await assertCircuitOK(0.43);
await recordRealizedLoss({
  pnl_pct: -100,
  amount_sol: DAILY_LOSS_CAP_SOL + 0.01, // genuine realized loss exceeds the 0.10 SOL cap
  pool: "real_loss_pool",
  pool_name: "LOSS/SOL",
  reason: "stop_loss",
});
const haltedBig = getCircuitStatus();
assert(haltedBig.halted === true, "5a: genuine loss ≥ 0.10 SOL cap STILL halts (larger baseline does not mask it)");
let blocked5 = false, err5 = null;
try { await assertCircuitOK(0.43); } catch (e) { blocked5 = true; err5 = e; }
assert(blocked5 === true, "5b: halted breaker still blocks the deploy");
assert(err5 instanceof CircuitBreakerError && /cap hit/i.test(err5?.message || ""), "5c: cites the realized-loss cap");

// ─── Case 6: FAIL-CLOSED — open-capital unreadable falls back to liquid-only ──
// If state.json can't be read, the reader returns null; the seed must NOT throw
// and must NOT inflate — it falls back to the conservative liquid-only baseline
// (smaller denominator = over-halt bias, never under-halt).
cleanState();
__setWalletFetchForTest(null);
__setOpenCapitalReaderForTest(() => null); // simulate unreadable state.json
let threw6 = false;
try { await assertCircuitOK(0.43); } catch (e) { threw6 = true; }
assert(threw6 === false, "6a: unreadable open-capital does NOT throw (graceful fallback)");
const seededFallback = getCircuitStatus();
assert(seededFallback.starting_balance_sol === 0.43, "6b: fallback baseline = liquid-only (conservative), no inflation");
assert(seededFallback.halted === false, "6c: fallback still arms the breaker");

// Pure-fn direct check of the conservative fallback contract.
assert(computeSeedBalance(0.43, null) === 0.43, "6d: computeSeedBalance(liquid, null) = liquid (fallback)");
assert(computeSeedBalance(0.43, 0.23) === 0.66, "6e: computeSeedBalance adds committed capital");
assert(computeSeedBalance(0.43, -5) === 0.43, "6f: negative/garbage capital contributes 0 (never inflates)");
assert(computeSeedBalance(null, 0.23) === null, "6g: null liquid passes through (caller fail-safe halt intact)");

// Cleanup
__setWalletFetchForTest(null);
__setOpenCapitalReaderForTest(null);
cleanState();
manualReset("test teardown");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
