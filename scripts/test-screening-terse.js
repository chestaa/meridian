// Test for the terse per-cycle screening Telegram notif (Sirius).
//
// Bro Dikta reads 2–5 line notifs only. These assertions lock in:
//   - funnel summary line ("N pool → M lolos filter → judge")
//   - outcome line (DEPLOY pool+size OR NO DEPLOY short reason)
//   - ≤5 lines, no tool-step echo, no raw jargon
//   - plain-language reason translation (no bin_step / fee_active_tvl_ratio)
//   - deploy vs no-deploy formats
//
// Pure JS, no LLM, no network. Run via:
//   node scripts/test-screening-terse.js

import { formatScreeningTerse, plainReason, shouldNotifyScreeningCycle, formatDormantRollup } from "../agents/andromeda.js";

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}
function contains(h, n, label) { ok(typeof h === "string" && h.includes(n), label); }
function notContains(h, n, label) { ok(typeof h === "string" && !h.includes(n), label); }
function lineCount(s) { return String(s).split("\n").length; }

const FIXED = new Date("2026-06-14T02:30:00Z"); // 09:30 WIB

// Raw jargon that must NEVER leak to Bro's notif.
const JARGON = ["bin_step", "fee_active_tvl_ratio", "fee_active_tvl", "organic_score", "tvl_mcap", "minFeeActiveTvlRatio", "volatility_30m"];

// ─── 1. No-deploy: thin TVL ──────────────────────────────────────────────
{
  const out = formatScreeningTerse({ universe: 1031, passed: 4, deployed: false, reason: "TVL $4000 below minTvl $10000", at: FIXED });
  console.log("\n[no-deploy / thin TVL]\n" + out + "\n");
  ok(lineCount(out) <= 5, "≤5 lines");
  ok(lineCount(out) >= 2, "≥2 lines");
  contains(out, "🔍 Screening 09.30 WIB", "line1: header + WIB time");
  contains(out, "1031 pool → 4 lolos filter → judge", "line2: funnel summary");
  contains(out, "NO DEPLOY", "line3: outcome NO DEPLOY");
  contains(out, "pool TVL tipis", "plain reason: TVL tipis");
  for (const j of JARGON) notContains(out, j, `no jargon: ${j}`);
  notContains(out, "✅", "no tool-step ✅ echo");
  notContains(out, "ℹ️", "no tool-step ℹ️ echo");
  notContains(out, "MARKET", "no MARKET dump");
  notContains(out, "REJECTED", "no REJECTED dump");
}

// ─── 2. Deploy ───────────────────────────────────────────────────────────
{
  const out = formatScreeningTerse({ universe: 1031, passed: 2, deployed: true, poolName: "PARQ-SOL", amountSol: 0.18, at: FIXED });
  console.log("[deploy]\n" + out + "\n");
  ok(lineCount(out) <= 5, "≤5 lines");
  contains(out, "🔍 Screening 09.30 WIB", "line1: header");
  contains(out, "1031 pool → 2 lolos → judge ENTER", "line2: funnel + ENTER");
  contains(out, "✅ DEPLOY: PARQ-SOL 0.18 SOL", "line3: deploy pool + size");
  for (const j of JARGON) notContains(out, j, `no jargon: ${j}`);
  notContains(out, "MARKET", "no MARKET dump");
  notContains(out, "AUDIT", "no AUDIT dump");
}

// ─── 3. No candidates lolos ──────────────────────────────────────────────
{
  const out = formatScreeningTerse({ universe: 980, passed: 0, deployed: false, reason: "no candidates", at: FIXED });
  console.log("[no candidates]\n" + out + "\n");
  ok(lineCount(out) <= 5, "≤5 lines");
  contains(out, "980 pool → 0 lolos filter → judge", "funnel 0 lolos");
  contains(out, "ga ada kandidat lolos", "plain reason: ga ada kandidat");
}

