#!/usr/bin/env node
// scripts/backfill-realized-sol-delta.js
//
// Vega honesty backfill (2026-06-23) — re-derive mis-booked `realized_sol_delta`
// rows in lessons.json. AUDIT-PRESERVING, REVERSIBLE, REPORTING-ONLY.
//
// ── WHO RUNS THIS ───────────────────────────────────────────────────────────
//   Lyra (audit VETO) reviews this script and RUNS it on the VPS where the REAL
//   lessons.json lives. Vega (the author) does NOT run it. The dev-box
//   lessons.json is empty; the live ledger is remote.
//
// ── WHAT IT FIXES ───────────────────────────────────────────────────────────
//   The formula path in realized-sol.js could emit a fabricated ~-100% /
//   ~-1×-deploy realized figure when the Meteora closed-PnL API reported a
//   PRESENT-but-ZERO SOL withdrawal (allTimeWithdrawals.total.sol === 0) on a
//   still-settling record — even when USD economics (pnl_pct, final_value_usd)
//   showed the position did NOT wipe. Those rows are now mis-booked catastrophes
//   in the ledger. This script finds them and FAILS THEM TOWARD UNKNOWN (null) —
//   it does NOT fabricate a replacement number, mirroring the live code fix
//   (honest gap > fabricated catastrophe).
//
// ── DETECTION (a row is mis-booked iff ALL hold) ─────────────────────────────
//   1. realized_sol_delta is finite (a number was booked)
//   2. amount_sol > 0 (we can compute the ratio)
//   3. realized_sol_delta / amount_sol <= CATASTROPHE_RATIO (default -0.90):
//      the booked realized loss is ~>= the entire deployed modal (the -100%
//      fabrication signature)
//   4. USD economics CONTRADICT a wipe — at least one of:
//        - pnl_pct        > USD_WIPE_PNL_PCT (default -90)   (not a USD near-wipe)
//        - final_value_usd > 0                               (USD value came back)
//      AND the close_reason is NOT a real stop-loss disaster (those are allowed
//      to be deeply negative — we never "correct" a genuine catastrophe).
//
//   When detected, the row's realized_sol_delta is set to null (UNKNOWN), with
//   method tagged so Lyra/digest can see it was a backfilled honesty-gap.
//
// ── AUDIT PRESERVATION ───────────────────────────────────────────────────────
//   - Original value preserved in `realized_sol_delta_raw` (+ _pct / _method raw)
//     — never destroyed; idempotent (a row already carrying _raw is skipped).
//   - A timestamped backup of lessons.json is written BEFORE any mutation.
//   - Every correction is logged to stdout and to a JSON audit sidecar
//     (lessons.realized-backfill.<ISO>.json) listing before/after per row.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
//   - DEFAULT IS DRY-RUN. Without `--write`, NOTHING is mutated — it only reports
//     what it WOULD change. Lyra inspects the dry-run output first.
//   - Touches ONLY lessons.json (the reporting ledger). Does NOT touch state.js,
//     wallet, executor, DRY_RUN, or any on-chain/TX path.
//
// ── USAGE ─────────────────────────────────────────────────────────────────────
//   node scripts/backfill-realized-sol-delta.js              # dry-run (default)
//   node scripts/backfill-realized-sol-delta.js --write      # apply (Lyra, on VPS)
//   node scripts/backfill-realized-sol-delta.js --file <path> # override ledger path

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Tunables (match the live realized-sol.js honesty guard) ──────────────────
const CATASTROPHE_RATIO = -0.90; // booked loss <= -90% of modal = fabrication signature
const USD_WIPE_PNL_PCT = -90;    // pnl_pct above this = USD says NOT a wipe

function parseArgs(argv) {
  const args = { write: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--file") args.file = argv[++i];
  }
  return args;
}

function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure decision fn (exported for unit testing): is this performance row a
 * mis-booked ~-100% realized catastrophe that USD economics contradict?
 * Returns true ONLY when the row should be failed toward UNKNOWN.
 */
