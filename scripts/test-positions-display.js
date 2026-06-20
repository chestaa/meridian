// Sirius — /positions Telegram display tests (Bro UX fix 2026-06-20 round 3).
//
// Bro request (round 3): make /positions look like a familiar CRYPTO TRADE
// SETUP card — Entry / PnL / SL / TP / Umur — but kept SIMPLE (4-5 lines per
// position). DLMM ≠ spot, so the mapping is HONEST:
//   - Entry  = cost basis at deploy ($ = total_value_usd − pnl_usd) + (SOL) when tracked
//   - PnL    = total if closed now (price PnL + unclaimed fee), $ AND % (fee-inclusive)
//   - SL     = stopLossPct from config (protection level)
//   - TP     = HONEST label (no hard TP price in DLMM — never invent a number)
//   - Umur   = "Xj Ym"
//   - Status = ✅ untung / 🔴 rugi + dalam/luar range
//
// This verifies:
//   - trade-card layout: Entry / PnL / SL / TP / Umur lines present
//   - Entry derived (value − pnl) + SOL deployed shown when tracked
//   - PnL shows $ AND % (fee-inclusive % preferred over price-only)
//   - SL shows config value as "-N%"; TP label is HONEST (no fabricated price)
//   - emoji status (✅ / 🔴) + dalam/luar range
//   - graceful null: missing numerics → no NaN, sensible defaults
//   - NO abstract "<n>" placeholders; `/close N` + `/pool N` footer
//   - /help still carries concrete examples; /pool N detail keeps full breakdown
//
// Run: node scripts/test-positions-display.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const { formatAgeIndo, formatPositionsMessage, formatTpLabel, formatSlLabel } =
  await import("../telegram-display.js");

// ── formatAgeIndo: minutes → "Xj Ym" ──────────────────────────────
check("304m → 5j 4m", formatAgeIndo(304) === "5j 4m");
check("60m → 1j (no trailing minutes)", formatAgeIndo(60) === "1j");
check("125m → 2j 5m", formatAgeIndo(125) === "2j 5m");
check("45m → 45m (under an hour stays minutes)", formatAgeIndo(45) === "45m");
check("0m → 0m", formatAgeIndo(0) === "0m");
check("null → ?", formatAgeIndo(null) === "?");
check("undefined → ?", formatAgeIndo(undefined) === "?");
check("negative → ?", formatAgeIndo(-5) === "?");
check("NaN → ?", formatAgeIndo("abc") === "?");

// ── formatSlLabel: honest config-driven stop-loss ─────────────────
check("SL -8 → '-8%'", formatSlLabel({ stopLossPct: -8 }) === "-8%");
check("SL 8 (positive stored) → '-8%'", formatSlLabel({ stopLossPct: 8 }) === "-8%");
check("SL 0 → 'auto'", formatSlLabel({ stopLossPct: 0 }) === "auto");
check("SL missing → 'auto'", formatSlLabel({}) === "auto");
check("SL NaN → 'auto'", formatSlLabel({ stopLossPct: "x" }) === "auto");

// ── formatTpLabel: HONEST — never a fabricated TP price ───────────
const tpTrailing = formatTpLabel({ trailingTakeProfit: true, trailingTriggerPct: 15, trailingDropPct: 5 });
check("TP trailing: shows trigger %", tpTrailing.includes("+15%"));
check("TP trailing: shows drop %", tpTrailing.includes("drop -5%"));
check("TP trailing: mentions fee-harvest", tpTrailing.includes("fee-harvest"));
check("TP trailing: NO fabricated '$' price", !tpTrailing.includes("$"));
const tpAuto = formatTpLabel({ trailingTakeProfit: false, takeProfitPct: 30 });
check("TP non-trailing w/ takeProfit: shows +30%", tpAuto.includes("+30%"));
check("TP non-trailing: mentions fee-harvest", tpAuto.includes("fee-harvest"));
const tpNone = formatTpLabel({});
check("TP none → honest 'auto (fee-harvest)'", tpNone === "auto (fee-harvest)");
check("TP none: NO fabricated number", !/\d/.test(tpNone));

// ── trade-card opts used across position tests ────────────────────
const opts = {
  stopLossPct: -8,
  takeProfitPct: 0,
  trailingTakeProfit: true,
  trailingTriggerPct: 15,
  trailingDropPct: 5,
};