// ─── 4. Judge WATCH / no-enter ───────────────────────────────────────────
{
  const out = formatScreeningTerse({ universe: 1102, passed: 3, deployed: false, reason: "judge no enter", at: FIXED });
  console.log("[judge no enter]\n" + out + "\n");
  contains(out, "1102 pool → 3 lolos filter → judge", "funnel summary");
  contains(out, "judge ga ENTER", "plain reason: judge ga ENTER");
}

// ─── 5. Infra failure (429) ──────────────────────────────────────────────
{
  const out = formatScreeningTerse({ universe: null, passed: 0, failed: true, reason: "fetch failed: 429 Too Many Requests", at: FIXED });
  console.log("[429 failure]\n" + out + "\n");
  ok(lineCount(out) <= 5, "≤5 lines");
  contains(out, "NO DEPLOY", "outcome marker present (passes exec gate)");
  contains(out, "429", "plain reason mentions 429");
}

// ─── 6. Unknown universe renders gracefully ──────────────────────────────
{
  const out = formatScreeningTerse({ universe: null, passed: 0, deployed: false, reason: "fee/TVL below floor", at: FIXED });
  contains(out, "? pool → 0 lolos filter → judge", "unknown universe → '?'");
  contains(out, "fee kekecilan", "plain reason: fee kekecilan");
}

// ─── 7. plainReason translation coverage ─────────────────────────────────
{
  ok(plainReason("TVL $4000 below minTvl") === "pool TVL tipis", "plainReason: TVL low");
  ok(plainReason("fee_active_tvl_ratio 0.03 below minFeeActiveTvlRatio") === "fee kekecilan", "plainReason: fee low");
  ok(plainReason("liquidity_removal_rugpull") === "kandidat berisiko rug", "plainReason: rug");
  ok(plainReason("bot holders 40% > 25%") === "holder mencurigakan", "plainReason: bots");
  ok(plainReason("non_sol_quote_undeployable") === "pool bukan pair SOL", "plainReason: non-sol");
  ok(plainReason("volume $200 below minVolume") === "pool sepi", "plainReason: low volume");
  ok(plainReason(null) === "ga ada kandidat lolos", "plainReason: null fallback");
  // No raw jargon leaks through any translation.
  for (const j of JARGON) notContains(plainReason("fee_active_tvl_ratio 0.03"), j, `plainReason no jargon: ${j}`);
}

// ─── 8. Deploy with missing amount renders without crash ─────────────────
{
  const out = formatScreeningTerse({ universe: 500, passed: 1, deployed: true, poolName: "FOO-SOL", amountSol: null, at: FIXED });
  contains(out, "✅ DEPLOY: FOO-SOL ?", "deploy missing amount → '?'");
  ok(lineCount(out) <= 5, "≤5 lines even with missing data");
}

// ─── 9. REASON ACCURACY: pool reached judge → judge verdict, NOT "fee kekecilan" ──
// The bug: an Orion no-enter verdict whose text merely mentions fees got mapped
// to "fee kekecilan" even though the pool already passed the fee floor.
{
  // Pool passed filter (passed>0) and the judge text mentions fees → must be judge ga ENTER.
  const out = formatScreeningTerse({ universe: 1031, passed: 1, deployed: false, reason: "fees too low to justify the IL risk, not worth entering", at: FIXED });
  console.log("\n[reached judge, verdict mentions fees]\n" + out + "\n");
  contains(out, "judge ga ENTER", "passed pool + fee-mentioning verdict → judge ga ENTER (NOT fee kekecilan)");
  notContains(out, "fee kekecilan", "NOT mis-mapped to fee kekecilan");

  // passedFilter=true with a WATCH verdict → WATCH.
  ok(plainReason("WATCH — wait for organic to confirm", true) === "judge WATCH (belum ENTER)", "passedFilter + WATCH → judge WATCH");
  // passedFilter=true with generic/empty → judge ga ENTER (not 'ga ada kandidat').
  ok(plainReason("", true) === "judge ga ENTER", "passedFilter + empty → judge ga ENTER");
  ok(plainReason("the candidate did not clear my bar", true) === "judge ga ENTER", "passedFilter + generic → judge ga ENTER");

  // passedFilter=false: an EXPLICIT gate string still maps to the pool-quality phrase.
  ok(plainReason("fee_active_tvl_ratio 0.03 below minFeeActiveTvlRatio", false) === "fee kekecilan", "gate string + not-passed → fee kekecilan (still accurate)");
}

