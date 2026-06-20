// Sirius — /positions Telegram display tests (Bro UX fix 2026-06-20 round 2).
//
// Bro complaint (round 2): the 3-money-line breakdown (nilai posisi /
// untung-rugi harga / fee / total) di list view bikin pusing. Bro cuma butuh
// SEKILAS: pool apa, untung/rugi, kalau close dapet berapa. So the LIST is now
// DEAD SIMPLE — exactly ONE money line ("Kalau ditutup sekarang: +$X" = PnL
// harga + fee), emoji status (✅ untung / 🔴 rugi) + dalam/luar range, ringkas
// umur, and `/close N`. The per-position breakdown moved to `/pool N`.
//
// This verifies:
//   - list shows ONE money line ("Kalau ditutup sekarang: +$X")
//   - NO 3-line breakdown leaks into the list (no "Nilai posisi" / "harga saja"
//     / "Fee didapat" lines in /positions)
//   - emoji status (✅ / 🔴) + dalam/luar range word
//   - `/close N` present; list footer points detail to `/pool N`
//   - duration rendered "Xj Ym" (jam/menit), not raw "304m"
//   - /help still carries concrete (no "<n>") examples
//   - /pool N detail handler in index.js carries the full breakdown + total
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
check("single: footer points detail to '/pool 1'", msg1.includes("/pool 1"));
check("single: header counts position (simple 'Posisi (1)')", msg1.includes("📊 Posisi (1)"));
check("single: row indexed '#1'", msg1.includes("#1"));
check("single: pair name shown", msg1.includes("SOLANGELES-SOL"));
// ── ONE money line: "Kalau ditutup sekarang" = PnL harga + fee (additif) ──
check("single: ONE money line 'Kalau ditutup sekarang'", /Kalau ditutup sekarang:/.test(msg1));
// 3.437 + 2.8095 = 6.2465 → +$6.25
check("single: money line = pnl+fee (+$6.25)", msg1.includes("Kalau ditutup sekarang: +$6.25"));
check("single: winner emoji ✅ on the row", msg1.includes("✅"));
check("single: age in jam-menit (5j 4m)", msg1.includes("5j 4m"));
check("single: 'dalam range' word shown", msg1.includes("dalam range"));
// ── breakdown MUST be gone from list (moved to /pool N) ──────────────
check("single: NO 'Nilai posisi' breakdown in list", !msg1.includes("Nilai posisi"));
check("single: NO 'harga saja' breakdown in list", !msg1.includes("harga saja"));
check("single: NO 'Fee didapat' breakdown in list", !msg1.includes("Fee didapat"));
check("single: NO standalone 'Total kalau ditutup' label in list",
  !/Total kalau ditutup sekarang/.test(msg1));
check("single: NO '/set' in list footer (moved to /pool/help)", !msg1.includes("/set"));
check("single: NO raw 'PnL:' jargon label", !/\bPnL:/.test(msg1));
check("single: NO raw trailing '304m'", !msg1.includes("304m"));

// ── multiple positions ────────────────────────────────────────────
const twoPos = [
  { pair: "A-SOL", total_value_usd: 10, pnl_usd: -1.5, unclaimed_fees_usd: 0.5, age_minutes: 30, in_range: false },
  { pair: "B-SOL", total_value_usd: 20, pnl_usd: 2.0, unclaimed_fees_usd: 1.0, age_minutes: 125, in_range: true },
];
const msg2 = formatPositionsMessage(twoPos, 2, "$");
check("multi: header counts 2 (simple)", msg2.includes("📊 Posisi (2)"));
check("multi: shows #1 and #2", msg2.includes("#1") && msg2.includes("#2"));
check("multi: NO <n> placeholder", !msg2.includes("<n>"));
check("multi: concrete close example present", msg2.includes("/close N"));
check("multi: footer points detail to '/pool N'", msg2.includes("/pool N"));
// pos#1 pnl -1.5 + fee 0.5 = -1.0 (net loss) → one money line, 🔴 emoji
check("multi: loss-case money line = pnl+fee (-$1.00)", msg2.includes("Kalau ditutup sekarang: -$1.00"));
check("multi: loss emoji 🔴 present", msg2.includes("🔴"));
check("multi: 'luar range' word for out-of-range pos", msg2.includes("luar range"));
check("multi: second pos age 2j 5m", msg2.includes("2j 5m"));
// pos#2 pnl 2.0 + fee 1.0 = 3.0 (winner total)
check("multi: winner money line = pnl+fee (+$3.00)", msg2.includes("Kalau ditutup sekarang: +$3.00"));
check("multi: NO breakdown 'Nilai posisi' anywhere", !msg2.includes("Nilai posisi"));

// ── empty + solMode ───────────────────────────────────────────────
check("empty → plain 'belum ada posisi'", formatPositionsMessage([], 0) === "Belum ada posisi terbuka.");
const msgSol = formatPositionsMessage(onePos, 1, "◎");
// money line in solMode: 3.437 + 2.8095 = 6.2465 → +◎6.25
check("solMode: uses ◎ glyph in money line", msgSol.includes("Kalau ditutup sekarang: +◎6.25"));

// ── fail-safe: missing numeric fields default to 0, never crash ───
const sparse = [{ pair: "X-SOL", in_range: true }];
let sparseMsg = "";
let crashed = false;
try { sparseMsg = formatPositionsMessage(sparse, 1, "$"); } catch { crashed = true; }
check("sparse: does not crash on missing fields", !crashed);
check("sparse: missing age → ?", sparseMsg.includes("Umur ?"));
// Graceful null: pnl_usd + fee both missing → money line +$0.00, no NaN
check("sparse: money line present, no NaN", /Kalau ditutup sekarang: \+\$0\.00/.test(sparseMsg));
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

// ── audit: /pool N detail handler keeps the FULL breakdown (info moved,
//     not lost) — total + nilai posisi + harga-saja + fee ──────────────
const poolStart = indexSrc.indexOf("const poolMatch");
const poolEnd = indexSrc.indexOf("const closeMatch");
const poolBlock = indexSrc.slice(poolStart, poolEnd);
check("/pool: carries 'Kalau ditutup sekarang' total line",
  poolBlock.includes("Kalau ditutup sekarang"));
check("/pool: keeps 'Nilai posisi' breakdown", poolBlock.includes("Nilai posisi"));
check("/pool: keeps 'Untung/Rugi (harga saja)' breakdown",
  poolBlock.includes("Untung/Rugi (harga saja)"));
check("/pool: keeps 'Fee didapat' breakdown", poolBlock.includes("Fee didapat"));
check("/pool: keeps bin range detail", poolBlock.includes("Range bin"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