// ── formatPositionsMessage: single position (winner) ──────────────
// Entry $ = value(32.0849) − pnl(3.437) = 28.6479 → $28.65
// PnL $ = pnl(3.437) + fee(2.8095) = 6.2465 → +$6.25
// PnL % uses fee-inclusive (21) → +21%
const onePos = [{
  pair: "SOLANGELES-SOL",
  total_value_usd: 32.0849,
  pnl_usd: 3.437,
  pnl_pct: 11,
  pnl_pct_fee_inclusive: 21,
  unclaimed_fees_usd: 2.8095,
  amount_sol: 0.45,
  age_minutes: 304,
  in_range: true,
}];
const msg1 = formatPositionsMessage(onePos, 1, "$", opts);

check("single: NO abstract <n> placeholder anywhere", !msg1.includes("<n>"));
check("single: shows concrete '/close 1'", msg1.includes("/close 1"));
check("single: footer points detail to '/pool 1'", msg1.includes("/pool 1"));
check("single: header 'Posisi (1)'", msg1.includes("📊 Posisi (1)"));
check("single: row indexed '#1'", msg1.includes("#1"));
check("single: pair name shown", msg1.includes("SOLANGELES-SOL"));
// ── trade-card lines ──
check("single: Entry line present", /Entry:\s+\$28\.65/.test(msg1));
check("single: Entry shows SOL deployed", msg1.includes("(0.45 SOL)"));
check("single: PnL line shows $ total (+$6.25)", msg1.includes("+$6.25"));
check("single: PnL line shows fee-inclusive % (+21%)", msg1.includes("(+21%)"));
check("single: PnL % NOT the price-only 11%", !msg1.includes("(+11%)"));
check("single: SL line shows -8%", /SL:\s+-8%/.test(msg1));
check("single: TP line shows honest trailing label", /TP:\s+trailing \+15%/.test(msg1));
check("single: TP has NO fabricated $ price", !/TP:[^\n]*\$\d/.test(msg1));
check("single: Umur line in jam-menit (5j 4m)", /Umur:\s+5j 4m/.test(msg1));
check("single: winner emoji ✅ on header row", msg1.includes("✅"));
check("single: 'dalam range' word shown", msg1.includes("dalam range"));
// ── old dead-simple / breakdown strings must NOT appear ──
check("single: NO old 'Kalau ditutup sekarang' list line", !msg1.includes("Kalau ditutup sekarang"));
check("single: NO 'Nilai posisi' breakdown in list", !msg1.includes("Nilai posisi"));
check("single: NO 'Fee didapat' breakdown in list", !msg1.includes("Fee didapat"));
check("single: NO '/set' in list footer", !msg1.includes("/set"));
check("single: NO raw trailing '304m'", !msg1.includes("304m"));
check("single: NO 'NaN' leaks", !msg1.includes("NaN"));

// ── multiple positions (loss + winner) ────────────────────────────
const twoPos = [
  // pos#1 LOSS: value 9, pnl -1.5 → entry 10.5; total -1.5 + 0.5 fee = -1.0; pct -5
  { pair: "A-SOL", total_value_usd: 9, pnl_usd: -1.5, pnl_pct: -5, pnl_pct_fee_inclusive: -4, unclaimed_fees_usd: 0.5, amount_sol: 0.2, age_minutes: 30, in_range: false },
  // pos#2 WIN: value 23, pnl 2.0 → entry 21; total 2.0 + 1.0 fee = 3.0; pct 14
  { pair: "B-SOL", total_value_usd: 23, pnl_usd: 2.0, pnl_pct: 9, pnl_pct_fee_inclusive: 14, unclaimed_fees_usd: 1.0, amount_sol: 0.5, age_minutes: 125, in_range: true },
];
const msg2 = formatPositionsMessage(twoPos, 2, "$", opts);
check("multi: header counts 2", msg2.includes("📊 Posisi (2)"));
check("multi: shows #1 and #2", msg2.includes("#1") && msg2.includes("#2"));
check("multi: footer '/close N' + '/pool N'", msg2.includes("/close N") && msg2.includes("/pool N"));
// loss pos#1
check("multi: loss PnL total -$1.00", msg2.includes("-$1.00"));
check("multi: loss emoji 🔴 present", msg2.includes("🔴"));
check("multi: loss fee-inclusive % (-4%)", msg2.includes("(-4%)"));
check("multi: 'luar range' for out-of-range pos", msg2.includes("luar range"));
check("multi: pos#1 Entry $10.50", /Entry:\s+\$10\.50/.test(msg2));
// winner pos#2
check("multi: winner PnL total +$3.00", msg2.includes("+$3.00"));
check("multi: winner Entry $21.00", /Entry:\s+\$21\.00/.test(msg2));
check("multi: winner age 2j 5m", msg2.includes("2j 5m"));

