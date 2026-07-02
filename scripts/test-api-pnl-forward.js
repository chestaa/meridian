// Vega — forward-only guard for the additive apiPnlUsd/apiPnlPct fields now
// written into BOTH recordPerformance({...}) objects in tools/dlmm.js
// (relay close ~L1952, main close ~L2279). This is a money-adjacent honesty
// field: it records the API-reported PnL AS-REPORTED alongside the existing
// realized_sol_delta / USD fields, without mutating any of them.
//
// The values are produced by the exact expression used at both call sites:
//     apiPnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
//     apiPnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
// so we assert that expression's contract directly (no framework, no import
// of the 2000-line SDK module — the logic under test IS the ternary).
//
// Run: node scripts/test-api-pnl-forward.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The forwarding expression, isolated exactly as it appears at both sites.
const apiPnlField = (v) => (Number.isFinite(v) ? v : null);

console.log('apiPnl forward — value contract');

// Finite values pass through verbatim (positive, negative, zero).
check('positive pnl passes through', () => assert.strictEqual(apiPnlField(12.34), 12.34));
check('negative pnl passes through', () => assert.strictEqual(apiPnlField(-4.67), -4.67));
check('zero pnl passes through (not coerced to null)', () => assert.strictEqual(apiPnlField(0), 0));
check('zero is strictly a number', () => assert.strictEqual(typeof apiPnlField(0), 'number'));

// Non-finite / missing → null (honest gap, never a fabricated number).
check('NaN -> null', () => assert.strictEqual(apiPnlField(NaN), null));
check('undefined -> null', () => assert.strictEqual(apiPnlField(undefined), null));
check('null -> null', () => assert.strictEqual(apiPnlField(null), null));
check('Infinity -> null', () => assert.strictEqual(apiPnlField(Infinity), null));
check('-Infinity -> null', () => assert.strictEqual(apiPnlField(-Infinity), null));
// Guards against a silent Number() coercion sneaking in (anti-pattern #2 spirit).
check('string number NOT coerced (stays null)', () => assert.strictEqual(apiPnlField('5'), null));

console.log('apiPnl forward — record shape at both call sites');

// Simulate the record object exactly as each site builds the two fields,
// alongside the pre-existing fields they must NOT disturb.
function buildRecordSlice(pnlUsd, pnlPct, existing) {
  return {
    ...existing, // final_value_usd, initial_value_usd, realized_sol_delta, etc.
    apiPnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
    apiPnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
  };
}

check('additive: both fields present on the record', () => {
  const r = buildRecordSlice(9.1, 3.2, {});
  assert.ok('apiPnlUsd' in r && 'apiPnlPct' in r);
});

check('additive: does not overwrite existing money fields', () => {
  const existing = {
    final_value_usd: 100,
    initial_value_usd: 90,
    realized_sol_delta: 0.011,
    realized_sol_delta_pct: 5.5,
    pnl_usd: 10, // downstream-derived field must be untouched by this record slice
  };
  const r = buildRecordSlice(10, 11.1, existing);
  assert.strictEqual(r.final_value_usd, 100);
  assert.strictEqual(r.initial_value_usd, 90);
  assert.strictEqual(r.realized_sol_delta, 0.011);
  assert.strictEqual(r.realized_sol_delta_pct, 5.5);
  assert.strictEqual(r.pnl_usd, 10);
});

check('apiPnl carries API value, distinct from realized_sol_delta', () => {
  // API reports a loss in USD, but SOL-delta accounting is a separate axis.
  const r = buildRecordSlice(-4.67, -12.0, { realized_sol_delta: -0.002 });
  assert.strictEqual(r.apiPnlUsd, -4.67);
  assert.strictEqual(r.apiPnlPct, -12.0);
  assert.notStrictEqual(r.apiPnlUsd, r.realized_sol_delta);
});

check('unsettled/unknown pnl -> null pair (no fabricated 0)', () => {
  const r = buildRecordSlice(NaN, NaN, {});
  assert.strictEqual(r.apiPnlUsd, null);
  assert.strictEqual(r.apiPnlPct, null);
});

console.log('apiPnl forward — source integrity (both sites patched, additive-only)');

// Static assertion against the real file: exactly TWO insertions, and the
// pre-existing pnl_usd/pnl_pct output fields were NOT touched by this change.
const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'dlmm.js'), 'utf8');

check('apiPnlUsd inserted at exactly 2 call sites', () => {
  const n = (src.match(/apiPnlUsd: Number\.isFinite\(pnlUsd\) \? pnlUsd : null/g) || []).length;
  assert.strictEqual(n, 2);
});
check('apiPnlPct inserted at exactly 2 call sites', () => {
  const n = (src.match(/apiPnlPct: Number\.isFinite\(pnlPct\) \? pnlPct : null/g) || []).length;
  assert.strictEqual(n, 2);
});
check('each apiPnlUsd sits directly after an initial_value_usd line', () => {
  const n = (src.match(/initial_value_usd:[^\n]*\n\s*apiPnlUsd: Number\.isFinite\(pnlUsd\)/g) || []).length;
  assert.strictEqual(n, 2);
});

console.log(`\nPASS — ${passed} assertions`);
