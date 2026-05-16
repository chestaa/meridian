// Backtest Harness — Lyra
//
// Replays historical signals/candidates through the CURRENT pipeline
// (lightweight Cassiopeia-style deterministic filters + Orion LLM judge)
// WITHOUT making real Meteora API calls and WITHOUT deploying anything.
//
// READ-ONLY on existing pipeline: this script imports `judgeCandidates`
// from agents/orion.js (which IS the live LLM path) but does not mutate
// any state files except writing a report under ./backtest-reports/.
//
// CLI:
//   node scripts/backtest-harness.js \
//        --source <signal-results|inbox|history|jsonl-file> \
//        [--path <jsonl-or-dir-path>] \
//        [--limit N]           default 50 \
//        [--orion-only]        skip deterministic filter stage \
//        [--dry]               default; never deploy. (no opposite flag exists) \
//        [--output <file>]     override report path \
//        [--no-llm]            offline mode — produce report w/ Cassiopeia only
//
// DRY_RUN is asserted true throughout. Real LLM calls cost ~$0.0002/cand at kimi-k2.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { parseSignalMessage, scoreParsedSignal } from "../signal-parser.js";

// ---------- ARG PARSING ----------
function parseArgs(argv) {
  const args = { source: "signal-results", limit: 50, dry: true, output: null, orionOnly: false, noLlm: false, path: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":     args.source = argv[++i]; break;
      case "--path":       args.path = argv[++i]; break;
      case "--limit":      args.limit = Number(argv[++i] || 50); break;
      case "--orion-only": args.orionOnly = true; break;
      case "--dry":        args.dry = true; break;
      case "--no-llm":     args.noLlm = true; break;
      case "--output":     args.output = argv[++i]; break;
      default: /* ignore unknown */ break;
    }
  }
  if (!args.dry) args.dry = true; // hard-coded — harness never deploys
  return args;
}

// ---------- LOADERS ----------
function loadSignalResults(limit) {
  const file = "./signal-results.jsonl";
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      out.push({
        sourceKind: "signal-results",
        sourceRef: r.file || null,
        originalDecision: r?.llm?.decision || r?.preScore?.decision || null,
        originalReason: r?.llm?.reason || null,
        signal: r.signal || null,
        ts: r.ts || null,
      });
      if (out.length >= limit) break;
    } catch { /* skip malformed line */ }
  }
  return out;
}

function loadTxtDir(dir, kind, limit) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).slice(0, limit);
  return files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const signal = parseSignalMessage(text);
    return { sourceKind: kind, sourceRef: f, originalDecision: null, originalReason: null, signal, ts: null };
  });
}

