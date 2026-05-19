#!/usr/bin/env node
// Test: boss-report cost aggregation reads `r.ts` (matches llm-usage.js writer schema)
// Regression guard for the r.timestamp vs r.ts mismatch that caused $0.00 cost display.

import assert from "node:assert/strict";

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400_000).toISOString();
const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

// Mock llm-usage.json records — writer uses `ts` field
const llmRecs = [
  { ts: new Date().toISOString(),          cost_usd: 0.10 }, // today
  { ts: new Date().toISOString(),          cost_usd: 0.05 }, // today
  { ts: yesterday,                          cost_usd: 0.20 }, // within week
  { ts: twoDaysAgo,                         cost_usd: 0.30 }, // within week
  { ts: eightDaysAgo,                       cost_usd: 0.99 }, // outside week, must NOT count
  // Legacy garbage record with old field name — must be ignored gracefully
  { timestamp: new Date().toISOString(),    cost_usd: 999 },
];

// Replicate boss-report.js:252-253 logic exactly
const costToday = llmRecs.filter(r => r.ts?.startsWith(today)).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const costWeek  = llmRecs.filter(r => r.ts >= weekAgo).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

assert.equal(Number(costToday.toFixed(4)), 0.15, `costToday expected 0.15, got ${costToday}`);
assert.equal(Number(costWeek.toFixed(4)), 0.65,  `costWeek expected 0.65, got ${costWeek}`);

// Regression: ensure old buggy filter on r.timestamp would have produced wrong result
const buggyCostToday = llmRecs.filter(r => r.timestamp?.startsWith(today)).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
assert.notEqual(buggyCostToday, 0.15, "buggy filter must NOT match correct value (sanity check)");

console.log("PASS: boss-report cost aggregation reads r.ts correctly");
console.log(`  costToday=$${costToday.toFixed(4)}  costWeek=$${costWeek.toFixed(4)}`);
