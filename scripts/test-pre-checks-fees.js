/**
 * test-pre-checks-fees.js — Cassiopeia 👁️
 *
 * Locks the FAIL-CLOSED contract of discord-listener/pre-checks.js feesCheck()
 * (anti-pattern #2: missing data = REJECT, never default to pass).
 *
 * Orion flagged feesCheck() as fail-OPEN: null fee data, NaN, and API errors all
 * returned { pass: true }. This test asserts they now REJECT, while the VALID-data
 * behavior (>= floor pass, < floor skip) is UNCHANGED.
 *
 * No network: global.fetch is stubbed per case. The floor is resolved the same way
 * feesCheck does (user-config minTokenFeesSol, default 15) so the valid-data cases
 * are correct regardless of this machine's override.
 *
 * Run: node scripts/test-pre-checks-fees.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Resolve the SAME floor feesCheck() will read (override-aware).
let FLOOR = 15;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "user-config.json"), "utf8"));
  FLOOR = cfg.screening?.minTokenFeesSol ?? cfg.minTokenFeesSol ?? 15;
} catch { /* default 15 */ }

const { feesCheck } = await import("../discord-listener/pre-checks.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const MINT = "FeEsTeStMint1111111111111111111111111111111";
const realFetch = global.fetch;

// Drive feesCheck with a stubbed Jupiter response. `feesValue` becomes token.fees.
function stubFetch({ ok = true, status = 200, feesValue, throwErr = false } = {}) {
  global.fetch = async () => {
    if (throwErr) throw new Error("network down");
    return {
      ok,
      status,
      json: async () => ([{ id: MINT, fees: feesValue }]),
    };
  };
}

try {
  // ── VALID DATA — behavior UNCHANGED by the fail-closed fix ──
  // floor+1 must PASS, floor-1 must SKIP (threshold-agnostic for this machine).
  stubFetch({ feesValue: FLOOR + 1 });
  let r = await feesCheck(MINT);
  check(`fee=${FLOOR + 1} (floor+1) → PASS (valid data, >= floor unchanged)`, r.pass === true && r.global_fees_sol === FLOOR + 1);

  stubFetch({ feesValue: FLOOR - 1 });
  r = await feesCheck(MINT);
  check(`fee=${FLOOR - 1} (floor-1) → REJECT (valid data, < floor unchanged)`, r.pass === false && /too low/.test(r.reason));

  // Explicit task contract (only meaningful when floor === 15; otherwise covered above).
  if (FLOOR === 15) {
    stubFetch({ feesValue: 16 });
    r = await feesCheck(MINT);
    check("fee=16 → PASS (>= 15)", r.pass === true);
    stubFetch({ feesValue: 14 });
    r = await feesCheck(MINT);
    check("fee=14 → REJECT (< 15)", r.pass === false);
  } else {
    console.log(`  NOTE  floor is ${FLOOR} on this machine (user-config override) — 16/14 contract covered by floor±1 cases above`);
  }

  // fee exactly at floor → at floor, not below → PASS (boundary unchanged)
  stubFetch({ feesValue: FLOOR });
  r = await feesCheck(MINT);
  check(`fee=${FLOOR} (exactly floor) → PASS (not below)`, r.pass === true);

  // ── FAIL-CLOSED — the holes Orion flagged ──
  stubFetch({ feesValue: null });
  r = await feesCheck(MINT);
  check("fee=null → REJECT token_fees_unknown (was fail-OPEN)", r.pass === false && /token_fees_unknown/.test(r.reason));

  stubFetch({ feesValue: undefined });
  r = await feesCheck(MINT);
  check("fee=undefined → REJECT token_fees_unknown (was fail-OPEN)", r.pass === false && /token_fees_unknown/.test(r.reason));

  // parseFloat("garbage") → NaN: must REJECT (non-finite), not silently pass.
  stubFetch({ feesValue: "not-a-number" });
  r = await feesCheck(MINT);
  check("fee=NaN (parseFloat garbage) → REJECT token_fees_unknown (was silent fail-OPEN)", r.pass === false && /token_fees_unknown/.test(r.reason));

  // API HTTP error (!res.ok) → throws internally → catch → REJECT, not pass.
  stubFetch({ ok: false, status: 503, feesValue: 50 });
  r = await feesCheck(MINT);
  check("Jupiter HTTP 503 → REJECT token_fees_unknown (was fail-OPEN on catch)", r.pass === false && /token_fees_unknown/.test(r.reason));

  // Network throw → catch → REJECT, not pass.
  stubFetch({ throwErr: true });
  r = await feesCheck(MINT);
  check("network error → REJECT token_fees_unknown (was fail-OPEN on catch)", r.pass === false && /token_fees_unknown/.test(r.reason));

  // Missing mint → REJECT, not pass (was fail-OPEN at the top of the fn).
  r = await feesCheck(null);
  check("no mint → REJECT fees_data_missing (was fail-OPEN)", r.pass === false && /fees_data_missing/.test(r.reason));
} finally {
  global.fetch = realFetch;
}

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