// ─── 10. SPAM CONTROL: who gets a per-cycle notif ────────────────────────
{
  // (a) DEPLOY → always notify.
  const dep = shouldNotifyScreeningCycle({ deployed: true }, { dormantStreak: 0 });
  ok(dep.notify === true && dep.kind === "deploy", "(a) DEPLOY → notify (kind=deploy)");

  // (b) routine dormant no-deploy → suppressed (no notify) for non-rollup cycles.
  const d1 = shouldNotifyScreeningCycle({ deployed: false, reason: "no candidates" }, { dormantStreak: 1, rollupEvery: 8 });
  ok(d1.notify === false && d1.kind === "none", "(b) dormant cycle 1 → suppressed");
  const d7 = shouldNotifyScreeningCycle({ deployed: false, reason: "judge no enter" }, { dormantStreak: 7, rollupEvery: 8 });
  ok(d7.notify === false, "(b) dormant cycle 7 → still suppressed");

  // (b') throttled rollup at the Nth consecutive dormant cycle.
  const d8 = shouldNotifyScreeningCycle({ deployed: false, reason: "no candidates" }, { dormantStreak: 8, rollupEvery: 8 });
  ok(d8.notify === true && d8.kind === "rollup", "(b') dormant cycle 8 → ONE rollup notif");
  const d16 = shouldNotifyScreeningCycle({ deployed: false, reason: "no candidates" }, { dormantStreak: 16, rollupEvery: 8 });
  ok(d16.notify === true && d16.kind === "rollup", "(b') dormant cycle 16 → rollup again");

  // (c) material: cycle threw (failed) → notify.
  const failCycle = shouldNotifyScreeningCycle({ deployed: false, failed: true, reason: "boom" }, { dormantStreak: 3 });
  ok(failCycle.notify === true && failCycle.kind === "material", "(c) failed cycle → notify (material)");

  // (d) material: infra reason (429 / balance / positions full) → notify even mid-streak.
  const rl = shouldNotifyScreeningCycle({ deployed: false, reason: "fetch failed: 429 Too Many Requests" }, { dormantStreak: 3 });
  ok(rl.notify === true && rl.kind === "material", "(d) 429 → notify (material), not suppressed");
  // "posisi penuh" is a ROUTINE dormant state, NOT material — must stay suppressed.
  const full = shouldNotifyScreeningCycle({ deployed: false, reason: "max positions reached" }, { dormantStreak: 3, rollupEvery: 8 });
  ok(full.notify === false && full.kind === "none", "max positions = routine dormant → suppressed (not material)");

  // legacy/verbose override: notifyDormant=true → every cycle notifies.
  const verbose = shouldNotifyScreeningCycle({ deployed: false, reason: "no candidates" }, { dormantStreak: 1, notifyDormant: true });
  ok(verbose.notify === true, "notifyDormantCycles=true → notify every cycle (legacy)");
}

// ─── 11. Dormant rollup format ───────────────────────────────────────────
{
  const out = formatDormantRollup({ count: 8, dominantReason: "no candidates", lastAt: FIXED });
  console.log("[dormant rollup]\n" + out + "\n");
  ok(lineCount(out) === 2, "rollup is 2 lines");
  contains(out, "🔍 Screening 09.30 WIB", "rollup line1: header");
  contains(out, "8 cycle no-deploy berturut", "rollup line2: streak count");
  contains(out, "ga ada kandidat lolos", "rollup line2: plain dominant reason");
  for (const j of JARGON) notContains(out, j, `rollup no jargon: ${j}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
