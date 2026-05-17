import fs from "fs";
import path from "path";
import { parseSignalMessage, scoreParsedSignal } from "../signal-parser.js";
import { enrichSignal } from "../signal-enricher.js";
import { judgeSignalWithLlm, formatSignalJudgment } from "../signal-judge.js";
import { sendMessage, isEnabled as telegramEnabled, isExecutiveMode } from "../telegram.js";
import { config } from "../config.js";

const SIGNAL_DIR = process.env.SIGNAL_DIR || "./signals/inbox";
const PROCESSED_DIR = process.env.SIGNAL_PROCESSED_DIR || "./signals/processed";
const REJECTED_DIR = process.env.SIGNAL_REJECTED_DIR || "./signals/rejected";
const RESULTS_FILE = process.env.SIGNAL_RESULTS_FILE || "./signal-results.jsonl";
const INTERVAL_MS = Number(process.env.SIGNAL_RUNNER_INTERVAL_MS || 30_000);
const ONCE = process.argv.includes("--once");

for (const dir of [SIGNAL_DIR, PROCESSED_DIR, REJECTED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function moveFile(src, destDir) {
  const dest = path.join(destDir, `${Date.now()}-${path.basename(src)}`);
  fs.renameSync(src, dest);
  return dest;
}

async function processFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseSignalMessage(raw);
  // Sirius enricher: fill mcap/vol/tvl/holders from live APIs before Cassiopeia.
  // Flag OFF → fall back to legacy parse-only behavior.
  const enricherEnabled = config?.internalAgents?.enricherEnabled !== false;
  const signal = enricherEnabled
    ? await enrichSignal(parsed).catch((err) => {
        console.error(`[ENRICH] failed for ${path.basename(filePath)}: ${err.message}`);
        return parsed;
      })
    : parsed;
  const preScore = scoreParsedSignal(signal);
  const shouldJudge = preScore.decision !== "skip";
  const llm = shouldJudge
    ? await judgeSignalWithLlm(signal, preScore)
    : {
        ok: true,
        decision: "skip",
        confidence: 0,
        maxPositionSol: 0,
        reason: preScore.reasons.join("; ") || "deterministic filter skipped",
        usage: null,
        latencyMs: 0,
      };

  const result = {
    ts: new Date().toISOString(),
    file: path.basename(filePath),
    signal,
    preScore,
    llm,
    dryRun: String(process.env.DRY_RUN ?? "true") !== "false",
  };

  appendJsonl(RESULTS_FILE, result);
  const text = formatSignalJudgment({ signal, preScore, llm });
  console.log(`\n${text}\n`);
  // Executive mode silences per-signal verdicts — aggregated in daily boss-report.
  if (telegramEnabled() && !isExecutiveMode()) {
    await sendMessage(`Signal-first dry-run\n\n${text}`).catch(() => null);
  }

  moveFile(filePath, llm.decision === "skip" ? REJECTED_DIR : PROCESSED_DIR);
}

// Heartbeat state — converts silent idle into loud alert.
// Single long-running process: module-level state is sufficient (no persistence needed).
const RUNNER_STARTED_AT = Date.now();
const IDLE_ALERT_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6h
const IDLE_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h
let lastSignalProcessedAt = Date.now();
let lastIdleAlertAt = 0;

async function maybeEmitIdleHeartbeat() {
  const now = Date.now();
  // Avoid cold-start false alarm: require runner uptime >= threshold.
  if (now - RUNNER_STARTED_AT < IDLE_ALERT_THRESHOLD_MS) return;
  const idleMs = now - lastSignalProcessedAt;
  if (idleMs < IDLE_ALERT_THRESHOLD_MS) return;
  if (now - lastIdleAlertAt < IDLE_ALERT_COOLDOWN_MS) return;

  const hours = (idleMs / (60 * 60 * 1000)).toFixed(1);
  const line = `[heartbeat] signal-runner idle for ${hours} hours, inbox empty`;
  console.log(line);
  // Executive mode silences idle heartbeats — log-only is sufficient.
  if (telegramEnabled() && !isExecutiveMode()) {
    await sendMessage(line).catch(() => null);
  }
  lastIdleAlertAt = now;
}

async function tick() {
  const files = fs.readdirSync(SIGNAL_DIR)
    .filter((name) => name.endsWith(".txt") || name.endsWith(".md"))
    .map((name) => path.join(SIGNAL_DIR, name))
    .sort();

  for (const file of files) {
    try {
      await processFile(file);
      lastSignalProcessedAt = Date.now();
    } catch (error) {
      console.error(`Failed to process ${file}: ${error.message}`);
    }
  }

  if (files.length === 0) {
    await maybeEmitIdleHeartbeat();
  }
}

console.log(`Signal runner watching ${SIGNAL_DIR} every ${INTERVAL_MS}ms${ONCE ? " (once)" : ""}`);
await tick();

if (!ONCE) {
  setInterval(() => {
    tick().catch((error) => console.error(`Signal runner tick failed: ${error.message}`));
  }, INTERVAL_MS);
}