export function isMisbookedRealizedRow(row) {
  if (!row || typeof row !== "object") return false;
  const realized = isFiniteNum(row.realized_sol_delta);
  const amount = isFiniteNum(row.amount_sol);
  if (realized == null || amount == null || amount <= 0) return false;

  // (3) booked loss is ~>= the entire modal — the -100% fabrication signature.
  const ratio = realized / amount;
  if (ratio > CATASTROPHE_RATIO) return false;

  // Never "correct" a genuine stop-loss disaster — those are allowed to be deep.
  const reason = String(row.close_reason || "").toLowerCase();
  if (reason.includes("stop loss")) return false;

  // (4) USD economics must CONTRADICT a wipe.
  const pnlPct = isFiniteNum(row.pnl_pct);
  const finalUsd = isFiniteNum(row.final_value_usd);
  const usdNotWiped =
    (pnlPct != null && pnlPct > USD_WIPE_PNL_PCT) ||
    (finalUsd != null && finalUsd > 0);

  return usdNotWiped;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = args.file
    ? path.resolve(args.file)
    : path.resolve(__dirname, "..", "lessons.json");

  if (!fs.existsSync(ledgerPath)) {
    console.error(`[backfill] lessons.json not found at ${ledgerPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(ledgerPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`[backfill] failed to parse ${ledgerPath}: ${e.message}`);
    process.exit(1);
  }

  const perf = Array.isArray(data.performance) ? data.performance : [];
  console.log(`[backfill] ${args.write ? "WRITE MODE" : "DRY-RUN (no mutation)"} — ledger ${ledgerPath}`);
  console.log(`[backfill] ${perf.length} performance rows scanned`);
  console.log(`[backfill] thresholds: catastrophe_ratio=${CATASTROPHE_RATIO} usd_wipe_pnl_pct=${USD_WIPE_PNL_PCT}`);

  const corrections = [];
  for (let i = 0; i < perf.length; i++) {
    const row = perf[i];
    // Idempotency: a row already carrying the raw sidecar was backfilled before.
    if (row && Object.prototype.hasOwnProperty.call(row, "realized_sol_delta_raw")) continue;
    if (!isMisbookedRealizedRow(row)) continue;

    corrections.push({
      index: i,
      pool_name: row.pool_name || row.pool || null,
      recorded_at: row.recorded_at || null,
      close_reason: row.close_reason || null,
      before: {
        realized_sol_delta: row.realized_sol_delta,
        realized_sol_delta_pct: row.realized_sol_delta_pct ?? null,
        realized_sol_method: row.realized_sol_method ?? null,
      },
      after: {
        realized_sol_delta: null,
        realized_sol_delta_pct: null,
        realized_sol_method: "unavailable_backfill_zero_sol_usd_disagree",
      },
      economics: { pnl_pct: row.pnl_pct ?? null, final_value_usd: row.final_value_usd ?? null, amount_sol: row.amount_sol ?? null },
    });
  }

  if (corrections.length === 0) {
    console.log("[backfill] no mis-booked rows found — nothing to do.");
    return;
  }

  console.log(`\n[backfill] ${corrections.length} mis-booked row(s) detected:\n`);
  for (const c of corrections) {
    console.log(
      `  #${c.index} ${c.pool_name ?? "?"} @ ${c.recorded_at ?? "?"} | ` +
      `raw realized=${c.before.realized_sol_delta} (${c.before.realized_sol_delta_pct ?? "?"}%) ` +
      `-> UNKNOWN | usd pnl_pct=${c.economics.pnl_pct} final_usd=${c.economics.final_value_usd} ` +
      `amount_sol=${c.economics.amount_sol} reason="${c.close_reason ?? ""}"`
    );
  }

  if (!args.write) {
    console.log(`\n[backfill] DRY-RUN complete. Re-run with --write to apply (Lyra, on VPS).`);
    return;
  }

  // ── WRITE PATH (audit-preserving) ──────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${ledgerPath}.backup.${stamp}.json`;
  fs.writeFileSync(backupPath, raw, "utf8");
  console.log(`\n[backfill] backup written: ${backupPath}`);

  for (const c of corrections) {
    const row = perf[c.index];
    // Preserve originals — never destroy.
    row.realized_sol_delta_raw = row.realized_sol_delta;
    row.realized_sol_delta_pct_raw = row.realized_sol_delta_pct ?? null;
    row.realized_sol_method_raw = row.realized_sol_method ?? null;
    row.realized_sol_backfilled_at = new Date().toISOString();
    // Fail toward UNKNOWN — do NOT fabricate a replacement figure.
    row.realized_sol_delta = null;
    row.realized_sol_delta_pct = null;
    row.realized_sol_method = "unavailable_backfill_zero_sol_usd_disagree";
    row.realized_sol_estimate = true;
  }

  fs.writeFileSync(ledgerPath, JSON.stringify(data, null, 2), "utf8");

  const auditPath = path.join(path.dirname(ledgerPath), `lessons.realized-backfill.${stamp}.json`);
  fs.writeFileSync(auditPath, JSON.stringify({ backfilled_at: new Date().toISOString(), ledger: ledgerPath, backup: backupPath, corrections }, null, 2), "utf8");

  console.log(`[backfill] APPLIED ${corrections.length} correction(s).`);
  console.log(`[backfill] audit sidecar: ${auditPath}`);
  console.log(`[backfill] originals preserved in realized_sol_delta_raw on each row.`);
}

// Run only when invoked directly (so the pure fn can be imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
