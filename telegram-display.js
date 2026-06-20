// ─── Telegram display formatters (Sirius comms) ──────────────────
// Pure, side-effect-free render helpers for operator-facing Telegram
// messages. Extracted so they can be unit-tested without booting index.js
// (the main agent entry). NO money logic, NO gates — display only.
//
// Design goals (Bro feedback 2026-06-20):
//   - NO abstract "<n>" placeholders — always show a CONCRETE real index
//     (posisi #1 → "/close 1"), so the operator never wonders what to type.
//   - Plain Indonesia labels (mix EN ok), minimal raw jargon.
//   - Fee = INCOME/earned (DLMM LPs earn fees, never pay them) — label it
//     so it is NEVER misread as a cost.
//   - Duration in "Xj Ym" (jam/menit), not raw "304m".

// minutes → "Xj Ym" (jam/menit). "?" on missing/invalid.
export function formatAgeIndo(mins) {
  if (mins == null) return "?";
  const m = Math.round(Number(mins));
  if (!Number.isFinite(m) || m < 0) return "?";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}j` : `${h}j ${rem}m`;
}

// Render the full /positions message body. `cur` is the currency glyph
// ("$" or "◎" in solMode). Returns the exact string sent to Telegram.
export function formatPositionsMessage(positions, totalPositions, cur = "$") {
  if (!Array.isArray(positions) || positions.length === 0) {
    return "Belum ada posisi terbuka.";
  }
  // Render a signed currency amount: "+$3.44" / "-$1.50". Non-finite → treat as 0.
  const signedAmount = (num) => {
    const v = Number.isFinite(num) ? num : 0;
    return v >= 0 ? `+${cur}${v.toFixed(2)}` : `-${cur}${Math.abs(v).toFixed(2)}`;
  };
  const blocks = positions.map((p, i) => {
    const n = i + 1;
    const pnlNum = Number(p.pnl_usd);
    const feesNum = Number(p.unclaimed_fees_usd);
    const pnlSafe = Number.isFinite(pnlNum) ? pnlNum : 0;
    const feesSafe = Number.isFinite(feesNum) ? feesNum : 0;
    const pnl = signedAmount(pnlNum);
    const fees = `${cur}${feesSafe.toFixed(2)}`;
    // Total kalau ditutup sekarang = PnL harga + fee (Lyra: additif, no overlap).
    // Loss case aman: pnlSafe bisa negatif, total = pnl + fee bisa net +/-.
    const total = signedAmount(pnlSafe + feesSafe);
    const value = `${cur}${Number(p.total_value_usd ?? 0).toFixed(2)}`;
    const age = formatAgeIndo(p.age_minutes);
    const status = p.in_range ? "✅ Dalam range" : "⚠️ Keluar range (OOR)";
    return [
      `#${n}  ${p.pair}`,
      `   Nilai posisi: ${value}`,
      `   Untung/Rugi (harga saja, belum termasuk fee): ${pnl}`,
      `   Fee didapat (income, belum diklaim): ${fees}`,
      `   Total kalau ditutup sekarang (≈ sebelum gas): ${total}`,
      `   Umur: ${age}  |  ${status}`,
    ].join("\n");
  });
  const helpLine = positions.length === 1
    ? `Balas \`/close 1\` buat tutup posisi #1, atau \`/set 1 catatanmu\` buat kasih instruksi.`
    : `Balas \`/close 1\` (ganti 1 dengan nomor posisi) buat tutup, atau \`/set 1 catatanmu\` buat kasih instruksi.`;
  return `📊 Posisi Terbuka (${totalPositions}):\n\n${blocks.join("\n\n")}\n\n${helpLine}`;
}
