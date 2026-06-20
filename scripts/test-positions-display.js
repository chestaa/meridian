// Sirius — /positions Telegram display tests (Bro UX fix 2026-06-20).
//
// Bro complaint: the old footer showed a literal "<n>" placeholder ("ini apa
// ya ada <n>") and raw labels (PnL / fees / 304m) that left him unsure whether
// fees were income or a cost. This verifies the new display:
//   - CONCRETE real index in the close/set instruction (no abstract "<n>")
//   - fee labeled as INCOME / didapat (never a cost)
//   - PnL labeled with the fee-exclusion caveat (not misleading "profit")
//   - duration rendered "Xj Ym" (jam/menit), not raw "304m"
//   - all command audited: no "<n>"/"<note>"/"<key>"/"<value>" placeholders
//     leak into the operator-facing /positions message or /help text
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

const { formatAgeIndo, formatPositionsMessage } = await import("../telegram-display.js");

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

// ── formatPositionsMessage: single position ───────────────────────
const onePos = [{
  pair: "SOLANGELES-SOL",
  total_value_usd: 32.0849,
  pnl_usd: 3.437,
  unclaimed_fees_usd: 2.8095,
  age_minutes: 304,
  in_range: true,
}];
const msg1 = formatPositionsMessage(onePos, 1, "$");

check("single: NO abstract <n> placeholder anywhere", !msg1.includes("<n>"));
check("single: NO <note> placeholder", !msg1.includes("<note>"));
check("single: shows concrete '/close 1'", msg1.includes("/close 1"));
check("single: shows concrete '/set 1'", msg1.includes("/set 1"));
check("single: header counts position", msg1.includes("Posisi Terbuka (1)"));
check("single: row indexed '#1'", msg1.includes("#1"));
check("single: pair name shown", msg1.includes("SOLANGELES-SOL"));
check("single: value rounded to 2dp ($32.08)", msg1.includes("$32.08"));
check("single: pnl rounded to 2dp (+$3.44)", msg1.includes("+$3.44"));
check("single: fee rounded to 2dp ($2.81)", msg1.includes("$2.81"));
check("single: fee labeled as INCOME/didapat (not a cost)",
  /Fee didapat \(income/.test(msg1));
check("single: PnL labeled HARGA-saja + fee-exclusion caveat",
  /Untung\/Rugi \(harga saja, belum termasuk fee\)/.test(msg1));
// ── Total line: PnL(harga) + fee, additif (Lyra: no overlap) ───────
check("single: Total line present", /Total kalau ditutup sekarang/.test(msg1));
check("single: Total carries 'sebelum gas' caveat", msg1.includes("≈ sebelum gas"));
// 3.437 + 2.8095 = 6.2465 → +$6.25
check("single: Total = pnl+fee (+$6.25)", msg1.includes("+$6.25"));
check("single: age in jam-menit (5j 4m)", msg1.includes("5j 4m"));
check("single: in-range status plain", msg1.includes("Dalam range"));
check("single: NO raw 'PnL:' jargon label", !/\bPnL:/.test(msg1));
check("single: NO raw 'fees:' jargon label", !/\bfees:/.test(msg1));
check("single: NO raw trailing '304m'", !msg1.includes("304m"));

// ── multiple positions ────────────────────────────────────────────
const twoPos = [
  { pair: "A-SOL", total_value_usd: 10, pnl_usd: -1.5, unclaimed_fees_usd: 0.5, age_minutes: 30, in_range: false },
  { pair: "B-SOL", total_value_usd: 20, pnl_usd: 2.0, unclaimed_fees_usd: 1.0, age_minutes: 125, in_range: true },
];
const msg2 = formatPositionsMessage(twoPos, 2, "$");
check("multi: header counts 2", msg2.includes("Posisi Terbuka (2)"));
check("multi: shows #1 and #2", msg2.includes("#1") && msg2.includes("#2"));
check("multi: NO <n> placeholder", !msg2.includes("<n>"));
check("multi: concrete close example present", msg2.includes("/close 1"));
check("multi: negative pnl renders with minus (-$1.50)", msg2.includes("-$1.50"));
check("multi: OOR status shown for out-of-range pos", msg2.includes("Keluar range"));
check("multi: second pos age 2j 5m", msg2.includes("2j 5m"));
// Loss case: pos#1 pnl -1.5 + fee 0.5 = -1.0 (net still loss, computed right)
check("multi: loss-case Total = pnl+fee (-$1.00)", msg2.includes("-$1.00"));
// pos#2 pnl 2.0 + fee 1.0 = 3.0 (winner total)
check("multi: winner Total = pnl+fee (+$3.00)", msg2.includes("+$3.00"));

// ── empty + solMode ───────────────────────────────────────────────
check("empty → plain 'belum ada posisi'", formatPositionsMessage([], 0) === "Belum ada posisi terbuka.");
const msgSol = formatPositionsMessage(onePos, 1, "◎");
check("solMode: uses ◎ glyph for value", msgSol.includes("◎32.08"));

// ── fail-safe: missing numeric fields default to 0, never crash ───
const sparse = [{ pair: "X-SOL", in_range: true }];
let sparseMsg = "";
let crashed = false;
try { sparseMsg = formatPositionsMessage(sparse, 1, "$"); } catch { crashed = true; }
check("sparse: does not crash on missing fields", !crashed);
check("sparse: missing value → $0.00", sparseMsg.includes("$0.00"));
check("sparse: missing age → ?", sparseMsg.includes("Umur: ?"));
// Graceful null: pnl_usd + unclaimed_fees_usd both missing → Total +$0.00, no NaN
check("sparse: Total present, no NaN", /Total kalau ditutup sekarang.*\$0\.00/.test(sparseMsg));
check("sparse: NO 'NaN' leaks anywhere", !sparseMsg.includes("NaN"));

// ── audit: /help text in index.js carries NO abstract placeholders ─
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const helpStart = indexSrc.indexOf("function formatHelpText()");
const helpEnd = indexSrc.indexOf("}", indexSrc.indexOf("].join(\"\\n\");", helpStart));
const helpBlock = indexSrc.slice(helpStart, helpEnd);
check("help: no '<n>' placeholder", !helpBlock.includes("<n>"));
check("help: no '<note>' placeholder", !helpBlock.includes("<note>"));
check("help: no '<key>' placeholder", !helpBlock.includes("<key>"));
check("help: no '<value>' placeholder", !helpBlock.includes("<value>"));
check("help: concrete '/close 1' example", helpBlock.includes("/close 1"));
check("help: concrete '/set 1' example", helpBlock.includes("/set 1"));

// ── audit: no English 'Invalid number. Use /positions first.' leaks ─
check("audit: old English 'Invalid number' string removed",
  !indexSrc.includes("Invalid number. Use /positions first."));
check("audit: old '<n> to close' footer string removed",
  !indexSrc.includes("/close <n> to close"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