function loadJsonlFile(file, limit) {
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(0, limit);
  return lines.map((line, i) => {
    try {
      const r = JSON.parse(line);
      return {
        sourceKind: "jsonl-file",
        sourceRef: `${path.basename(file)}#${i}`,
        originalDecision: r?.llm?.decision || r?.decision || null,
        originalReason: r?.llm?.reason || r?.reason || null,
        signal: r.signal || r,
        ts: r.ts || null,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function loadCandidates(args) {
  switch (args.source) {
    case "signal-results": return loadSignalResults(args.limit);
    case "inbox":          return loadTxtDir("./signals/inbox", "inbox", args.limit);
    case "history":        return loadTxtDir("./signals/history", "history", args.limit);
    case "jsonl-file":     return loadJsonlFile(args.path, args.limit);
    default:               throw new Error(`Unknown --source: ${args.source}`);
  }
}

// ---------- NORMALIZE TO ORION CANDIDATE SHAPE ----------
// Mirrors the `passing` shape in index.js that agents/orion.js expects:
//   { pool: {...metrics}, sw, n, ti, mem }
function normalizeToOrionCandidate(entry) {
  const s = entry.signal || {};
  const pool_address = s.tokenAddress || s.pool || `synthetic_${entry.sourceRef || Math.random().toString(36).slice(2,8)}`;
  return {
    _meta: { sourceKind: entry.sourceKind, sourceRef: entry.sourceRef, originalDecision: entry.originalDecision, originalReason: entry.originalReason, ts: entry.ts },
    pool: {
      pool: pool_address,
      name: s.name || s.symbol || pool_address.slice(0, 8),
      bin_step: s.bin_step ?? null,
      fee_pct: s.fee_pct ?? null,
      fee_active_tvl_ratio: s.fee_active_tvl_ratio ?? null,
      volume_window: s.vol5mUsd ?? s.volume_window ?? null,
      tvl: s.tvl ?? null,
      active_tvl: s.active_tvl ?? null,
      volatility: s.volatility ?? null,
      organic_score: s.organic_score ?? null,
      mcap: s.mcapUsd ?? s.mcap ?? null,
      token_age_hours: s.token_age_hours ?? null,
    },
    sw: { in_pool: Array.isArray(s.smart_wallets) ? s.smart_wallets : [] },
    n: { narrative: s.narrative || s.type || null },
    ti: { audit: { top_holders_pct: s.top10Pct ?? null, bot_holders_pct: s.bundlersPct ?? null }, global_fees_sol: s.distributedSol ?? null, launchpad: s.launchpad ?? null },
    mem: null,
  };
}

// ---------- LIGHTWEIGHT CASSIOPEIA (deterministic, offline) ----------
// Cannot import the non-exported `getRawPoolScreeningRejectReason` from
// tools/screening.js (and STRICT rules forbid modifying it). So we
// re-implement the signal-mode subset here using the SAME config keys,
// so a tuned threshold change in config.screening propagates automatically.
function cassiopeiaCheck(candidate) {
  const s = config.screening || {};
  const reasons = [];
  const m = candidate.pool || {};

  const mcapMin = Number(s.signalMinMcap ?? 5_000);
  const mcapMax = Number(s.signalMaxMcap ?? 80_000);
  if (m.mcap != null) {
    if (m.mcap < mcapMin) reasons.push(`mcap ${m.mcap} < signalMinMcap ${mcapMin}`);
    if (m.mcap > mcapMax) reasons.push(`mcap ${m.mcap} > signalMaxMcap ${mcapMax}`);
  } else {
    reasons.push("mcap missing");
  }

  if (m.volume_window != null && Number(s.minVolume ?? 0) > 0) {
    // signal volume is 5m USD, very different scale from pool volume_window —
    // use a 1k floor as signal-mode minimum (per signal-parser scoreParsedSignal logic).
    if (m.volume_window < 1_000) reasons.push(`5m volume ${m.volume_window} < 1000`);
  }

  const ti = candidate.ti || {};
  if (ti.global_fees_sol != null && ti.global_fees_sol < 0.2) {
    reasons.push(`distributed SOL ${ti.global_fees_sol} < 0.2`);
  }

  const top10 = candidate.ti?.audit?.top_holders_pct;
  if (top10 != null && top10 > Number(s.maxTop10Pct ?? 60)) {
    reasons.push(`top10 ${top10}% > maxTop10Pct ${s.maxTop10Pct ?? 60}`);
  }
  const bots = candidate.ti?.audit?.bot_holders_pct;
  if (bots != null && bots > Number(s.maxBundlersPct ?? 30)) {
    reasons.push(`bundlers ${bots}% > maxBundlersPct ${s.maxBundlersPct ?? 30}`);
  }

  return { pass: reasons.length === 0, reasons };
}

// ---------- REPORT WRITER ----------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeReport({ outFile, summary, rows, args, totalCostUsd, totalLatencyMs }) {
  ensureDir(path.dirname(outFile));
  const lines = [];
  lines.push(`# Backtest Report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`**Author:** Lyra (audit/cost)`);
  lines.push(`**Source:** ${args.source}${args.path ? ` (path=${args.path})` : ""}`);
  lines.push(`**Limit:** ${args.limit}`);
  lines.push(`**Orion-only:** ${args.orionOnly}`);
  lines.push(`**No-LLM:** ${args.noLlm}`);
  lines.push(`**DRY_RUN:** ${process.env.DRY_RUN ?? "(unset, treated dry)"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|---|---|");
  lines.push(`| Total candidates loaded | ${summary.total} |`);
  lines.push(`| Cassiopeia PASS | ${summary.cassPass} |`);
  lines.push(`| Cassiopeia FAIL | ${summary.cassFail} |`);
  lines.push(`| Orion ENTER | ${summary.orionEnter} |`);
  lines.push(`| Orion SKIP  | ${summary.orionSkip} |`);
  lines.push(`| Orion not-run (filtered out) | ${summary.orionSkipped} |`);
  lines.push(`| Contradictions (Orion enter vs historical skip / vice versa) | ${summary.contradictions} |`);
  lines.push("");
  lines.push("## Cost & Latency");
  lines.push("");
  lines.push(`- Total LLM cost (est): **$${totalCostUsd.toFixed(6)}**`);
  lines.push(`- Total latency: **${totalLatencyMs} ms**`);
  lines.push(`- Per-candidate avg latency: **${rows.length ? Math.round(totalLatencyMs / rows.length) : 0} ms**`);
  lines.push("");
  lines.push("## Per-candidate Results");
  lines.push("");
  lines.push("| # | Pool / Token | Source | Original | Cassiopeia | Orion | Conf | Reason |");
  lines.push("|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const reason = (r.orion?.reason || r.cassiopeia?.reasons?.join("; ") || "—").replace(/\|/g, "/").slice(0, 100);
    lines.push(`| ${i + 1} | ${r.pool} | ${r.sourceRef || r.sourceKind} | ${r.originalDecision || "—"} | ${r.cassiopeia ? (r.cassiopeia.pass ? "PASS" : "FAIL") : "—"} | ${r.orion?.decision || "—"} | ${r.orion?.confidence ?? "—"} | ${reason} |`);
  });
  lines.push("");
  lines.push("## Highlights — Contradictions");
  lines.push("");
  const contradictions = rows.filter((r) => r._contradiction);
  if (contradictions.length === 0) {
    lines.push("_None detected._");
  } else {
    for (const r of contradictions) {
      lines.push(`- **${r.pool}** — historical=\`${r.originalDecision}\` vs Orion=\`${r.orion?.decision}\` — ${r.orion?.reason || ""}`);
    }
  }
  lines.push("");
  lines.push("— Lyra");
  fs.writeFileSync(outFile, lines.join("\n"), "utf8");
  return outFile;
}

// ---------- MAIN ----------
export async function runBacktest(args) {
  // Guard: never let any deploy code path engage.
  process.env.DRY_RUN = "true";

  const entries = loadCandidates(args);
  const candidates = entries.map(normalizeToOrionCandidate);

  const summary = { total: candidates.length, cassPass: 0, cassFail: 0, orionEnter: 0, orionSkip: 0, orionSkipped: 0, contradictions: 0 };
  const rows = [];
  let totalCost = 0;
  let totalLatency = 0;

  // Cassiopeia stage
  const orionInputs = [];
  for (const c of candidates) {
    const row = {
      pool: c.pool.pool,
      sourceKind: c._meta.sourceKind,
      sourceRef: c._meta.sourceRef,
      originalDecision: c._meta.originalDecision,
      cassiopeia: null,
      orion: null,
      _contradiction: false,
    };
    if (args.orionOnly) {
      orionInputs.push({ candidate: c, row });
    } else {
      const cass = cassiopeiaCheck(c);
      row.cassiopeia = cass;
      if (cass.pass) {
        summary.cassPass += 1;
        orionInputs.push({ candidate: c, row });
      } else {
        summary.cassFail += 1;
        summary.orionSkipped += 1;
      }
    }
    rows.push(row);
  }

  // Orion stage
  if (!args.noLlm && orionInputs.length > 0) {
    const { judgeCandidates } = await import("../agents/orion.js");
    const t0 = Date.now();
    const verdicts = await judgeCandidates(
      orionInputs.map((x) => x.candidate),
      { portfolio: { sol: 0 }, positions: { total_positions: 0 } },
    );
    totalLatency = Date.now() - t0;
    verdicts.forEach((v, i) => {
      const row = orionInputs[i].row;
      row.orion = v;
      if (v.decision === "enter") summary.orionEnter += 1;
      else summary.orionSkip += 1;
      // Contradiction detection vs originalDecision
      const orig = String(row.originalDecision || "").toLowerCase();
      if ((orig === "skip" && v.decision === "enter") || (orig === "enter" && v.decision === "skip")) {
        row._contradiction = true;
        summary.contradictions += 1;
      }
    });
    // Read cost increment from llm-usage.json totals delta (best-effort).
    try {
      if (fs.existsSync("./llm-usage.json")) {
        const u = JSON.parse(fs.readFileSync("./llm-usage.json", "utf8"));
        // Rough estimate: kimi-k2 ~ $0.60/M input, $2.50/M output
        const records = Array.isArray(u.records) ? u.records.slice(-verdicts.length) : [];
        for (const rec of records) {
          const inT = Number(rec?.usage?.prompt_tokens || 0);
          const outT = Number(rec?.usage?.completion_tokens || 0);
          totalCost += (inT * 0.6 + outT * 2.5) / 1_000_000;
        }
      }
    } catch { /* swallow */ }
  } else if (args.noLlm) {
    summary.orionSkipped += orionInputs.length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = args.output || `./backtest-reports/backtest-${stamp}.md`;
  writeReport({ outFile, summary, rows, args, totalCostUsd: totalCost, totalLatencyMs: totalLatency });

  return { outFile, summary, rows, totalCostUsd: totalCost, totalLatencyMs: totalLatency };
}

// CLI entry — only when invoked directly (not when dynamically imported).
// Use a sentinel env flag: only the CLI shebang path sets BACKTEST_HARNESS_CLI=1.
// When imported via `await import(...)`, this flag is absent so the block is skipped.
const invokedDirectly = process.env.BACKTEST_HARNESS_CLI === "1" || ((process.argv[1] || "").replace(/\\/g, "/").toLowerCase().endsWith("/scripts/backtest-harness.js") && !process.env.BACKTEST_IMPORTED);
if (invokedDirectly) {
  const args = parseArgs(process.argv);
  runBacktest(args).then((res) => {
    console.log(`Backtest complete. Report: ${res.outFile}`);
    console.log(`Summary: ${JSON.stringify(res.summary)}`);
    console.log(`Cost (est): $${res.totalCostUsd.toFixed(6)}  Latency: ${res.totalLatencyMs} ms`);
  }).catch((err) => {
    console.error("Backtest failed:", err);
    process.exit(1);
  });
}
