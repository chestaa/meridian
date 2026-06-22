// Cassiopeia 👁️ — Bluechip LST-SOL deployability guard (Opsi 1 pivot).
//
// CONTEXT (Vega diagnosis): Opsi B deploys single-side SOL and assumes SOL = tokenY
// (the quote leg). That assumption is TRUE for memecoin pools (quote=SOL) and for
// LST-SOL pools (mint sort → LST=tokenX, wSOL=tokenY), but FALSE for SOL-USDC where
// SOL=tokenX (base) and USDC=quote → on-chain error 0x1 at deploy. The old guard
// `bluechipHasWsolLeg` ("either leg is wSOL") was TOO LOOSE — it let SOL-USDC through
// to enrich/judge/deploy. The fix tightens the deployability guard to require
// wSOL === tokenY (the QUOTE side) — `bluechipWsolQuoteRejectReason`.
//
// On-chain VERIFY (2026-06-22, dlmm.datapi.meteora.ag):
//   ✓ JitoSOL-SOL  BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U  wSOL=tokenY  TVL $2.44M
//   ✓ JupSOL-SOL   bNcdL9Hy85c9qb4hRavAUFtJUiyRPh3u96jerFqZQq6   wSOL=tokenY  TVL $56k
//   ✓ mSOL-SOL     2dBPJGLgNDZnzA32452zV2u6vensbo28dveBvecDg6X1  wSOL=tokenY  TVL $14k
//   ✗ SOL-mSOL     Brb4SiQUp9bAVWNnVtCZwTLd7twWDmAi7ZqjkqYg7RdN  wSOL=tokenX  (rejected)
//
// Run: node scripts/test-bluechip-lstsol-guard.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const {
  bluechipWsolQuoteRejectReason,
  bluechipHasWsolLeg,
  isBluechipMintPair,
  BLUECHIP_INCOME_MINTS,
} = await import("../tools/screening.js");

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1";
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";

const REJECT = "bluechip_wsol_not_quote_side";

// Helpers: build pools in the RAW token_x/token_y shape AND the condensed base/quote
// shape, since the guard must read both (poolLegMints handles both).
function raw(xMint, yMint, name) {
  return { name, token_x: { address: xMint }, token_y: { address: yMint } };
}
function condensed(baseMint, quoteMint, name) {
  return { name, base: { mint: baseMint }, quote: { mint: quoteMint } };
}

console.log("\n— LST-SOL DEPLOYABLE (wSOL = tokenY / quote → null reject) —");
{
  // JitoSOL-SOL: token_x=JitoSOL, token_y=wSOL → DEPLOYABLE
  const p = raw(JITOSOL, WSOL, "JitoSOL-SOL");
  check("JitoSOL-SOL (wSOL=tokenY) → deployable (null)", bluechipWsolQuoteRejectReason(p) === null);
}
{
  const p = raw(JUPSOL, WSOL, "JupSOL-SOL");
  check("JupSOL-SOL (wSOL=tokenY) → deployable (null)", bluechipWsolQuoteRejectReason(p) === null);
}
{
  const p = raw(MSOL, WSOL, "mSOL-SOL");
  check("mSOL-SOL (wSOL=tokenY) → deployable (null)", bluechipWsolQuoteRejectReason(p) === null);
}
{
  const p = condensed(BSOL, WSOL, "bSOL-SOL");
  check("bSOL-SOL condensed (wSOL=quote) → deployable (null)", bluechipWsolQuoteRejectReason(p) === null);
}

console.log("\n— SOL-USDC REJECTED (wSOL = tokenX / base, the 0x1 bug) —");
{
  // SOL-USDC: token_x=wSOL (base), token_y=USDC (quote) → REJECT
  const p = raw(WSOL, USDC, "SOL-USDC");
  check("SOL-USDC (wSOL=tokenX) → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
  // The OLD loose guard would have PASSED this (it has a wSOL leg) — prove the gap closed.
  check("SOL-USDC: old loose guard would have passed it", bluechipHasWsolLeg(p) === true);
}
{
  // SOL-mSOL: the inverted LST pool the API actually exposes (wSOL=tokenX) → REJECT
  const p = raw(WSOL, MSOL, "SOL-mSOL");
  check("SOL-mSOL (wSOL=tokenX) → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}
{
  const p = condensed(WSOL, USDC, "SOL-USDC condensed");
  check("SOL-USDC condensed (wSOL=base) → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}

console.log("\n— NO wSOL LEG AT ALL → rejected (cannot single-side-SOL seed) —");
{
  const p = raw(JITOSOL, USDC, "JitoSOL-USDC");
  check("JitoSOL-USDC (no wSOL leg) → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}

console.log("\n— FAIL-SAFE (anti-pattern #2): missing tokenY → reject, never default-pass —");
{
  const p = { name: "missing-y", token_x: { address: JITOSOL } }; // no token_y
  check("missing tokenY → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}
{
  const p = { name: "null-y", token_x: { address: JITOSOL }, token_y: { address: null } };
  check("null tokenY mint → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}
{
  const p = { name: "empty-y", token_x: { address: JITOSOL }, token_y: { address: "" } };
  check("empty-string tokenY mint → rejected", bluechipWsolQuoteRejectReason(p) === REJECT);
}
{
  check("null pool → rejected", bluechipWsolQuoteRejectReason(null) === REJECT);
}
{
  check("undefined pool → rejected", bluechipWsolQuoteRejectReason(undefined) === REJECT);
}

console.log("\n— LST mints confirmed in BLUECHIP_INCOME_MINTS (funnel admits them) —");
{
  check("JitoSOL in BLUECHIP_INCOME_MINTS", BLUECHIP_INCOME_MINTS.has(JITOSOL));
  check("mSOL in BLUECHIP_INCOME_MINTS", BLUECHIP_INCOME_MINTS.has(MSOL));
  check("bSOL in BLUECHIP_INCOME_MINTS", BLUECHIP_INCOME_MINTS.has(BSOL));
  check("jupSOL in BLUECHIP_INCOME_MINTS", BLUECHIP_INCOME_MINTS.has(JUPSOL));
  // both legs bluechip → classified as bluechip pool (LST + wSOL)
  check("JitoSOL+wSOL is a bluechip mint pair", isBluechipMintPair(JITOSOL, WSOL) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
