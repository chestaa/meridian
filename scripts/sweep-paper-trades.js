// scripts/sweep-paper-trades.js
// Andromeda — one-shot CLI to close legacy "matured" paper trades stranded by
// the pre-fix exit-eval era. Manual invocation only (do NOT add to cron).
//
// Usage:
//   node scripts/sweep-paper-trades.js --dry   # preview, no writes
//   node scripts/sweep-paper-trades.js         # commit close + Telegram aggregate
//
// Output: single aggregate Telegram notif (Bro on executive summary mode — NOT
// 33 individual close pulses). Snapshot-based PnL, not market re-evaluated.

import "dotenv/config";
import { sweepMaturedPaperTrades } from "../paper-trades.js";
import { sendMessage, isEnabled } from "../telegram.js";

async function main() {
  const isDry = process.argv.includes("--dry");
  const result = sweepMaturedPaperTrades({ dryRun: isDry });

  console.log(`${isDry ? "[DRY] " : ""}Swept ${result.swept} matured paper trades. Avg PnL: ${result.totalPnlPct.toFixed(2)}%`);
  if (result.swept > 0) {
    console.log("Distribution:");
    for (const r of result.results) {
      console.log(`  ${r.symbol}: ${r.pnl_pct.toFixed(1)}%`);
    }
  }

  if (!isDry && result.swept > 0 && isEnabled()) {
    const winners = result.results.filter((r) => r.pnl_pct > 0).length;
    const losers  = result.results.filter((r) => r.pnl_pct <= 0).length;
    const top3    = result.results.slice().sort((a, b) => b.pnl_pct - a.pnl_pct).slice(0, 3)
      .map((r) => `${r.symbol}: ${r.pnl_pct.toFixed(1)}%`).join(", ");
    const bot3    = result.results.slice().sort((a, b) => a.pnl_pct - b.pnl_pct).slice(0, 3)
      .map((r) => `${r.symbol}: ${r.pnl_pct.toFixed(1)}%`).join(", ");
    const text = [
      `🌌 <b>Legacy Paper Sweep</b>`,
      `Closed ${result.swept} matured trades (pre-fix era)`,
      `Winners: ${winners} | Losers: ${losers}`,
      `Avg PnL: <b>${result.totalPnlPct.toFixed(2)}%</b>`,
      `Top 3: ${top3}`,
      `Bottom 3: ${bot3}`,
      `<i>Note: snapshot-based PnL, not market re-evaluated</i>`,
    ].join("\n");
    await sendMessage(text);
    console.log("Telegram aggregate notif sent.");
  } else if (!isDry && result.swept > 0) {
    console.log("Telegram disabled — skipped aggregate notif.");
  }
}

main().catch((err) => {
  console.error("sweep-paper-trades failed:", err);
  process.exit(1);
});
