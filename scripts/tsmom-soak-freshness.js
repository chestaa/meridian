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
import { fileURLToPath } from "url";

const EXPERIMENT_ID = "TSMOM";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The soak writes last_run_at to its state file on EVERY run (cold_open / mark /
// rebalance / noop) — the TRUE daily heartbeat. The journal only gets a row at a
// rebalance (~every 21d), so the state file is the right primary stall signal
// (works from day 1). Journal recency is a secondary corroboration.
function soakStateFile() {
  if (process.env.TSMOM_SOAK_STATE) return path.resolve(process.env.TSMOM_SOAK_STATE);
  const dir = process.env.TSMOM_DATA_DIR
    ? path.resolve(process.env.TSMOM_DATA_DIR)
    : path.resolve(__dirname, "..", "tsmom", "data");
  return path.join(dir, "soak-v3-btc-long.json");
}

function stateLastRunMs() {
  const f = soakStateFile();
  if (!fs.existsSync(f)) return { exists: false, file: f };
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    const ms = s.last_run_at ? Date.parse(s.last_run_at) : NaN;
    return { exists: true, file: f, ms: Number.isFinite(ms) ? ms : null };
  } catch {
    return { exists: true, file: f, ms: null, corrupt: true };
  }
}
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
  // PRIMARY signal: state-file last_run_at (daily heartbeat, works from day 1).
  const st = stateLastRunMs();

  // PRE-LAUNCH HONESTY: no state file yet => soak has never run. Not a stall —
  // don't page (the timer may simply not be enabled yet).
  if (!st.exists) {
    console.log(`[tsmom-fresh] OK (no alert): no soak state file yet — soak not yet run. file=${st.file}`);
    process.exit(0);
  }
  if (st.ms == null) {
    console.error(
      `[tsmom-fresh] STALE: soak state ${st.file} ${st.corrupt ? "is corrupt" : "has no last_run_at"} — ` +
      `the daily paper-soak may have stalled or never completed a run. Check ` +
      `journalctl -u meridian-tsmom-soak.service.`
    );
    process.exit(1);
  }
  const runAgeDays = (Date.now() - st.ms) / 86400000;
  const runIso = new Date(st.ms).toISOString();
  if (runAgeDays > MAX_DAYS) {
    console.error(
      `[tsmom-fresh] STALE: soak last_run_at ${runIso} is ${runAgeDays.toFixed(1)}d old (> ${MAX_DAYS}d). ` +
      `The daily paper-soak has stopped running. Check journalctl -u meridian-tsmom-soak.service ` +
      `and systemctl status meridian-tsmom-soak.timer.`
    );
    process.exit(1);
  }

  // SECONDARY (informational): journal recency for the soak config.
  const r = latestTsmomTs(journalFile());
  const jrnNote = r.found
    ? `last v3-btc-long journal row ${new Date(r.ms).toISOString()} (rebalances are ~21d apart)`
    : `no v3-btc-long journal rows yet (first logs at first rebalance, ~21d after cold-open)`;

  console.log(`[tsmom-fresh] OK: soak ran ${runIso} (${runAgeDays.toFixed(1)}d ago, <= ${MAX_DAYS}d). ${jrnNote}.`);
  process.exit(0);
}

main();
