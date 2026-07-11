// Lyra — /journal money-honesty tests (Bro 2026-07-11 "terutama journal").
//
// The /journal view now LEADS with realized SOL (wallet truth) and demotes the
// price-only pnl% to a parenthetical. A trade whose LP-PnL reads positive but
// whose wallet delta is negative (slippage+gas ate the thin win) must READ as a
// loss — never a fake gain. Win/loss/breakeven markers key on realized SOL vs
// the meaningful bar (default 0.005 SOL). Close-reason is surfaced in plain
// Indonesian (incl. Andromeda's oor_up_fast_harvest / give_back_protect).
//
// The journal is sent via plain-text sendMessage (NOT parse_mode HTML), so the
// output must carry NO HTML tags.
//
// Layers verified:
//   getTradeJournal (lessons.js)    — data shape + realized-based classification
//   formatTradeJournal (telegram-display.js) — honest render
//   formatCloseReason (telegram-display.js)  — plain-language reason mapping
//
// Run: node scripts/test-trade-journal.js

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { formatTradeJournal, formatCloseReason } = await import("../telegram-display.js");

// ── formatCloseReason: plain-language mapping ───────────────────────
check("close reason: stop_loss → stop-loss", formatCloseReason("stop_loss") === "stop-loss");
check("close reason: spaced 'stop loss' → stop-loss", formatCloseReason("stop loss") === "stop-loss");
check("close reason: take_profit → take-profit", formatCloseReason("take_profit") === "take-profit");
check("close reason: trailing_oor → trailing keluar range", formatCloseReason("trailing_oor") === "trailing keluar range");
check("close reason: plain oor → keluar range (OOR)", formatCloseReason("oor") === "keluar range (OOR)");
check("close reason: low_yield → yield rendah", formatCloseReason("low_yield") === "yield rendah");
check("close reason: agent decision → keputusan bot", formatCloseReason("agent decision") === "keputusan bot");
// Andromeda's NEW reasons (not in the ledger yet — must render cleanly on arrival)
check("close reason: oor_up_fast_harvest → harvest label (not raw OOR)",
  formatCloseReason("oor_up_fast_harvest") === "harvest cepat (pump keluar range atas)");
check("close reason: give_back_protect → kunci profit label",
  formatCloseReason("give_back_protect") === "kunci profit (cegah balik turun)");
check("close reason: unknown → de-underscored readable, never raw jargon",
  formatCloseReason("some_new_reason") === "some new reason");
check("close reason: empty/null → empty string", formatCloseReason(null) === "" && formatCloseReason("") === "");

// ── formatTradeJournal: empty / null ───────────────────────────────
check("null journal → 'belum ada riwayat' message",
  /Belum ada riwayat/.test(formatTradeJournal(null)));
check("empty rows → 'belum ada riwayat' message",
  /Belum ada riwayat/.test(formatTradeJournal({ rows: [], summary: null })));

// ── A realistic honest journal (mix win/loss/breakeven) ─────────────
// THE crux row (COZY): +0.5% price-only pnl but NEGATIVE realized SOL — the
// slippage+gas-ate-the-win case. It MUST read as a loss, not a win.
const journal = {
  summary: { total_trades: 47, net_sol: 0.03, net_usd: 4.50, win_rate_pct: 65, win_bar_sol: 0.005 },
  rows: [
    { pool_name: "SOLANGELES", closed_at: "2026-06-21T10:00:00Z", pnl_pct: 13.31, pnl_usd: 2.6, realized_sol: 0.018, fees_earned_usd: 2.6, fees_earned_sol: 0.017, close_reason: "take_profit", source: "live", result: "win" },
    { pool_name: "glippy",     closed_at: "2026-06-21T09:00:00Z", pnl_pct: -7.14, pnl_usd: -1.4, realized_sol: -0.012, fees_earned_usd: 0.0, fees_earned_sol: 0, close_reason: "stop_loss", source: "live", result: "loss" },
    { pool_name: "COZY",       closed_at: "2026-06-20T08:00:00Z", pnl_pct: 0.50, pnl_usd: 0.10, realized_sol: -0.002, fees_earned_usd: 0.2, fees_earned_sol: 0.001, close_reason: "oor", source: "live", result: "loss" },
  ],
};
const out = formatTradeJournal(journal, "$");

check("header shows trade count in title", /Riwayat Trade \(3 terakhir\)/.test(out));
check("summary net SOL shown honest (+0.03 SOL)", out.includes("+0.03 SOL"));
check("summary net $ shown alongside SOL", out.includes("+$4.50"));
check("summary win-rate shown (Menang 65%)", out.includes("Menang 65%"));
check("summary total trade count shown", out.includes("47 trade"));
check("explains the win bar (0.005)", out.includes("0.005"));

