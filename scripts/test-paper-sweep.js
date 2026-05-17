// scripts/test-paper-sweep.js
// Andromeda — verify legacy paper-trade sweep closes matured trades correctly,
// respects --dry, populates final_pnl_pct from last snapshot, and is idempotent.
// Uses a temp paper-trades.json swap so we don't touch the real file.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REAL = path.resolve("./paper-trades.json");
const BACKUP = path.resolve("./paper-trades.json.test-backup");

// Stash any existing live file so the sweep operates on our fixture only.
const hadReal = fs.existsSync(REAL);
if (hadReal) fs.renameSync(REAL, BACKUP);

function fixture() {
  return {
    trades: [
      {
        id: "paper_m1",
        status: "matured",
        opened_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
        pool_address: "POOL_M1",
        pool_name: "AAA-SOL",
        amount_sol: 0.05,
        entry_price: 1.0,
        latest_snapshot: { ts: new Date().toISOString(), price: 1.12, price_proxy_pnl_pct: 12, fee_inclusive_pnl_pct: 13.5 },
        notes: [],
      },
      {
        id: "paper_m2",
        status: "matured",
        opened_at: new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
        pool_address: "POOL_M2",
        pool_name: "BBB-SOL",
        amount_sol: 0.05,
        entry_price: 1.0,
        latest_snapshot: { ts: new Date().toISOString(), price: 0.92, price_proxy_pnl_pct: -8, fee_inclusive_pnl_pct: -7.5 },
        notes: [],
      },
      {
        id: "paper_m3",
        status: "matured",
        opened_at: new Date(Date.now() - 27 * 3600 * 1000).toISOString(),
        pool_address: "POOL_M3",
        pool_name: "CCC-SOL",
        amount_sol: 0.05,
        entry_price: 1.0,
        // No latest_snapshot — fallback chain hits peak_pnl_pct
        peak_pnl_pct: 4.2,
        notes: [],
      },
      {
        id: "paper_open1",
        status: "open",
        opened_at: new Date().toISOString(),
        pool_address: "POOL_O1",
        pool_name: "DDD-SOL",
        amount_sol: 0.05,
        entry_price: 1.0,
        latest_snapshot: { ts: new Date().toISOString(), price: 1.01, price_proxy_pnl_pct: 1 },
        notes: [],
      },
      {
        id: "paper_open2",
        status: "open",
        opened_at: new Date().toISOString(),
        pool_address: "POOL_O2",
        pool_name: "EEE-SOL",
        amount_sol: 0.05,
        entry_price: 1.0,
        latest_snapshot: null,
        notes: [],
      },
    ],
  };
}

function writeFixture() {
  fs.writeFileSync(REAL, JSON.stringify(fixture(), null, 2));
}
function readJson() {
  return JSON.parse(fs.readFileSync(REAL, "utf8"));
}

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

try {
  // Dynamic import AFTER fixture is in place so module reads the right file.
  writeFixture();
  const { sweepMaturedPaperTrades } = await import("../paper-trades.js");

  console.log("test-paper-sweep.js — legacy paper sweep");

  // 1. Dry run — reports 3, writes nothing
  {
    const result = sweepMaturedPaperTrades({ dryRun: true });
    check("dry: swept count is 3", () => assert.equal(result.swept, 3));
    check("dry: results length is 3", () => assert.equal(result.results.length, 3));
    const onDisk = readJson();
    const stillMatured = onDisk.trades.filter((t) => t.status === "matured" && !t.closed_at);
    check("dry: no trades mutated on disk", () => assert.equal(stillMatured.length, 3));
    check("dry: avg PnL averages (12 + -8 + 4.2) / 3", () => {
      const expected = (12 + -8 + 4.2) / 3;
      assert.ok(Math.abs(result.totalPnlPct - expected) < 0.001, `got ${result.totalPnlPct}`);
    });
  }

  // 2. Real sweep — closes 3 with full metadata
  {
    const result = sweepMaturedPaperTrades({ dryRun: false });
    check("commit: swept count is 3", () => assert.equal(result.swept, 3));
    const onDisk = readJson();
    const m1 = onDisk.trades.find((t) => t.id === "paper_m1");
    const m2 = onDisk.trades.find((t) => t.id === "paper_m2");
    const m3 = onDisk.trades.find((t) => t.id === "paper_m3");
    check("commit: m1 status=closed", () => assert.equal(m1.status, "closed"));
    check("commit: m1 closed_at set", () => assert.ok(m1.closed_at));
    check("commit: m1 close_reason=legacy_sweep", () => assert.equal(m1.close_reason, "legacy_sweep"));
    check("commit: m1 close_action=matured_no_eval", () => assert.equal(m1.close_action, "matured_no_eval"));
    check("commit: m1 final_pnl_pct from snapshot", () => assert.equal(m1.final_pnl_pct, 12));
    check("commit: m1 final_fee_inclusive_pnl_pct from snapshot", () => assert.equal(m1.final_fee_inclusive_pnl_pct, 13.5));
    check("commit: m2 final_pnl_pct = -8 (loser)", () => assert.equal(m2.final_pnl_pct, -8));
    check("commit: m3 fallback to peak_pnl_pct=4.2", () => assert.equal(m3.final_pnl_pct, 4.2));
    check("commit: m3 fee_inclusive falls back to pnl when no snapshot", () => assert.equal(m3.final_fee_inclusive_pnl_pct, 4.2));

    // Open trades untouched
    const o1 = onDisk.trades.find((t) => t.id === "paper_open1");
    const o2 = onDisk.trades.find((t) => t.id === "paper_open2");
    check("commit: open trades untouched (o1)", () => assert.equal(o1.status, "open"));
    check("commit: open trades untouched (o2)", () => assert.equal(o2.status, "open"));
    check("commit: open trade has no closed_at", () => assert.equal(o1.closed_at, undefined));
  }

  // 3. Idempotency — second sweep finds nothing
  {
    const result = sweepMaturedPaperTrades({ dryRun: false });
    check("idempotent: second sweep returns swept=0", () => assert.equal(result.swept, 0));
    check("idempotent: results array empty", () => assert.equal(result.results.length, 0));
  }

  // 4. Empty file — no crash
  {
    fs.writeFileSync(REAL, JSON.stringify({ trades: [] }, null, 2));
    const result = sweepMaturedPaperTrades({ dryRun: false });
    check("empty trades array returns swept=0", () => assert.equal(result.swept, 0));
  }

  console.log(`\nALL ${assertions} assertions PASS`);
} finally {
  // Restore real file
  try { fs.unlinkSync(REAL); } catch {}
  if (hadReal) fs.renameSync(BACKUP, REAL);
}
