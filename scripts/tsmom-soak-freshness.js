// scripts/tsmom-soak-freshness.js — TSMOM paper-soak staleness guard (Draco/Ops).
//
// WHY: the 18-day-stale lesson — a daily job can silently die and nobody notices
// until the data is worthless. This probe reads the SHARED journal, finds the
// most-recent TSMOM entry, and FAILS (exit 1) if it is older than the threshold.
// Wired as a systemd oneshot with OnFailure=meridian-notify@%n so a stall pages
// Telegram. READ-ONLY: opens the journal for read, writes nothing, no money, no LLM.
//
// Usage:
//   node scripts/tsmom-soak-freshness.js            # threshold 2 days (default)
//   TSMOM_FRESH_MAX_DAYS=3 node scripts/tsmom-soak-freshness.js
//   JOURNAL_FILE=/path/journal.jsonl node scripts/tsmom-soak-freshness.js
//
// Exit codes: 0 = fresh (or honestly-unknown pre-launch) ; 1 = STALE (alert).

import fs from "fs";
import path from "path";

const EXPERIMENT_ID = "TSMOM";
const MAX_DAYS = Number(process.env.TSMOM_FRESH_MAX_DAYS || 2);
// The forward soak logs config_version=v3-btc-long. Filter to it so a stalled
// soak is NOT masked by an old v2-deephistory BACKTEST row (which is re-runnable
// on demand and not the daily job we are watching). Set TSMOM_FRESH_CONFIG=""
// to track ANY TSMOM entry. Default tracks the soak config specifically.
const CONFIG = process.env.TSMOM_FRESH_CONFIG ?? "v3-btc-long";

function journalFile() {
  return process.env.JOURNAL_FILE
    ? path.resolve(process.env.JOURNAL_FILE)
    : path.resolve(process.cwd(), "journal.jsonl");
}

function latestTsmomTs(file) {
  if (!fs.existsSync(file)) return { found: false, reason: "no journal file yet" };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  let latest = null;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.experiment_id !== EXPERIMENT_ID) continue;
    if (CONFIG && e?.config_version !== CONFIG) continue;
    // Prefer an explicit timestamp; fall back to id-embedded time if present.
    const ts = e.ts || e.created_at || e.timestamp || null;
    const ms = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
  }
  if (latest == null) {
    const scope = CONFIG ? `TSMOM/${CONFIG}` : "TSMOM";
    return { found: false, reason: `no ${scope} entries in journal` };
  }
  return { found: true, ms: latest };
}

function main() {
  const file = journalFile();
  const r = latestTsmomTs(file);

  // PRE-LAUNCH HONESTY: before the soak ever runs there are no TSMOM rows. That
  // is NOT a stall — do not page. Exit 0 with a clear note. Once the soak runs
  // once, the absence of a recent row IS a stall.
  if (!r.found) {
    console.log(`[tsmom-fresh] OK (no alert): ${r.reason} — soak not yet producing rows. file=${file}`);
    process.exit(0);
  }

  const ageDays = (Date.now() - r.ms) / 86400000;
  const lastIso = new Date(r.ms).toISOString();
  if (ageDays > MAX_DAYS) {
    console.error(
      `[tsmom-fresh] STALE: last TSMOM journal entry ${lastIso} is ${ageDays.toFixed(1)}d old ` +
      `(> ${MAX_DAYS}d). The daily paper-soak may have stalled. Check ` +
      `journalctl -u meridian-tsmom-soak.service.`
    );
    process.exit(1);
  }
  console.log(`[tsmom-fresh] OK: last TSMOM entry ${lastIso} (${ageDays.toFixed(1)}d old, <= ${MAX_DAYS}d).`);
  process.exit(0);
}

main();
