/**
 * phase1-checklist.js — Phase 0 → Phase 1 go/no-go assessment.
 * Checks all automated criteria + reads manual gate approvals.
 *
 * Run:         node scripts/phase1-checklist.js
 * Approve gate: node scripts/phase1-checklist.js --approve <gate>
 *   gates: screening-reviewed | risk-confirmed | boss-go
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const GATES_FILE = path.join(ROOT, "phase1-gates.json");

// ─── Manual gate approve mode ────────────────────────────────────
const approveArg = process.argv.indexOf("--approve");
if (approveArg !== -1) {
  const gate = process.argv[approveArg + 1];
  const valid = ["screening-reviewed", "risk-confirmed", "boss-go"];
  if (!valid.includes(gate)) {
    console.error(`Unknown gate. Valid: ${valid.join(", ")}`);
    process.exit(1);
  }
  const gates = loadJson(GATES_FILE) || {};
  gates[gate] = { approved: true, at: new Date().toISOString() };
  fs.writeFileSync(GATES_FILE, JSON.stringify(gates, null, 2));
  console.log(`✅ Gate "${gate}" approved at ${gates[gate].at}`);
  process.exit(0);
}

// ─── helpers ────────────────────────────────────────────────────
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function serviceActive(name) {
  try {
    const out = execSync(`systemctl is-active ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
    return out === "active";
  } catch { return false; }
}

function bar(pct, len = 12) {
  const filled = Math.round(Math.min(pct, 100) / 100 * len);
  return "█".repeat(filled) + "░".repeat(len - filled);
}

function check(label, pass, value = "") {
  const icon = pass ? "✅" : "❌";
  return { icon, label, pass, value };
}

function gate(label, approved) {
  const icon = approved ? "✅" : "☐ ";
  return { icon, label, approved };
}

// ─── load state ─────────────────────────────────────────────────
const screenerState  = loadJson(path.join(ROOT, "auto-screener-state.json")) || {};
const cbState        = loadJson(path.join(ROOT, "circuit-breaker-state.json")) || {};
const llmData        = loadJson(path.join(ROOT, "llm-usage.json")) || {};
const gatesData      = loadJson(GATES_FILE) || {};
const paperTrades    = (() => { const d = loadJson(path.join(ROOT, "paper-trades.json")); return Array.isArray(d) ? d : []; })();

// Signal results from signal-results.jsonl
const resultsFile = path.join(ROOT, "signal-results.jsonl");
let allResults = [];
try {
  allResults = fs.readFileSync(resultsFile, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { /* none yet */ }

const totalSignals   = allResults.length;
const qualitySignals = allResults.filter(r => r.llm?.decision && r.llm.decision !== "skip").length;
const watchSignals   = allResults.filter(r => ["watch", "deploy"].includes(r.llm?.decision)).length;

// LLM cost
const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
const llmRecs = Array.isArray(llmData.records) ? llmData.records : [];
const costWeek = llmRecs.filter(r => r.ts >= weekAgo).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

// Wallet balance
let walletSol = null;
let burnerPubkey = null;
try {
  const wl = await import("../wallet-loader.js");
  const kp = wl.getSigningWallet();
  burnerPubkey = kp.publicKey.toBase58();
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [burnerPubkey] }),
  });
  const d = await res.json();
  walletSol = (d?.result?.value ?? 0) / 1e9;
} catch { /* dry-run or no key */ }

const MIN_SOL = 0.30;

