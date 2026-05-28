// Smoke test for Sirius Telegram UX upgrades (A–D).
// Validates pure-function shapes; no Telegram API calls.
import { formatExecutiveDigest, gatherDigestData, buildDigest } from "../digest.js";

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok  -", msg);
}

// C. Executive digest format
const data = gatherDigestData({ timers: { managementLastRun: Date.now() - 60_000 } });
const exec = formatExecutiveDigest(data, { winRate7d: 83, walletSol: 0.884, walletUsd: 74 });
assert(exec.includes("RINGKASAN HARI INI"), "exec digest header");
assert(exec.includes("Posisi terbuka:"), "exec digest has open count");
assert(exec.includes("Win rate 7 hari: 83%"), "exec digest win rate");
assert(exec.includes("0.884 SOL ($74)"), "exec digest wallet");
assert(exec.includes("Bot: 🟢 jalan") || exec.includes("Bot: 🔴 halted"), "exec digest bot status");
assert(exec.includes("/details"), "exec digest links to /details");

// Buildigest executive=true wires through
const { html } = buildDigest({ executive: true });
assert(html.includes("RINGKASAN HARI INI"), "buildDigest executive=true");

// Verbose still works
const verbose = buildDigest({ executive: false });
assert(verbose.html.includes("MERIDIAN DIGEST"), "buildDigest verbose default");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
