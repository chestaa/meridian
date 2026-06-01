// Cassiopeia — SOL-quote deployability pre-filter tests (Lyra cost-cut).
//
// This bot deploys single-side SOL ONLY (executor.js refuses amount_x>0). Pools
// quoted in anything but wSOL (USDC etc.) are UNDEPLOYABLE — judged then refused
// at deploy. solQuoteRejectReason() cuts them BEFORE the LLM judge to save cost.
//
// Covers:
//   - USDC-quoted pool       → reject (non_sol_quote_undeployable)
//   - SOL-quoted (wSOL) pool  → pass (null)
//   - missing quote mint      → reject (fail-safe, anti-pattern #2)
//   - empty-string quote mint → reject (fail-safe)
//   - flag OFF (requireSolQuote=false) → no filter (null) even for USDC
//   - flag explicitly true     → enforced
//
// Run: node scripts/test-sol-quote-filter.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { solQuoteRejectReason } = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Filter ENABLED (default — we ARE single-side SOL only)
const S_ON = { requireSolQuote: true };
// Filter DISABLED
const S_OFF = { requireSolQuote: false };

// 1. USDC-quoted pool → reject
{
  const pool = { name: "GACHA-USDC", quote: { symbol: "USDC", mint: USDC } };
  const reason = solQuoteRejectReason(pool, S_ON);
  check("USDC-quoted pool rejected", reason === "non_sol_quote_undeployable");
}

// 2. SOL-quoted (wSOL) pool → pass
{
  const pool = { name: "FOO-SOL", quote: { symbol: "SOL", mint: WSOL } };
  const reason = solQuoteRejectReason(pool, S_ON);
  check("wSOL-quoted pool passes (null)", reason === null);
}

// 3. Missing quote mint (no .mint key) → reject (fail-safe)
{
  const pool = { name: "BAR-?", quote: { symbol: "SOL" } };
  const reason = solQuoteRejectReason(pool, S_ON);
  check("missing quote mint rejected (fail-safe)", reason === "non_sol_quote_undeployable");
}

// 3b. Missing quote object entirely → reject (fail-safe)
{
  const pool = { name: "BAZ" };
  const reason = solQuoteRejectReason(pool, S_ON);
  check("missing quote object rejected (fail-safe)", reason === "non_sol_quote_undeployable");
}

// 3c. Empty-string quote mint → reject (fail-safe)
{
  const pool = { name: "QUX-?", quote: { symbol: "SOL", mint: "" } };
  const reason = solQuoteRejectReason(pool, S_ON);
  check("empty-string quote mint rejected (fail-safe)", reason === "non_sol_quote_undeployable");
}

// 4. Flag OFF → no filter, even USDC passes
{
  const pool = { name: "AVICI-USDC", quote: { symbol: "USDC", mint: USDC } };
  const reason = solQuoteRejectReason(pool, S_OFF);
  check("flag OFF → USDC not filtered (null)", reason === null);
}

// 4b. Flag OFF → missing quote also not filtered (filter inert)
{
  const pool = { name: "NOQUOTE" };
  const reason = solQuoteRejectReason(pool, S_OFF);
  check("flag OFF → missing quote not filtered (null)", reason === null);
}

// 5. requireSolQuote undefined (no flag) → treated as disabled (only ===true enables)
{
  const pool = { name: "AVICI-USDC", quote: { symbol: "USDC", mint: USDC } };
  const reason = solQuoteRejectReason(pool, {});
  check("flag undefined → disabled, no filter (null)", reason === null);
}

// 6. Config default is TRUE (we ARE SOL-only)
{
  const { config } = await import("../config.js");
  check("config.screening.requireSolQuote default === true", config.screening.requireSolQuote === true);
}

// 7. wSOL constant is the exact 32-byte mint (guard against abbreviation)
{
  const pool = { name: "NEAR-MISS", quote: { mint: "So1111111111111111111111111111111111111111" } }; // 1 char short
  const reason = solQuoteRejectReason(pool, S_ON);
  check("near-miss (short) wSOL mint rejected", reason === "non_sol_quote_undeployable");
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "SOL-quote filter tests must all pass");
