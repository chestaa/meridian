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

// Build an HONEST DLMM take-profit label. DLMM LPs earn fees by churning the
// active bin — there is NO hard TP price like a spot trade, so we NEVER invent
// a "TP: $X" number. We map the bot's REAL exit mechanics to a plain label:
//   - trailing TP on  → "trailing +Xm% (drop -Ym%) + fee-harvest"
//   - trailing TP off but takeProfitPct set → "auto +Xm% + fee-harvest"
//   - neither           → "auto (fee-harvest)"
// `opts` carries the live config (trailingTakeProfit, trailingTriggerPct,
// trailingDropPct, takeProfitPct). All optional — missing → safest honest label.
export function formatTpLabel(opts = {}) {
  const trig = Number(opts.trailingTriggerPct);
  const drop = Number(opts.trailingDropPct);
  const tp = Number(opts.takeProfitPct);
  if (opts.trailingTakeProfit && Number.isFinite(trig) && trig > 0) {
    const dropStr = Number.isFinite(drop) && drop > 0 ? ` (drop -${drop}%)` : "";
    return `trailing +${trig}%${dropStr} + fee-harvest`;
  }
  if (Number.isFinite(tp) && tp > 0) {
    return `auto +${tp}% + fee-harvest`;
  }
  return "auto (fee-harvest)";
}

// Build an HONEST stop-loss label from the live config stopLossPct. The config
// value is the loss-side trigger (e.g. -8 → "-8%"). Missing/invalid → "auto".
export function formatSlLabel(opts = {}) {
  const sl = Number(opts.stopLossPct);
  if (!Number.isFinite(sl) || sl === 0) return "auto";
  // Normalize sign: config may store -8 or 8 for "8% down". Always render "-N%".
  const mag = Math.abs(sl);
  return `-${mag}%`;
}

// Render the full /positions message body as a TRADE CARD (Bro feedback
// 2026-06-20 round 3): familiar crypto trade-setup layout — Entry / PnL / SL /
// TP / Umur — but kept SIMPLE (4-5 lines per position). DLMM ≠ spot, so the
// mapping is honest:
//   - Entry  = cost basis at deploy ($ = total_value_usd − pnl_usd) + (SOL
//     deployed) when tracked. This is what was put IN, derived not invented.
//   - PnL    = total if closed now (price PnL + unclaimed fee), in $ AND %.
//     The % uses the fee-inclusive net (pnl_pct_fee_inclusive) when available —
//     the TRUE economic return — falling back to pnl_pct (price-only).
//   - SL     = stopLossPct from config (protection level), shown plainly.
//   - TP     = HONEST label (DLMM has no hard TP price — never invent a number;
//     map to the real trailing/fee-harvest exit mechanics).
//   - Umur   = time since entry ("Xj Ym").
//   - Status = ✅ untung / 🔴 rugi + dalam/luar range.
// Full per-position breakdown (nilai/harga/fee/bin) still lives in `/pool N`.
//
// `cur` is the currency glyph ("$" or "◎" in solMode). `opts` carries the live
// SL/TP config (stopLossPct, trailingTakeProfit, trailingTriggerPct,
// trailingDropPct, takeProfitPct) — all optional, fail to honest defaults.
export function formatPositionsMessage(positions, totalPositions, cur = "$", opts = {}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return "Belum ada posisi terbuka.";
  }
  // Render a signed currency amount: "+$3.44" / "-$1.50". Non-finite → treat as 0.
  const signedAmount = (num) => {
    const v = Number.isFinite(num) ? num : 0;
    return v >= 0 ? `+${cur}${v.toFixed(2)}` : `-${cur}${Math.abs(v).toFixed(2)}`;
  };
  // Render a signed percent: "+21%" / "-5%". Non-finite → "".
  const signedPct = (num) => {
    const v = Number(num);
    if (!Number.isFinite(v)) return "";
    const rounded = Math.round(v);
    return rounded >= 0 ? `+${rounded}%` : `-${Math.abs(rounded)}%`;
  };
  // SL/TP are GLOBAL config (same for every position) — compute once.
  const slLabel = formatSlLabel(opts);
  const tpLabel = formatTpLabel(opts);
  const blocks = positions.map((p, i) => {
    const n = i + 1;
    const pnlNum = Number(p.pnl_usd);
    const feesNum = Number(p.unclaimed_fees_usd);
    const valNum = Number(p.total_value_usd);
    const pnlSafe = Number.isFinite(pnlNum) ? pnlNum : 0;
    const feesSafe = Number.isFinite(feesNum) ? feesNum : 0;
    const valSafe = Number.isFinite(valNum) ? valNum : 0;
    // Entry $ = cost basis = current value − price PnL (derived, not invented).
    const entryUsd = valSafe - pnlSafe;
    const solNum = Number(p.amount_sol);
    const solStr = Number.isFinite(solNum) && solNum > 0 ? ` (${solNum} SOL)` : "";
    // PnL now = total kalau ditutup = PnL harga + fee (additif, no overlap).
    const totalNum = pnlSafe + feesSafe;
    const totalStr = signedAmount(totalNum);
    // % prefers the fee-inclusive net (TRUE economic return) over price-only.
    const pctSource = Number.isFinite(Number(p.pnl_pct_fee_inclusive))
      ? p.pnl_pct_fee_inclusive
      : p.pnl_pct;
    const pctStr = signedPct(pctSource);
    const pnlLine = pctStr ? `${totalStr} (${pctStr})` : totalStr;
    const age = formatAgeIndo(p.age_minutes);
    // Status: emoji untung/rugi + dalam/luar range, di header row.
    const pnlEmoji = totalNum >= 0 ? "✅" : "🔴";
    const rangeWord = p.in_range ? "dalam range" : "luar range";
    return [
      `#${n}  ${p.pair}  ${pnlEmoji} ${rangeWord}`,
      `   Entry:  ${cur}${entryUsd.toFixed(2)}${solStr}`,
      `   PnL:    ${pnlLine}`,
      `   SL:     ${slLabel}   ·   TP: ${tpLabel}`,
      `   Umur:   ${age}`,
    ].join("\n");
  });
  // Help: /close N utama; /pool N untuk detail.
  const helpLine = positions.length === 1
    ? "`/close 1` buat tutup · `/pool 1` buat detail"
    : "`/close N` buat tutup · `/pool N` buat detail (ganti N dengan nomor posisi)";
  return `📊 Posisi (${totalPositions}):\n\n${blocks.join("\n\n")}\n\n${helpLine}`;
}