// PRIMARY = realized SOL, SECONDARY = pnl% in parens
check("win row leads with realized SOL (+0.0180 SOL)", /SOLANGELES ✅ \+0\.0180 SOL/.test(out));
check("win row shows pnl% secondary in parens (+13.31%)", out.includes("(+13.31%)"));
check("loss row leads with negative realized SOL (-0.0120 SOL)", /glippy 🔴 -0\.0120 SOL/.test(out));

// HONESTY CRUX — COZY: +0.5% price-only but -0.002 SOL realized ⇒ MUST read loss
check("HONESTY: +pnl%-but-negative-realized reads as LOSS 🔴, not a win", /COZY 🔴/.test(out));
check("HONESTY: COZY leads with the negative realized SOL (-0.0020 SOL)", out.includes("-0.0020 SOL"));
check("HONESTY: COZY still shows the (misleading) +0.5% only in parens", out.includes("(+0.5%)"));
check("HONESTY: COZY is NOT marked ✅", !/COZY ✅/.test(out));

// close-reason surfaced in plain language
check("win row shows plain close-reason 'take-profit'", /SOLANGELES.*take-profit/.test(out));
check("loss row shows plain close-reason 'stop-loss'", /glippy.*stop-loss/.test(out));

// fee income shown when meaningful
check("meaningful fee shown for win (fee +$2.6)", out.includes("fee +$2.6"));
check("zero fee NOT shown for glippy loss row", !/glippy.*fee/.test(out));

// misc
check("date rendered as 'DD Mon' Indonesian month", out.includes("21 Jun"));
check("live trades carry NO ·paper tag", !out.includes("·paper"));
// plain-text channel: NO HTML tags may leak into /journal
check("NO HTML tags in journal output (plain-text channel)", !/<\/?[a-z]+>/i.test(out));

// ── breakeven marker keyed on the bar (within ±0.005 SOL) ───────────
const beJournal = {
  summary: { total_trades: 1, net_sol: 0.0, net_usd: 0.0, win_rate_pct: 0, win_bar_sol: 0.005 },
  rows: [
    { pool_name: "FLAT", closed_at: "2026-06-21T10:00:00Z", pnl_pct: 0.1, pnl_usd: 0.02, realized_sol: 0.001, fees_earned_usd: 0.0, fees_earned_sol: 0, close_reason: "agent decision", source: "live", result: "breakeven" },
  ],
};
const beOut = formatTradeJournal(beJournal, "$");
check("breakeven row marked ⚪ + 'impas'", /FLAT ⚪.*impas/.test(beOut));

// ── paper-source tagging + net-SOL omission ─────────────────────────
const paperJournal = {
  summary: { total_trades: 2, net_sol: null, net_usd: -0.5, win_rate_pct: 50, win_bar_sol: 0.005 },
  rows: [
    { pool_name: "TESTPOOL", closed_at: "2026-06-21T10:00:00Z", pnl_pct: 5.0, pnl_usd: 1.0, realized_sol: null, fees_earned_usd: null, fees_earned_sol: null, close_reason: null, source: "paper", result: "win" },
  ],
};
const pout = formatTradeJournal(paperJournal, "$");
check("paper trade carries ·paper tag", pout.includes("·paper"));
check("paper row falls back to price-only pct tagged (harga)", pout.includes("+5% (harga)"));
// The NET summary must not fabricate a SOL figure when net_sol is unknown.
const poutHeaderLine = pout.split("\n").find((l) => l.startsWith("Net bersih:"));
check("net summary omits SOL figure when unknown — falls back to $ only",
  poutHeaderLine != null && !/\bSOL\b/.test(poutHeaderLine) && poutHeaderLine.includes("-$0.50"));

// ── solMode currency glyph ──────────────────────────────────────────
const solOut = formatTradeJournal(journal, "◎");
check("solMode uses ◎ glyph for fee", solOut.includes("fee +◎2.6"));

// ── getTradeJournal data layer (lessons.js) shape ───────────────────
const { getTradeJournal } = await import("../lessons.js");
const live = getTradeJournal({ limit: 5 });
check("getTradeJournal returns {rows, summary} shape", live && Array.isArray(live.rows) && "summary" in live);
check("empty live ledger → null summary, no rows (no crash)",
  live.rows.length === 0 ? live.summary === null : true);
// projection carries close_reason for the display layer
check("getTradeJournal row projection includes close_reason key",
  live.rows.length === 0 ? true : "close_reason" in live.rows[0]);

// ── closeOutcomeEmoji: the close-notify win/loss sign (telegram.js) ──
// Same money-honesty rule as /journal, but for the CLOSE notification header.
// Single source of truth so notifyClose / /journal / /close never disagree.
const { closeOutcomeEmoji } = await import("../telegram.js");
check("notify emoji: positive realized SOL → ✅",
  closeOutcomeEmoji({ realizedSolDelta: 0.018, pnlSol: 0.02, pnlPct: 13.31 }) === "✅");
