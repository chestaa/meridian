// Vega money-path hardening test (2026-07-12, Draco drain-forensic follow-up).
//
// Proves:
//  1. swapToken sends an explicit slippageBps (config cap) on the Jupiter order.
//  2. The pre-execution guard SKIPS the swap (never signs/sends) when the quoted
//     price impact exceeds the cap — token left in wallet, no bad fill.
//  3. The guard PASSES (swap allowed) when impact is within the cap, and does not
//     block when impact is unknown (on-chain slippageBps ceiling still applies).
//  4. resolveSwapMaxSlippageBps fails CLOSED to a safe default and is hard-clamped
//     to the ≤500 bps ceiling (an accidental fat-finger can't reopen the leak).
//  5. The dormant LPAgent relay zap-out path no longer hard-codes 5000 (50%) — it
//     is capped to the same config value.
//  6. The close/withdraw path is NOT gated by the swap slippage guard (close
//     always proceeds; only the optional post-close dust swap is guarded).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import {
  swapSlippageGuard,
  resolveSwapMaxSlippageBps,
  SWAP_SLIPPAGE_HARD_CEILING_BPS,
} from "../tools/wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ── 1. resolveSwapMaxSlippageBps: default + fail-closed + hard ceiling ───────
const origCfg = config.jupiter.swapMaxSlippageBps;

check("resolve: reads configured value (200 default)", () => {
  config.jupiter.swapMaxSlippageBps = 200;
  assert.strictEqual(resolveSwapMaxSlippageBps(), 200);
});

check("resolve: user can tune within ceiling (e.g. 300 = 3%)", () => {
  config.jupiter.swapMaxSlippageBps = 300;
  assert.strictEqual(resolveSwapMaxSlippageBps(), 300);
});

check("resolve: hard-clamps a fat-finger 5000 down to 500 ceiling", () => {
  config.jupiter.swapMaxSlippageBps = 5000;
  assert.strictEqual(resolveSwapMaxSlippageBps(), SWAP_SLIPPAGE_HARD_CEILING_BPS);
  assert.strictEqual(SWAP_SLIPPAGE_HARD_CEILING_BPS, 500);
});

check("resolve: NaN/null/undefined → fail-closed 200 (never unbounded)", () => {
  for (const bad of [NaN, null, undefined, "abc", {}]) {
    config.jupiter.swapMaxSlippageBps = bad;
    assert.strictEqual(resolveSwapMaxSlippageBps(), 200, `bad input ${String(bad)}`);
  }
});

check("resolve: zero / negative → fail-closed 200 (never disables the cap)", () => {
  for (const bad of [0, -1, -9999]) {
    config.jupiter.swapMaxSlippageBps = bad;
    assert.strictEqual(resolveSwapMaxSlippageBps(), 200, `bad input ${bad}`);
  }
});

config.jupiter.swapMaxSlippageBps = origCfg; // restore

// ── 2. swapSlippageGuard: block when impact > cap ────────────────────────────
check("guard: BLOCKS when priceImpactPct exceeds cap (3% impact vs 2% cap)", () => {
  const r = swapSlippageGuard({ priceImpactPct: "0.03" }, 200);
  assert.strictEqual(r.ok, false);
  assert.ok(/exceeds_cap/.test(r.reason), r.reason);
  assert.ok(Math.abs(r.priceImpactBps - 300) < 0.01);
});

check("guard: BLOCKS on a huge impact (thin-pool bag, 25%)", () => {
  const r = swapSlippageGuard({ priceImpactPct: "0.25" }, 200);
  assert.strictEqual(r.ok, false);
});

check("guard: negative-signed impact still measured by magnitude", () => {
  const r = swapSlippageGuard({ priceImpactPct: "-0.03" }, 200);
  assert.strictEqual(r.ok, false);
});

// ── 3. swapSlippageGuard: allow within cap / unknown ─────────────────────────
check("guard: PASSES when impact within cap (1% vs 2% cap)", () => {
  const r = swapSlippageGuard({ priceImpactPct: "0.01" }, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, "within_cap");
});

check("guard: PASSES exactly at cap boundary (2% == 200bps)", () => {
  const r = swapSlippageGuard({ priceImpactPct: "0.02" }, 200);
  assert.strictEqual(r.ok, true); // not strictly greater → allowed
});

check("guard: impact UNKNOWN → does not block (slippageBps is on-chain ceiling)", () => {
  for (const o of [{}, { priceImpactPct: null }, { priceImpactPct: "" }, { priceImpactPct: "xyz" }]) {
    const r = swapSlippageGuard(o, 200);
    assert.strictEqual(r.ok, true, JSON.stringify(o));
    assert.ok(/relying_on_slippage_bps/.test(r.reason), r.reason);
  }
});

// ── 4. Source integrity: active swap sends slippageBps ───────────────────────
const walletSrc = readFileSync(path.join(ROOT, "tools", "wallet.js"), "utf8");

check("wallet.js: swap order request sets slippageBps from the resolved cap", () => {
  assert.ok(
    /slippageBps:\s*String\(maxSlippageBps\)/.test(walletSrc),
    "expected slippageBps: String(maxSlippageBps) in the order search params",
  );
  assert.ok(/const maxSlippageBps = resolveSwapMaxSlippageBps\(\)/.test(walletSrc));
});

check("wallet.js: guard runs BEFORE deserialize/sign (skip path returns, no send)", () => {
  const guardIdx = walletSrc.indexOf("swapSlippageGuard(order, maxSlippageBps)");
  const signIdx = walletSrc.indexOf("VersionedTransaction.deserialize");
  assert.ok(guardIdx > -1 && signIdx > -1, "both markers present");
  assert.ok(guardIdx < signIdx, "guard must precede sign/serialize");
  // The skip path must return a non-success, skipped result (token left in wallet).
  assert.ok(/skipped:\s*true/.test(walletSrc));
  assert.ok(/reason:\s*"slippage_guard"/.test(walletSrc));
});

// ── 5. Relay path defused ────────────────────────────────────────────────────
const dlmmSrc = readFileSync(path.join(ROOT, "tools", "dlmm.js"), "utf8");

check("dlmm.js: relay zap-out no longer hard-codes slippageBps: 5000", () => {
  assert.ok(!/slippageBps:\s*5000/.test(dlmmSrc), "the 5000/50% leak must be gone");
});

check("dlmm.js: relay zap-out now uses resolveSwapMaxSlippageBps() cap", () => {
  assert.ok(/slippageBps:\s*resolveSwapMaxSlippageBps\(\)/.test(dlmmSrc));
  assert.ok(/resolveSwapMaxSlippageBps/.test(dlmmSrc.split("\n")[56] || dlmmSrc), "imported");
});

// ── 6. Close path NOT gated by the swap slippage guard ───────────────────────
check("dlmm.js: closePosition does NOT call the swap slippage guard (close never blocked)", () => {
  // The swap guard lives only in wallet.js swapToken. closePosition / withdraw
  // must not import or invoke it — closing always proceeds on-chain.
  assert.ok(!/swapSlippageGuard/.test(dlmmSrc), "close path must not reference the swap guard");
  // Sanity: closePosition exists and its DRY_RUN early-return is intact (unchanged).
  assert.ok(/export async function closePosition/.test(dlmmSrc));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
