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

// Map a raw close/exit reason string into a short plain-Indonesian label for
// the /journal view. Keyword-driven (like plainRejectBucket) so it degrades
// safely on novel reason text — unknown reasons fall back to a de-underscored
// readable form rather than raw jargon. Handles BOTH snake_case (ledger) and
// spaced (manager) variants, plus Andromeda's newer exit reasons
// (oor_up_fast_harvest / give_back_protect) so they render cleanly the moment
// they start appearing in the ledger.
export function formatCloseReason(reason) {
  const r = String(reason || "").toLowerCase().trim();
  if (!r) return "";
  // Order matters — most specific keywords first (the compound Andromeda reasons
  // contain substrings like "oor"/"harvest"/"protect" that generic rules match).
  if (/oor_up_fast_harvest|up[_ ]?fast[_ ]?harvest|fast[_ ]?harvest/.test(r)) return "harvest cepat (pump keluar range atas)";
  if (/give_back_protect|give[_ ]?back|protect/.test(r))                      return "kunci profit (cegah balik turun)";
  if (/trailing[_ ]?oor/.test(r))                                             return "trailing keluar range";
  if (/stop[_ ]?loss|\bsl\b/.test(r))                                         return "stop-loss";
  if (/take[_ ]?profit|\btp\b/.test(r))                                       return "take-profit";
  if (/trailing/.test(r))                                                     return "trailing take-profit";
  if (/pumped|far above|above range/.test(r))                                 return "pump jauh di atas range";
  if (/out[_ ]?of[_ ]?range|\boor\b/.test(r))                                 return "keluar range (OOR)";
  if (/low[_ ]?yield|low fee|yield/.test(r))                                  return "yield rendah";
  if (/manual/.test(r))                                                       return "manual";
  if (/agent decision|agent/.test(r))                                         return "keputusan bot";
  return r.replace(/_/g, " ");
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
    // Cost basis = current value − price PnL (derived, not invented). Used as the
    // "masuk" figure when the deploy SOL size wasn't tracked.
    const entryUsd = valSafe - pnlSafe;
    const solNum = Number(p.amount_sol);
    // "SOL masuk → nilai sekarang" framing (Bro money-honesty, 2026-07-11): show
    // what went IN vs what it's worth NOW. In solMode total_value_usd IS the
    // native SOL value, so both sides read in ◎; otherwise deployed-SOL → USD
    // value. Falls back to the derived cost basis when the deploy size is unknown.
    const masukStr = (Number.isFinite(solNum) && solNum > 0)
      ? `${solNum} SOL`
      : `~${cur}${entryUsd.toFixed(2)}`;
    // PnL now = total kalau ditutup = PnL harga + fee (additif, no overlap). This
    // is the realized-EQUIVALENT (fee-inclusive net), NOT bare price % — the
    // closest honest read for an open position (real exit gas still excluded).
    const totalNum = pnlSafe + feesSafe;
    const totalStr = signedAmount(totalNum);
    // % prefers the fee-inclusive net (TRUE economic return) over price-only.
    const pctSource = Number.isFinite(Number(p.pnl_pct_fee_inclusive))
      ? p.pnl_pct_fee_inclusive
      : p.pnl_pct;
    const pctStr = signedPct(pctSource);
    const pnlLine = pctStr ? `${totalStr} (${pctStr})` : totalStr;
    const age = formatAgeIndo(p.age_minutes);
    // Status emoji keyed on the fee-inclusive net (realized-equivalent), not the
    // flattering price-only %.
    const pnlEmoji = totalNum >= 0 ? "✅" : "🔴";
    const rangeWord = p.in_range ? "dalam range" : "luar range";
    return [
      `#${n}  ${p.pair}  ${pnlEmoji} ${rangeWord}`,
      `   Masuk:  ${masukStr} → skrg: ${cur}${valSafe.toFixed(2)}`,
      `   PnL:    ${pnlLine} (sblm gas keluar)`,
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

// Render the /journal message — riwayat closed trades (Lyra money-honesty fix,
// Bro 2026-07-11 "terutama journal"). Plain-text (sent via sendMessage, NOT
// HTML). Each trade LEADS with realized SOL (wallet truth) and demotes the
// price-only pnl% to a parenthetical — so a +pnl% trade that actually LOST SOL
// (slippage+gas) reads as a loss, never a fake win.
//   - marker keyed on realized SOL vs the meaningful bar (win ✅ / loss 🔴 /
//     impas ⚪) — classification comes from getTradeJournal (bar default 0.005)
//   - primary  = realized SOL (+/- 4dp); secondary = LP-PnL pct in parens
//   - close-reason (plain Indonesian via formatCloseReason) + fee income (≥$0.01)
//   - legacy/paper rows without a realized figure fall back to price-only pct,
//     clearly tagged "(harga)" so they are never mistaken for wallet truth
//   - date as "DD Mon" Indonesian short form (UTC-safe, no tz drama)
//   - kept compact for mobile: one line per trade
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
    const name = String(r.pool_name).slice(0, 12);
    const pctStr = signedPct(r.pnl_pct);
    // PRIMARY value — realized SOL (wallet truth). Legacy/paper rows without a
    // realized figure fall back to the price-only pct, tagged "(harga)".
    let valueStr;
    if (r.realized_sol != null) {
      valueStr = `${r.realized_sol >= 0 ? "+" : ""}${r.realized_sol.toFixed(4)} SOL`;
      if (pctStr) valueStr += ` (${pctStr})`;
    } else {
      valueStr = pctStr ? `${pctStr} (harga)` : "?";
    }
    const tag = r.result === "breakeven" ? " impas" : "";
    const reason = formatCloseReason(r.close_reason);
    const reasonStr = reason ? ` · ${reason}` : "";
    // Fee income shown only when meaningful ($0.01+) so micro-noise stays quiet.
    const feeStr = Number.isFinite(r.fees_earned_usd) && r.fees_earned_usd >= 0.01
      ? ` · fee +${cur}${r.fees_earned_usd.toFixed(1)}`
      : "";
    const src = r.source === "paper" ? " ·paper" : "";
    return `${date} · ${name} ${emoji(r.result)} ${valueStr}${tag}${reasonStr}${feeStr}${src}`;
  });

  // Summary header — honest net (SOL bersih when known, plus $) + win-rate + count.
  const netSolStr = summary.net_sol != null
    ? `${summary.net_sol >= 0 ? "+" : ""}${summary.net_sol} SOL`
    : null;
  const netUsdStr = `${summary.net_usd >= 0 ? "+" : "-"}${cur}${Math.abs(summary.net_usd).toFixed(2)}`;
  const netStr = netSolStr ? `${netSolStr} (~${netUsdStr})` : netUsdStr;
  const header = `Net bersih: ${netStr} · Menang ${summary.win_rate_pct}% · ${summary.total_trades} trade`;

  return [
    `📒 Riwayat Trade (${rows.length} terakhir)`,
    header,
    `menang = SOL bersih ≥ ${summary.win_bar_sol} · angka utama = SOL nyata di wallet, (%) = harga saja`,
    "─────────",
    ...lines,
  ].join("\n");
}