check("notify emoji: negative realized SOL → 🔴",
  closeOutcomeEmoji({ realizedSolDelta: -0.012, pnlSol: -0.01, pnlPct: -7.14 }) === "🔴");
// THE CRUX — price-only pnl% POSITIVE but realized SOL NEGATIVE ⇒ must read LOSS.
check("notify emoji CRUX: +pnl% but negative realized → 🔴 (not fake ✅)",
  closeOutcomeEmoji({ realizedSolDelta: -0.002, pnlSol: -0.002, pnlPct: 0.5 }) === "🔴");
check("notify emoji: realized wins over even a strongly positive pnl%",
  closeOutcomeEmoji({ realizedSolDelta: -0.05, pnlSol: 0.9, pnlPct: 55 }) === "🔴");
// No realized figure (paper/legacy) → fall back to pnlSol, then pnlPct.
check("notify emoji: no realized → falls back to pnlSol sign",
  closeOutcomeEmoji({ realizedSolDelta: null, pnlSol: 0.004, pnlPct: 2.1 }) === "✅");
check("notify emoji: no realized/pnlSol → falls back to pnlPct sign",
  closeOutcomeEmoji({ realizedSolDelta: null, pnlSol: null, pnlPct: -3.2 }) === "🔴");
// FAIL-SAFE: nothing finite → neutral ⚪, never a fabricated win/loss.
check("notify emoji: no honest basis → neutral ⚪ (never fabricates)",
  closeOutcomeEmoji({}) === "⚪" && closeOutcomeEmoji({ realizedSolDelta: NaN, pnlSol: null, pnlPct: undefined }) === "⚪");
check("notify emoji: exact-zero realized → neutral ⚪ (breakeven)",
  closeOutcomeEmoji({ realizedSolDelta: 0 }) === "⚪");

// ── notifyClose end-to-end (telegram.js, via __setTestSender hook) ──
// Locks down the full close-notification body: LEADS with realized SOL, demotes
// LP-PnL under a "harga saja" label, header emoji keyed to wallet truth, and the
// received<sent explainer only on a LIVE loss. No Telegram network hit.
const { notifyClose, __setTestSender } = await import("../telegram.js");
let captured = null;
__setTestSender((m) => { captured = m.text; });

// THE CRUX again, at the notify layer — +0.5% LP-PnL but NEGATIVE realized SOL.
await notifyClose({
  pair: "COZY/SOL",
  pnlUsd: 0.10, pnlPct: 0.5, pnlSol: -0.002,
  realizedSolDelta: -0.002, realizedSolDeltaPct: -2.0,
  realizedSolEstimate: true, dryRun: false,
});
check("notifyClose header keyed to LOSS (🔴 Closed), not a fake win",
  captured.startsWith("🔴 <b>Closed</b>"));
check("notifyClose LEADS with Realized SOL (wallet truth) -0.0020",
  /💰 <b>Realized SOL: -0\.0020 SOL/.test(captured));
check("notifyClose flags the estimate (⚠️est) when realizedSolEstimate=true",
  captured.includes("⚠️est"));
check("notifyClose demotes LP-PnL under 'harga saja' label with the +0.50%",
  /LP-PnL \(harga saja, bukan SOL bersih\):.*\+0\.50%/.test(captured));
check("notifyClose shows received<sent explainer on a LIVE loss",
  captured.includes("Diterima &lt; dikirim"));
check("notifyClose escaped the pair name (survives raw &/< injection)",
  captured.includes("COZY/SOL"));

// Positive realized → ✅ header, NO explainer.
await notifyClose({
  pair: "WIN/SOL",
  pnlUsd: 2.6, pnlPct: 13.31, pnlSol: 0.018,
  realizedSolDelta: 0.018, realizedSolDeltaPct: 18.0, dryRun: false,
});
check("notifyClose header ✅ on positive realized SOL", captured.startsWith("✅ <b>Closed</b>"));
check("notifyClose omits the received<sent explainer when NOT a loss",
  !captured.includes("Diterima"));

// No ledger figure → honest 'belum tersedia', never a fabricated wallet number.
await notifyClose({ pair: "PAPER/SOL", pnlPct: 5.0, pnlSol: 0.01, realizedSolDelta: null, dryRun: true });
check("notifyClose with no ledger figure → 'belum tersedia' (no fabrication)",
  captured.includes("Realized SOL: belum tersedia"));

// A raw & / < in the pair name must be HTML-escaped in the notify path.
await notifyClose({ pair: "A&B<x>/SOL", pnlPct: 1, pnlSol: 0.001, realizedSolDelta: 0.001, dryRun: false });
check("notifyClose HTML-escapes raw & and < in pair name (no parse crash)",
  captured.includes("A&amp;B&lt;x&gt;/SOL") && !/A&B<x>/.test(captured));

__setTestSender(null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