// Render the /journal message — riwayat closed trades (Sirius). Plain executive,
// scannable, one line per trade in the same trade-card spirit as /positions.
// HONEST numbers only: the rows carry realized SOL (post money-honesty fix) and
// the LP-PnL pct — losses are shown as losses, breakeven as breakeven. NEVER
// the buggy wallet_delta. `journal` is the object from getTradeJournal().
//   - win  ✅   loss 🔴   breakeven ⚪
//   - shows fee income (+$X) when meaningful (≥ $0.01)
//   - date as "DD Mon" in local-ish short form (UTC-safe, no tz drama)
export function formatTradeJournal(journal, cur = "$") {
  if (!journal || !Array.isArray(journal.rows) || journal.rows.length === 0) {
    return "📒 Belum ada riwayat trade (belum ada posisi yang ditutup).";
  }
  const { rows, summary } = journal;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return `${String(d.getUTCDate()).padStart(2, " ")} ${MONTHS[d.getUTCMonth()]}`;
  };

  const emoji = (r) => (r === "win" ? "✅" : r === "loss" ? "🔴" : "⚪");
  const signedPct = (num) => {
    const v = Number(num);
    if (!Number.isFinite(v)) return "";
    const r = Math.round(v * 100) / 100;
    return r >= 0 ? `+${r}%` : `${r}%`;
  };

  const lines = rows.map((r) => {
    const date = fmtDate(r.closed_at);
    const name = String(r.pool_name).slice(0, 14).padEnd(14, " ");
    const pct = signedPct(r.pnl_pct);
    const tag = r.result === "breakeven" ? " (breakeven)" : "";
    // Fee income shown only when meaningful ($0.01+) so micro-noise stays quiet.
    const feeStr = Number.isFinite(r.fees_earned_usd) && r.fees_earned_usd >= 0.01
      ? ` (fee +${cur}${r.fees_earned_usd.toFixed(1)})`
      : "";
    const src = r.source === "paper" ? " ·paper" : "";
    return `${date}  ${name} ${emoji(r.result)} ${pct}${tag}${feeStr}${src}`;
  });

  // Summary header — honest net (SOL when known, plus $) + win-rate + count.
  const netSolStr = summary.net_sol != null
    ? `${summary.net_sol >= 0 ? "+" : ""}${summary.net_sol} SOL`
    : null;
  const netUsdStr = `${summary.net_usd >= 0 ? "+" : "-"}${cur}${Math.abs(summary.net_usd).toFixed(2)}`;
  const netStr = netSolStr ? `${netSolStr} (${netUsdStr})` : netUsdStr;
  const header = `Net: ${netStr} · Win-rate ${summary.win_rate_pct}% · ${summary.total_trades} trade`;

  return [
    `📒 Riwayat Trade (${rows.length} terakhir)`,
    header,
    "─────────",
    ...lines,
  ].join("\n");
}
