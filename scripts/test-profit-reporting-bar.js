// PIECE 2 — Real-profit reporting bar test.
// Run: node scripts/test-profit-reporting-bar.js
//
// Asserts the honest win-rate machinery: a trade counts a WIN only when its TRUE
// realized SOL delta (net of IL+slippage+gas) clears the meaningful-profit bar
// (config.minMeaningfulProfitSol, default 0.005 SOL). Micro-profits are NOISE,
// not wins — answering Bro's "$0.001 dianggap profit". Tiers: NOISE<0.005,
// MARGINAL 0.005-0.02, REAL>=0.02, MEANINGFUL>=0.05.

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DRY_RUN = "true";

const { profitTier, classifyTrade, realizedSolOf, buildTradeSection } =
  await import("../scripts/boss-report.js");
const { isMeaningfulWin } = await import("../lessons.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// ── profitTier — the Lyra tier ladder ─────────────────────────────────────────
check("tier: -0.01 → LOSS", profitTier(-0.01) === "LOSS");
check("tier: 0 → NOISE", profitTier(0) === "NOISE");
check("tier: 0.001 ($0.001 trap) → NOISE", profitTier(0.001) === "NOISE");
check("tier: 0.0049 (just below bar) → NOISE", profitTier(0.0049) === "NOISE");
check("tier: 0.005 (bar) → MARGINAL", profitTier(0.005) === "MARGINAL");
check("tier: 0.019 → MARGINAL", profitTier(0.019) === "MARGINAL");
check("tier: 0.02 → REAL", profitTier(0.02) === "REAL");
check("tier: 0.049 → REAL", profitTier(0.049) === "REAL");
check("tier: 0.05 → MEANINGFUL", profitTier(0.05) === "MEANINGFUL");
check("tier: 0.5 → MEANINGFUL", profitTier(0.5) === "MEANINGFUL");
check("tier: NaN → UNKNOWN", profitTier(NaN) === "UNKNOWN");
check("tier: null → UNKNOWN", profitTier(null) === "UNKNOWN");

// ── realizedSolOf — pulls the TRUE net SOL, null when absent ──────────────────
check("realizedSolOf reads realized_sol_delta", realizedSolOf({ realized_sol_delta: 0.03 }) === 0.03);
check("realizedSolOf null when missing", realizedSolOf({ pnl_pct: 12 }) === null);
check("realizedSolOf null on non-finite", realizedSolOf({ realized_sol_delta: "x" }) === null);

// ── classifyTrade — HONEST win, realized-SOL based ────────────────────────────
const BAR = 0.005;

// The crux: a price-only WIN (+8% LP-PnL) that nets only 0.001 SOL is NOT a win.
const microTrap = classifyTrade({ realized_sol_delta: 0.001, pnl_pct: 8 }, BAR);
check("$0.001-trap: realized basis (not LP)", microTrap.basis === "realized");
check("$0.001-trap: NOT a win", microTrap.win === false);
check("$0.001-trap: tier NOISE", microTrap.tier === "NOISE");

// A real win: nets 0.03 SOL.
const realWin = classifyTrade({ realized_sol_delta: 0.03, pnl_pct: 4 }, BAR);
check("real win: win=true", realWin.win === true);
check("real win: tier REAL", realWin.tier === "REAL");

// A loss in realized terms even if LP-PnL looked flat-positive (IL ate it).
const ilLoss = classifyTrade({ realized_sol_delta: -0.02, pnl_pct: 1 }, BAR);
check("IL loss: win=false despite +LP-PnL", ilLoss.win === false);
check("IL loss: tier LOSS", ilLoss.tier === "LOSS");

// Legacy record (no realized field) → LP-PnL sign fallback, basis flagged.
const legacy = classifyTrade({ pnl_pct: 6 }, BAR);
check("legacy: lp_fallback basis", legacy.basis === "lp_fallback");
check("legacy: counted win via LP sign", legacy.win === true);
check("legacy: tier UNKNOWN", legacy.tier === "UNKNOWN");

// ── lessons.isMeaningfulWin mirrors the same bar ──────────────────────────────
check("isMeaningfulWin: 0.001 realized → false", isMeaningfulWin({ realized_sol_delta: 0.001 }, BAR) === false);
check("isMeaningfulWin: 0.006 realized → true", isMeaningfulWin({ realized_sol_delta: 0.006 }, BAR) === true);
check("isMeaningfulWin: legacy +LP → true", isMeaningfulWin({ pnl_pct: 3 }, BAR) === true);

// ── buildTradeSection — honest headline win-rate + tier distribution ──────────
// 4 live closes: 1 MEANINGFUL win, 1 micro-NOISE (was a fake win), 1 REAL win,
// 1 IL loss. Honest win-rate = 2/4 = 50% (NOT 75% that LP-sign would give).
const now = new Date().toISOString();
const liveRecs = [
  { source: "live", recorded_at: now, realized_sol_delta: 0.06, pnl_pct: 10 },  // MEANINGFUL win
  { source: "live", recorded_at: now, realized_sol_delta: 0.001, pnl_pct: 7 },  // NOISE (fake win)
  { source: "live", recorded_at: now, realized_sol_delta: 0.03, pnl_pct: 5 },   // REAL win
  { source: "live", recorded_at: now, realized_sol_delta: -0.04, pnl_pct: 2 },  // LOSS
];
const section = buildTradeSection(liveRecs, [], 0, 30, BAR);
check("section: honest 50% win-rate (not 75%)", /kemenangan:\s*<b>50%/.test(section));
check("section: discloses the win bar", new RegExp(`≥ ${BAR} SOL`).test(section));
check("section: flags NOISE trades not counted as win", /dihitung impas/.test(section));
check("section: shows tier distribution", /MEANINGFUL 1/.test(section) && /NOISE 1/.test(section) && /RUGI 1/.test(section));
check("section: net realized SOL line present", /Profit bersih/.test(section));
// Net realized = 0.06 + 0.001 + 0.03 - 0.04 = 0.051
check("section: net realized SOL = +0.0510", /\+0\.0510 SOL/.test(section));

// Empty window degrades gracefully.
const empty = buildTradeSection([], [], 0, 30, BAR);
check("section: no closes → graceful message", /Belum ada posisi sungguhan/.test(empty));

// ── config wiring: minMeaningfulProfitSol exists + reloadable ─────────────────
const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
check("config default minMeaningfulProfitSol ?? 0.005",
  /minMeaningfulProfitSol:\s*u\.minMeaningfulProfitSol\s*\?\?\s*0\.005/.test(cfgSrc));
check("config reload wires minMeaningfulProfitSol",
  /fresh\.minMeaningfulProfitSol\s*!=\s*null.*minMeaningfulProfitSol\s*=\s*fresh\.minMeaningfulProfitSol/s.test(cfgSrc));

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
