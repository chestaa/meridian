// scripts/test-btc-equity-baseline.js — 24h equity baseline store + selection.
// Proves the circuit baseline is HONEST and FAIL-CLOSED: missing/young/stale =>
// null (=> circuit HALT), never a fabricated "no drawdown". Isolated tmp state.
// Run: node scripts/test-btc-equity-baseline.js

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-baseline-"));
process.env.BTC_TSMOM_EQUITY_BASELINE = path.join(tmp, "baseline.json");

const B = await import("../tsmom/btc-equity-baseline.js");

const now = new Date("2026-06-25T12:00:00Z");
const hoursAgo = (h) => new Date(now.getTime() - h * 3600000).toISOString();

// ── selectBaseline (pure) ──────────────────────────────────────────────────────
// No samples => null fail-closed.
ok(B.selectBaseline([], now).equityUsd === null, "empty samples => null (fail-closed)");
ok(B.selectBaseline([], now).reason === "no_samples_fail_closed", "empty => no_samples reason");

// Only young samples (< MIN_BASELINE_AGE_HOURS) => null (no true 24h anchor yet).
const young = [{ at: hoursAgo(2), equityUsd: 250 }, { at: hoursAgo(10), equityUsd: 248 }];
const sYoung = B.selectBaseline(young, now);
ok(sYoung.equityUsd === null && sYoung.reason === "baseline_too_young_fail_closed", "only-young samples => null too_young (HALT at cold start)");

// A ~24h sample => selected, age near 24.
const good = [{ at: hoursAgo(2), equityUsd: 230 }, { at: hoursAgo(24), equityUsd: 250 }, { at: hoursAgo(36), equityUsd: 260 }];
const sGood = B.selectBaseline(good, now);
ok(sGood.equityUsd === 250, "picks the ~24h-old sample as baseline");
ok(Math.abs(sGood.age_hours - 24) < 0.01, "selected age ~24h");

// Closest-to-24h wins among multiple in-window samples.
const multi = [{ at: hoursAgo(21), equityUsd: 240 }, { at: hoursAgo(23.5), equityUsd: 252 }, { at: hoursAgo(30), equityUsd: 270 }];
ok(B.selectBaseline(multi, now).equityUsd === 252, "closest-to-24h sample chosen among in-window");

// All samples too STALE (> MAX_BASELINE_AGE_HOURS) => null (runner stopped, don't trust).
const stale = [{ at: hoursAgo(60), equityUsd: 250 }, { at: hoursAgo(72), equityUsd: 255 }];
const sStale = B.selectBaseline(stale, now);
ok(sStale.equityUsd === null && sStale.reason === "baseline_stale_out_of_window_fail_closed", "all-stale => null stale (HALT)");

// Non-finite / non-positive equities ignored, fall through to fail-closed.
const bad = [{ at: hoursAgo(24), equityUsd: 0 }, { at: hoursAgo(25), equityUsd: "x" }];
ok(B.selectBaseline(bad, now).equityUsd === null, "non-finite/zero equities ignored => null");

// ── record + resolve round-trip (real file) ─────────────────────────────────────
const r1 = B.recordEquitySnapshot(250, new Date(hoursAgo(24)));
ok(r1.ok && r1.samples === 1, "record a 24h-old snapshot");
B.recordEquitySnapshot(230, now); // current mark
const resolved = B.resolveBaselineEquity(now);
ok(resolved.equityUsd === 250, "resolveBaselineEquity reads the persisted 24h baseline");

// Refuse a bogus (non-finite) snapshot — never poison the store with a fake 0.
ok(!B.recordEquitySnapshot(NaN).ok, "record refuses NaN equity (no fabricated snapshot)");
ok(!B.recordEquitySnapshot(-5).ok, "record refuses negative equity");

// resolve with no store at all => fail-closed.
process.env.BTC_TSMOM_EQUITY_BASELINE = path.join(tmp, "does-not-exist.json");
ok(B.resolveBaselineEquity(now).equityUsd === null, "no store file => null (fail-closed)");

console.log(`\nbtc-equity-baseline: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
