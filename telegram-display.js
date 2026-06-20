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

// Render the full /positions message body — DEAD SIMPLE list view.
// `cur` is the currency glyph ("$" or "◎" in solMode). Returns the exact
// string sent to Telegram.
//
// Bro feedback 2026-06-20 (round 2): the old 3-money-line breakdown
// (nilai posisi / untung-rugi harga / fee) bikin pusing. Bro cuma butuh
// SEKILAS: pool apa, untung/rugi, kalau close dapet berapa. So the LIST
// shows exactly ONE money number — "Kalau ditutup sekarang: +$X" (= PnL
// harga + fee, the only figure Bro acts on) — plus an emoji status, ringkas
// umur, and `/close N`. Per-position breakdown (nilai/harga/fee/bin) lives
// in `/pool N` so info is moved, not lost.
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
    // Satu-satunya angka duit di list: total kalau ditutup = PnL harga + fee
    // (Lyra: additif, no overlap). Loss case aman (bisa net +/-).
    const totalNum = pnlSafe + feesSafe;
    const total = signedAmount(totalNum);
    const age = formatAgeIndo(p.age_minutes);
    // Status: emoji untung/rugi + dalam/luar range, 1 baris ringkas.
    const pnlEmoji = totalNum >= 0 ? "✅" : "🔴";
    const rangeWord = p.in_range ? "dalam range" : "luar range";
    return [
      `#${n}  ${p.pair}  ${pnlEmoji}`,
      `   Kalau ditutup sekarang: ${total}`,
      `   Umur ${age} · ${rangeWord}`,
    ].join("\n");
  });
  // Help: /close N utama; /pool N untuk detail. /set di-drop dari baris utama
  // (tetap berfungsi, cuma ga dipajang biar list ga rame).
  const helpLine = positions.length === 1
    ? "`/close 1` buat tutup · `/pool 1` buat detail"
    : "`/close N` buat tutup · `/pool N` buat detail (ganti N dengan nomor posisi)";
  return `📊 Posisi (${totalPositions}):\n\n${blocks.join("\n\n")}\n\n${helpLine}`;
}