// ─── automated checks ───────────────────────────────────────────
const checks = [
  check("Min 20 signals processed",       totalSignals >= 20,    `${totalSignals}/20`),
  check("Min 3 signals watchlisted by AI", watchSignals >= 3,    `${watchSignals}/3`),
  check("Auto-screener healthy",
    (screenerState.total_scans || 0) > 0 && (screenerState.consecutive_empty || 0) < 12,
    `${screenerState.total_scans || 0} scans, ${screenerState.consecutive_empty || 0} empty`),
  check("Circuit breaker armed (not halted)", !cbState.halted,   cbState.halted ? "HALTED" : "OK"),
  check("LLM cost 7-day < $5",             costWeek < 5,         `$${costWeek.toFixed(3)}`),
  check("Burner wallet ≥ 0.30 SOL",
    walletSol !== null ? walletSol >= MIN_SOL : false,
    walletSol !== null ? `${walletSol.toFixed(4)} SOL` : "unreadable"),
  check("Discord listener running",        serviceActive("meridian-discord-listener"),   ""),
  check("Signal runner running",           serviceActive("meridian-signal-runner"),       ""),
  check("Auto-screener service running",   serviceActive("meridian-auto-screener"),       ""),
  check("Telegram userbot running",        serviceActive("meridian-telegram-userbot"),    ""),
];

// ─── manual gates ───────────────────────────────────────────────
const manualGates = [
  gate("Screening thresholds reviewed (top candidates sanity-checked)",
    !!gatesData["screening-reviewed"]?.approved),
  gate("Risk parameters confirmed (deployAmountSol, maxPositions, gasReserve)",
    !!gatesData["risk-confirmed"]?.approved),
  gate("Bro Dikta explicit GO decision",
    !!gatesData["boss-go"]?.approved),
];

// ─── overall verdict ─────────────────────────────────────────────
const autoPass   = checks.every(c => c.pass);
const manualPass = manualGates.every(g => g.approved);
const GO         = autoPass && manualPass;

const autoScore  = checks.filter(c => c.pass).length;
const manualScore = manualGates.filter(g => g.approved).length;
const totalItems = checks.length + manualGates.length;
const doneItems  = autoScore + manualScore;
const pct        = Math.round(doneItems / totalItems * 100);

// ─── output ──────────────────────────────────────────────────────
const now = new Date().toLocaleString("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short"
});
const verdict = GO ? "🟢 GO — siap Phase 1" : "🔴 HOLD — belum siap";
const sep = "─────────────────────────────────";

console.log(`\n${"═".repeat(50)}`);
console.log(`  PHASE 1 READINESS CHECKLIST — ${now} WIB`);
console.log(`${"═".repeat(50)}`);
console.log(`\n  ${verdict}`);
console.log(`  Progress: [${bar(pct)}] ${pct}% (${doneItems}/${totalItems})\n`);

console.log(`  AUTOMATED CHECKS`);
console.log(`  ${sep}`);
for (const c of checks) {
  const val = c.value ? `  (${c.value})` : "";
  console.log(`  ${c.icon} ${c.label}${val}`);
}

console.log(`\n  MANUAL GATES`);
console.log(`  ${sep}`);
for (const g of manualGates) {
  console.log(`  ${g.icon} ${g.label}`);
}

if (!GO) {
  const missing = [
    ...checks.filter(c => !c.pass).map(c => `  • ${c.label} ${c.value ? `(${c.value})` : ""}`),
    ...manualGates.filter(g => !g.approved).map(g => `  • ${g.label}`),
  ];
  console.log(`\n  MISSING:`);
  for (const m of missing) console.log(m);
}

console.log(`\n  To approve a manual gate:`);
console.log(`  node scripts/phase1-checklist.js --approve screening-reviewed`);
console.log(`  node scripts/phase1-checklist.js --approve risk-confirmed`);
console.log(`  node scripts/phase1-checklist.js --approve boss-go`);
console.log(`\n${"═".repeat(50)}\n`);

// Telegram notify if Telegram is set (non-blocking)
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const tgLines = [
    `📋 <b>PHASE 1 CHECKLIST</b>  ${now} WIB`,
    `${verdict}`,
    `Progress: <code>[${bar(pct)}] ${pct}%</code>`,
    ``,
    ...checks.map(c => `${c.icon} ${c.label}${c.value ? ` <i>(${c.value})</i>` : ""}`),
    ``,
    ...manualGates.map(g => `${g.icon} ${g.label}`),
  ].join("\n");

  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: tgLines,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}
