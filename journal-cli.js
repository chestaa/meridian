#!/usr/bin/env node
// journal-cli.js — Lyra's operator-facing journal CLI (BUILD v1).
//
// For Bro (operator, not a coder). Plain commands, plain output. No flags to
// memorize for the common path; key=value pairs for adding entries.
//
// USAGE
//   node journal-cli.js add <key=value ...>     log a new entry (idea/trade)
//   node journal-cli.js close <id> <key=value>  resolve an open entry's outcome
//   node journal-cli.js list [N]                show last N entries (default 15)
//   node journal-cli.js report [experiment_id]  honest stats per experiment
//   node journal-cli.js compare <keyA> <keyB>   A-vs-B (exp::cfg or exp::cfg::unit)
//   node journal-cli.js help                    this help
//
// ADD example (one open idea):
//   node journal-cli.js add \
//     experiment_id=sol-lp-narrow config_version=v1 market=solana asset=SOL-USDC \
//     hypothesis="narrow range earns more fees in choppy regime; betting on mean-reversion" \
//     tags=lp,narrow
//
// CLOSE example (resolve it honestly):
//   node journal-cli.js close je_123_abc \
//     outcome_value=0.012 outcome_unit=SOL outcome_realized=true \
//     lesson="held 6h, range held, fees > IL. repeat in chop only"
//
// HONESTY RULE: outcome_unit MUST be one of SOL|USD|R|pct|proxy. Only SOL/USD
// with outcome_realized=true count as REAL MONEY. Everything else is a proxy
// and is labeled as such in reports. (The PnL != SOL trap.)

import fs from "fs";
import {
  appendEntry,
  readEntries,
  effectiveEntries,
  journalFile,
  OUTCOME_UNITS,
} from "./journal.js";
import { reportByExperiment, compareGroups } from "./journal-stats.js";

// ── parse key=value args (values may be quoted by the shell) ─────────
function parseKv(args) {
  const kv = {};
  for (const a of args) {
    const i = a.indexOf("=");
    if (i === -1) continue;
    kv[a.slice(0, i)] = a.slice(i + 1);
  }
  return kv;
}

function buildEntryFromKv(kv) {
  const entry = {
    experiment_id: kv.experiment_id,
    config_version: kv.config_version,
    market: kv.market,
    asset: kv.asset,
    hypothesis: kv.hypothesis,
    lesson: kv.lesson,
    tags: kv.tags ? kv.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
  };
  if (kv.setup) {
    try {
      entry.setup = JSON.parse(kv.setup);
    } catch {
      entry.setup = { raw: kv.setup };
    }
  }
  if (kv.entry_price != null || kv.entry_note) {
    entry.entry = { price: kv.entry_price, note: kv.entry_note };
  }
  if (kv.exit_price != null || kv.exit_note) {
    entry.exit = { price: kv.exit_price, note: kv.exit_note };
  }
  if (kv.outcome_value != null || kv.outcome_unit) {
    entry.outcome = {
      value: kv.outcome_value,
      unit: kv.outcome_unit,
      is_realized: kv.outcome_realized === "true",
      note: kv.outcome_note,
    };
  }
  return entry;
}

// ── commands ─────────────────────────────────────────────────────────
function cmdAdd(args) {
  const kv = parseKv(args);
  if (!kv.experiment_id) {
    console.error("REFUSED: experiment_id is required (the slice key). Add experiment_id=<name>.");
    process.exit(1);
  }
  if (!kv.hypothesis) {
    console.error("REFUSED: hypothesis is required. WHAT edge are you betting on and WHY? This is the discipline.");
    process.exit(1);
  }
  if (kv.outcome_unit && !OUTCOME_UNITS.includes(kv.outcome_unit)) {
    console.error(`REFUSED: outcome_unit must be one of ${OUTCOME_UNITS.join("|")}.`);
    process.exit(1);
  }
  const e = appendEntry(buildEntryFromKv(kv));
  console.log(`logged ${e.status.toUpperCase()} entry`);
  console.log(`  id:          ${e.id}`);
  console.log(`  experiment:  ${e.experiment_id} (config ${e.config_version})`);
  console.log(`  market:      ${e.market}${e.asset ? " / " + e.asset : ""}`);
  console.log(`  hypothesis:  ${e.hypothesis}`);
  if (e.outcome) console.log(`  outcome:     ${fmtOutcome(e.outcome)}`);
  console.log(`\nfile: ${journalFile()}`);
}

function cmdClose(args) {
  const id = args[0];
  if (!id) {
    console.error("REFUSED: need an entry id. Usage: close <id> outcome_value=.. outcome_unit=..");
    process.exit(1);
  }
  const kv = parseKv(args.slice(1));
  const all = readEntries();
  const orig = effectiveEntries(all).find((e) => e.id === id);
  if (!orig) {
    console.error(`REFUSED: no effective entry with id ${id}.`);
    process.exit(1);
  }
  if (kv.outcome_unit && !OUTCOME_UNITS.includes(kv.outcome_unit)) {
    console.error(`REFUSED: outcome_unit must be one of ${OUTCOME_UNITS.join("|")}.`);
    process.exit(1);
  }
  // A close is a NEW append-only entry that supersedes the original (corrects).
  // History stays intact; we never mutate the open row.
  const closed = appendEntry({
    experiment_id: orig.experiment_id,
    config_version: orig.config_version,
    market: orig.market,
    asset: orig.asset,
    hypothesis: orig.hypothesis,
    setup: orig.setup,
    entry: orig.entry,
    exit: kv.exit_price != null || kv.exit_note ? { price: kv.exit_price, note: kv.exit_note } : orig.exit,
    status: "closed",
    outcome: {
      value: kv.outcome_value,
      unit: kv.outcome_unit || "proxy",
      is_realized: kv.outcome_realized === "true",
      note: kv.outcome_note,
    },
    lesson: kv.lesson || orig.lesson,
    tags: orig.tags,
    corrects: orig.id,
  });
  console.log(`closed entry ${id} -> new record ${closed.id}`);
  console.log(`  outcome: ${fmtOutcome(closed.outcome)}`);
  if (closed.lesson) console.log(`  lesson:  ${closed.lesson}`);
}

