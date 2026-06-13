// PIECE 1 — Judge profit-potential heuristic test.
// Run: node scripts/test-profit-heuristic.js
//
// Asserts the profit-share hint helpers (agents/orion.js profitShareHint +
// signal-judge.js signalProfitShareHint) produce the right tier
// (micro|thin|healthy), fail safe (null) on bad input, and — critically — that
// the prompt language frames this as a FACTOR, never a hard gate (anti-pattern
// #8: no dormancy). It also proves the heuristic is prompt-only (no extra LLM call).

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.DRY_RUN = "true";

const { profitShareHint } = await import("../agents/orion.js");
const { signalProfitShareHint } = await import("../signal-judge.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// ── Core economics: share = position/TVL × 100 ────────────────────────────────
// Our take ≈ our_position / pool_TVL. A huge-TVL pool shrinks it to dust.

// MICRO: 0.5 SOL @ $150 = $75 into a $1,000,000 TVL pool → 0.0075% share → dust.
const micro = profitShareHint(0.5, 1_000_000, 150);
check("micro: huge TVL → tier=micro", micro?.tier === "micro");
check("micro: fee_share_pct < 0.05", micro && micro.fee_share_pct < 0.05);

// THIN: $75 into $50,000 TVL → 0.15% share → marginal.
const thin = profitShareHint(0.5, 50_000, 150);
check("thin: mid TVL → tier=thin", thin?.tier === "thin");

// HEALTHY: $75 into $20,000 TVL → 0.375% share → meaningful capture.
const healthy = profitShareHint(0.5, 20_000, 150);
check("healthy: small TVL → tier=healthy", healthy?.tier === "healthy");

// Tier ordering must be monotonic as TVL shrinks (share grows).
check("share grows as TVL shrinks", micro.fee_share_pct < thin.fee_share_pct
  && thin.fee_share_pct < healthy.fee_share_pct);

// Exact RED-line boundary: 0.05% share is the $0.001 trap line.
// position/TVL = 0.0005 → share 0.05% → NOT micro (>= 0.05 is thin).
const atRedLine = profitShareHint(0.05, 100, null); // unitless: 0.05/100 = 0.05%
check("at 0.05% boundary → not micro (thin)", atRedLine?.tier === "thin");
const justBelowRed = profitShareHint(0.0499, 100, null); // 0.0499%
check("just below 0.05% → micro", justBelowRed?.tier === "micro");

// ── FAIL-SAFE (anti-pattern #2): bad input → null (neutral, never fabricate) ──
check("null TVL → null hint", profitShareHint(0.5, null, 150) === null);
check("zero TVL → null hint", profitShareHint(0.5, 0, 150) === null);
check("negative TVL → null hint", profitShareHint(0.5, -1, 150) === null);
check("NaN position → null hint", profitShareHint(NaN, 50000, 150) === null);
check("zero position → null hint", profitShareHint(0, 50000, 150) === null);
check("string garbage TVL → null hint", profitShareHint(0.5, "n/a", 150) === null);

// ── signal-judge hint mirrors orion (same tiers), probe size 0.05 SOL ─────────
const sigMicro = signalProfitShareHint(0.05, 1_000_000, 150);
check("signal: huge TVL → micro", sigMicro?.tier === "micro");
const sigHealthy = signalProfitShareHint(0.05, 2_000, 150);
check("signal: tiny TVL → healthy", sigHealthy?.tier === "healthy");
check("signal: null TVL → null (neutral)", signalProfitShareHint(0.05, null, 150) === null);

// Price-less path stays robust (compares raw position to TVL; tiers still order).
const noPrice = profitShareHint(0.5, 50000, null);
check("price-less hint still returns a tier", noPrice && typeof noPrice.tier === "string");

// ── ANTI-DORMANCY: prompt frames profit as a FACTOR, not a hard gate ──────────
const orionSrc = fs.readFileSync(new URL("../agents/orion.js", import.meta.url), "utf8");
check("orion prompt: profit factor present", /PROFIT-POTENTIAL FACTOR/.test(orionSrc));
check("orion prompt: explicitly NOT a hard gate", /do NOT hard-reject on it alone/i.test(orionSrc));
check("orion prompt: anti-dormancy guard (no skip clearly good pool)",
  /Never skip a clearly good pool solely on TVL size/i.test(orionSrc));
check("orion prompt: $0.001 micro-profit named", /\$0\.001/.test(orionSrc));

const sigSrc = fs.readFileSync(new URL("../signal-judge.js", import.meta.url), "utf8");
check("signal prompt: profit factor present", /PROFIT-POTENTIAL FACTOR/.test(sigSrc));
check("signal prompt: NOT a hard gate", /do NOT skip on it alone/i.test(sigSrc));
check("signal prompt: anti-dormancy guard", /never skip a clearly strong signal/i.test(sigSrc));

// ── COST: heuristic is prompt-only — no new LLM call site introduced. ─────────
// Assert the hint is computed locally (pure fn) and folded into the EXISTING
// payload, i.e. the chat.completions.create call count is unchanged. We prove
// this structurally: orion still has exactly one create() per judgeOne.
check("orion: still a single chat.completions.create per judge",
  (orionSrc.match(/chat\.completions\.create/g) || []).length === 1);
check("signal-judge: still a single chat.completions.create",
  (sigSrc.match(/chat\.completions\.create/g) || []).length === 1);

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
