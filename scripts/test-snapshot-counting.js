#!/usr/bin/env node
/**
 * test-snapshot-counting.js — Sirius 🐺
 *
 * Unit-tests summarizeClosed() against synthetic lessons.json shapes.
 * Asserts the ZINC-SOL class bug (records-vs-performance schema mismatch)
 * cannot regress: closes within 24h MUST be counted.
 */
import { summarizeClosed } from './lib/snapshot-builder.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS — ${label}`); }
  else { failed++; console.error(`  FAIL — ${label}`); }
}
function eq(a, b, label) { assert(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, eps, label) {
  const ok = typeof a === 'number' && Math.abs(a - b) < eps;
  assert(ok, `${label} (got ${a}, want ~${b})`);
}

const NOW = Date.parse('2026-05-28T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;

// --- Case 1: ZINC-SOL repro — performance array with recorded_at in last 24h ---
{
  const lessons = {
    performance: [
      { pool_name: 'ZINC-SOL', recorded_at: new Date(NOW - 6 * H).toISOString(),
        pnl_pct: 12.5, amount_sol: 0.5, close_reason: 'Trailing TP: peak 18% → 12.5%' },
      { pool_name: 'FOO-SOL',  recorded_at: new Date(NOW - 20 * H).toISOString(),
        pnl_pct: -8.0, amount_sol: 0.5, close_reason: 'stop loss' },
      { pool_name: 'BAR-SOL',  recorded_at: new Date(NOW - 3 * D).toISOString(),
        pnl_pct: 5.0,  amount_sol: 0.5, close_reason: 'agent decision' },
    ],
  };
  console.log('Case 1: performance array, 2 closes in 24h, 1 win 1 loss');
  const r24 = summarizeClosed(lessons, D, NOW);
  eq(r24.count, 2, 'closed_24h_count');
  // pnl_sum = (12.5/100)*0.5 + (-8.0/100)*0.5 = 0.0625 - 0.04 = 0.0225
  near(r24.pnl_sum_sol, 0.0225, 1e-6, 'closed_24h_pnl_sum_sol');
  eq(r24.win_rate, 0.5, 'win_rate_24h');

  const r7 = summarizeClosed(lessons, 7 * D, NOW);
  eq(r7.count, 3, 'closed_7d_count');
  // + (5.0/100)*0.5 = +0.025 -> 0.0475
  near(r7.pnl_sum_sol, 0.0475, 1e-6, 'closed_7d_pnl_sum_sol');
  eq(r7.win_rate, 0.67, 'win_rate_7d (2/3 rounded)');
}

// --- Case 2: empty window → counts 0, win_rate null (not misleading 0) ---
{
  console.log('Case 2: no closes in window');
  const lessons = { performance: [
    { recorded_at: new Date(NOW - 10 * D).toISOString(), pnl_pct: 5, amount_sol: 0.5 },
  ] };
  const r = summarizeClosed(lessons, D, NOW);
  eq(r.count, 0, 'count=0');
  eq(r.pnl_sum_sol, 0, 'pnl_sum_sol=0');
  eq(r.win_rate, null, 'win_rate=null');
}

// --- Case 3: legacy `records` shape still works (fallback) ---
{
  console.log('Case 3: legacy records array fallback');
  const lessons = { records: [
    { closed_at: new Date(NOW - 2 * H).toISOString(), pnl_sol: 0.1 },
    { closed_at: new Date(NOW - 5 * H).toISOString(), pnl_sol: -0.05 },
  ] };
  const r = summarizeClosed(lessons, D, NOW);
  eq(r.count, 2, 'legacy count');
  near(r.pnl_sum_sol, 0.05, 1e-6, 'legacy pnl_sum');
  eq(r.win_rate, 0.5, 'legacy win_rate');
}

// --- Case 4: trailing TP counted as win even with tiny negative pct ---
{
  console.log('Case 4: Trailing TP close_reason as win');
  const lessons = { performance: [
    { recorded_at: new Date(NOW - 1 * H).toISOString(), pnl_pct: 25, amount_sol: 0.5,
      close_reason: 'Trailing TP: peak 30 → 25' },
  ] };
  const r = summarizeClosed(lessons, D, NOW);
  eq(r.count, 1, 'tp count');
  eq(r.win_rate, 1, 'tp win_rate');
}

// --- Case 5: future-dated record (clock skew) excluded ---
{
  console.log('Case 5: future timestamp excluded');
  const lessons = { performance: [
    { recorded_at: new Date(NOW + 5 * H).toISOString(), pnl_pct: 10, amount_sol: 0.5 },
  ] };
  const r = summarizeClosed(lessons, D, NOW);
  eq(r.count, 0, 'future excluded');
}

console.log(`\n[counting-test] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