// ── empty + solMode ───────────────────────────────────────────────
check("empty → plain 'belum ada posisi'", formatPositionsMessage([], 0) === "Belum ada posisi terbuka.");
const msgSol = formatPositionsMessage(onePos, 1, "◎", opts);
check("solMode: ◎ glyph in Entry/PnL", msgSol.includes("◎28.65") && msgSol.includes("+◎6.25"));

// ── fail-safe: missing numeric fields default to 0, never crash ───
const sparse = [{ pair: "X-SOL", in_range: true }];
let sparseMsg = "";
let crashed = false;
try { sparseMsg = formatPositionsMessage(sparse, 1, "$", opts); } catch { crashed = true; }
check("sparse: does not crash on missing fields", !crashed);
check("sparse: missing age → ? in Umur line", /Umur:\s+\?/.test(sparseMsg));
check("sparse: Entry → $0.00 (no NaN)", /Entry:\s+\$0\.00/.test(sparseMsg));
check("sparse: PnL → +$0.00 (no NaN)", sparseMsg.includes("+$0.00"));
check("sparse: NO SOL paren when amount_sol missing", !sparseMsg.includes("SOL)"));
check("sparse: NO '%' when pct missing (graceful)", !/PnL:[^\n]*%/.test(sparseMsg));
check("sparse: NO 'NaN' leaks anywhere", !sparseMsg.includes("NaN"));

// ── fail-safe: no opts passed → SL/TP honest defaults, no crash ───
const msgNoOpts = formatPositionsMessage(onePos, 1, "$");
check("no-opts: SL → 'auto'", msgNoOpts.includes("SL:     auto"));
check("no-opts: TP → 'auto (fee-harvest)'", msgNoOpts.includes("auto (fee-harvest)"));

// ── audit: /help text in index.js carries NO abstract placeholders ─
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const helpStart = indexSrc.indexOf("function formatHelpText()");
const helpEnd = indexSrc.indexOf("}", indexSrc.indexOf("].join(\"\\n\");", helpStart));
const helpBlock = indexSrc.slice(helpStart, helpEnd);
check("help: no '<n>' placeholder", !helpBlock.includes("<n>"));
check("help: no '<note>' placeholder", !helpBlock.includes("<note>"));
check("help: concrete '/close 1' example", helpBlock.includes("/close 1"));
check("help: concrete '/set 1' example", helpBlock.includes("/set 1"));

// ── audit: /pool N detail handler keeps the FULL breakdown ─────────
const poolStart = indexSrc.indexOf("const poolMatch");
const poolEnd = indexSrc.indexOf("const closeMatch");
const poolBlock = indexSrc.slice(poolStart, poolEnd);
check("/pool: carries 'Kalau ditutup sekarang' total line", poolBlock.includes("Kalau ditutup sekarang"));
check("/pool: keeps 'Nilai posisi' breakdown", poolBlock.includes("Nilai posisi"));
check("/pool: keeps 'Untung/Rugi (harga saja)' breakdown", poolBlock.includes("Untung/Rugi (harga saja)"));
check("/pool: keeps 'Fee didapat' breakdown", poolBlock.includes("Fee didapat"));
check("/pool: keeps bin range detail", poolBlock.includes("Range bin"));

// ── audit: /positions wires live SL/TP config into the trade-card ─
check("wiring: /positions passes stopLossPct to formatPositionsMessage",
  indexSrc.includes("stopLossPct: config.management.stopLossPct"));
check("wiring: /positions passes trailing config",
  indexSrc.includes("trailingTriggerPct: config.management.trailingTriggerPct"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