function fmtOutcome(o) {
  if (!o) return "(none)";
  if (!Number.isFinite(o.value)) return `(no number recorded) unit=${o.unit}`;
  const money = o.is_realized ? "REALIZED MONEY" : "PROXY/unrealized";
  return `${o.value >= 0 ? "+" : ""}${o.value} ${o.unit} [${money}]`;
}

function cmdList(args) {
  const n = Math.max(1, parseInt(args[0], 10) || 15);
  const all = effectiveEntries(readEntries());
  if (!all.length) {
    console.log("Journal is empty. Add one with:  node journal-cli.js add ...");
    return;
  }
  const rows = all.slice(-n);
  console.log(`last ${rows.length} of ${all.length} effective entries:\n`);
  for (const e of rows) {
    const date = (e.ts || "").slice(0, 16).replace("T", " ");
    const tag = `[${e.experiment_id}/${e.config_version}]`;
    console.log(`${date}  ${e.status.toUpperCase().padEnd(6)} ${tag} ${e.market}${e.asset ? "/" + e.asset : ""}`);
    console.log(`   id ${e.id}`);
    if (e.hypothesis) console.log(`   bet: ${e.hypothesis}`);
    if (e.outcome) console.log(`   out: ${fmtOutcome(e.outcome)}`);
    if (e.lesson) console.log(`   lesson: ${e.lesson}`);
    console.log("");
  }
}

function cmdReport(args) {
  const filterExp = args[0] || null;
  const all = readEntries();
  const { reports, coverage } = reportByExperiment(all);
  const shown = filterExp ? reports.filter((r) => r.experiment_id === filterExp) : reports;

  console.log("=".repeat(64));
  console.log("  MERIDIAN JOURNAL — HONEST EXPERIMENT REPORT (Lyra)");
  console.log("=".repeat(64));
  console.log(`coverage: ${coverage.closed_measured} measured / ${coverage.open} open / ${coverage.void} void / ${coverage.closed_unmeasurable} closed-but-no-number`);
  if (coverage.closed_unmeasurable > 0) {
    console.log(`  ! ${coverage.closed_unmeasurable} closed entries have NO numeric outcome — honest gap, not counted.`);
  }
  console.log("");

  if (!shown.length) {
    console.log("No measurable experiments yet. Log outcomes with `close`.");
    return;
  }

  for (const r of shown) {
    const moneyTag = r.is_realized_money ? `REAL MONEY (${r.realized_of_total} flagged realized)` : "PROXY UNIT (not real money)";
    console.log("-".repeat(64));
    console.log(`EXPERIMENT  ${r.experiment_id}   config ${r.config_version}   unit ${r.unit}`);
    console.log(`            ${moneyTag}`);
    console.log(`  samples   n=${r.n}  (W ${r.wins} / L ${r.losses} / BE ${r.breakeven})`);
    console.log(`  win rate  ${r.winRatePct}%`);
    console.log(`  avg win   ${r.avgWin}   avg loss ${r.avgLoss}   payoff ${r.payoff ?? "n/a"}`);
    console.log(`  break-even WR needed: ${r.breakEvenWrPct ?? "n/a"}%`);
    console.log(`  expectancy ${r.expectancy} ${r.unit}/trade   net ${r.net} ${r.unit}`);
    console.log(`  t-stat    ${r.tStat ?? "n/a"}`);
    console.log(`  VERDICT   >>> ${r.verdict} <<<`);
    console.log(`            ${r.honesty}`);
    if (r.payoffTrap) console.log(`  !! PAYOFF TRAP: ${r.payoffTrap}`);
    console.log("");
  }
  console.log("Reminder: only EDGE_POSITIVE/EDGE_NEGATIVE verdicts are statistically");
  console.log("supported. THIN (n<10), NOISE (|t|<2), INSUFFICIENT (n<2) all mean the");
  console.log("same thing: you do NOT know yet. Keep logging before you trust it.");
}

function cmdCompare(args) {
  const [keyA, keyB] = args;
  if (!keyA || !keyB) {
    console.error("Usage: compare <expA::cfgA[::unit]> <expB::cfgB[::unit]>");
    process.exit(1);
  }
  const res = compareGroups(readEntries(), keyA, keyB);
  if (!res.ok) {
    console.error(`cannot compare: ${res.reason}`);
    process.exit(1);
  }
  console.log("A vs B comparison");
  console.log(`  A  ${res.a.experiment_id}/${res.a.config_version}: expectancy ${res.a.expectancy} ${res.a.unit} (n=${res.a.n}, ${res.a.verdict})`);
  console.log(`  B  ${res.b.experiment_id}/${res.b.config_version}: expectancy ${res.b.expectancy} ${res.b.unit} (n=${res.b.n}, ${res.b.verdict})`);
  console.log(`  expectancy delta (A-B): ${res.expectancy_delta} ${res.a.unit}`);
  console.log(`  ${res.inconclusive ? "INCONCLUSIVE" : "CONCLUSIVE"}: ${res.note}`);
}

function cmdHelp() {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 36).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

// ── dispatch ─────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "add": cmdAdd(rest); break;
  case "close": cmdClose(rest); break;
  case "list": cmdList(rest); break;
  case "report": cmdReport(rest); break;
  case "compare": cmdCompare(rest); break;
  case "help": case undefined: cmdHelp(); break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
