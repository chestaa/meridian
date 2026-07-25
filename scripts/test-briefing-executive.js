/**
 * Executive-language + bug-fix tests for the morning report (boss-report.js).
 * Run: node scripts/test-briefing-executive.js
 *
 * Covers:
 *   BUG 1 — wallet USD uses LIVE price (no hardcoded $135), null = "unavailable"
 *   BUG 2 — win-rate is LIVE recent only, paper sim shown separately/labelled
 *   REQ 3 — lessons render plain Indonesian, no bin_step/volatility/fee_tvl jargon
 *
 * Pure functions, in-memory mocks, no I/O, no Telegram. Non-zero exit on failure.
 */
import {
  buildBalanceSection,
  buildTradeSection,
  buildLessonsSection,
  lessonToPlain,
} from "./boss-report.js";

let pass = 0, fail = 0;
const failures = [];
function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}

const recentIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
const oldIso = new Date(Date.now() - 20 * 86_400_000).toISOString(); // 20d ago (in 30d window)
const ancientIso = new Date(Date.now() - 200 * 86_400_000).toISOString(); // pre-window

// ── BUG 1: wallet USD uses live price ───────────────────────────
console.log("\n[BUG 1: wallet USD live price]");
{
  const live = buildBalanceSection(0.8797, 81, "ABCDEFGH1234567890XYZ");
  assert("uses live price not hardcoded 135", !live.includes("118.75"));
  assert("computes USD from live price (~$71.26 @ $81)", live.includes("$71.26"));
  assert("shows the live SOL price for transparency", live.includes("@ $81"));

  const noPrice = buildBalanceSection(0.8797, null, "ABCDEFGH1234567890XYZ");
  assert("null price → 'tidak tersedia' (never wrong number)", noPrice.includes("tidak tersedia"));
  assert("null price → still shows SOL balance", noPrice.includes("0.8797 SOL"));
  assert("null price → no fabricated $ figure", !/~\$\d/.test(noPrice));

  const zeroPrice = buildBalanceSection(1.0, 0, "x");
  assert("zero/invalid price treated as unavailable", zeroPrice.includes("tidak tersedia"));

  const noBal = buildBalanceSection(null, 81, "x");
  assert("null balance → 'tidak terbaca'", noBal.includes("tidak terbaca"));
}

// ── BUG 2: win-rate live recent, paper separated ────────────────
console.log("\n[BUG 2: honest live win-rate]");
{
  // Live: 3 recent (2W/1L), 1 ancient win (outside 30d window).
  const livePerf = [
    { source: "live", pnl_usd: 5,  pnl_pct: 8.0,  recorded_at: recentIso },
    { source: "live", pnl_usd: 3,  pnl_pct: 4.0,  recorded_at: oldIso },
    { source: "live", pnl_usd: -2, pnl_pct: -3.0, recorded_at: oldIso },
    { source: "live", pnl_usd: 9,  pnl_pct: 12.0, recorded_at: ancientIso }, // excluded
    { source: "paper", pnl_usd: -1, pnl_pct: -5,  recorded_at: recentIso },  // not counted in live
  ];
  // Polluted paper batch: 14W/33L style (mostly losers) — must NOT enter headline.
  const paperTrades = [
    ...Array.from({ length: 14 }, () => ({ closed_at: ancientIso, final_pnl_pct: 5 })),
    ...Array.from({ length: 33 }, () => ({ closed_at: ancientIso, final_pnl_pct: -10 })),
  ];

  const text = buildTradeSection(livePerf, paperTrades, 2, 30);
  assert("headline is live money, not sim", text.includes("uang sungguhan"));
  assert("live recent win-rate = 67% (2 of 3)", text.includes("<b>67%</b>"));
  assert("live counts 2 wins / 1 loss in 30d", text.includes("Menang: 2") && text.includes("Kalah: 1"));
  assert("excludes ancient live close from window", text.includes("dari 3 posisi"));
  // The polluted 33 must NOT appear in the headline win-rate lines — only in
  // the clearly-labelled practice line below.
  const headline = text.split("Latihan simulasi")[0];
  assert("does NOT surface polluted 14W/33L in headline", !headline.includes("33"));
  assert("paper sim shown SEPARATELY and labelled practice", /Latihan simulasi/.test(text));
  assert("paper line is honest about losses (14/33)", text.includes("14 menang / 33 kalah"));
  assert("excludes paper from live win count", !text.includes("Menang: 16"));
  assert("shows open positions from state", text.includes("aktif sekarang: <b>2</b>"));

  const noLive = buildTradeSection([], paperTrades, 0, 30);
  assert("no live closes → honest 'belum ada' line", noLive.includes("Belum ada posisi sungguhan"));
}

// ── REQ 3: executive plain-language lessons ─────────────────────
console.log("\n[REQ 3: plain-language lessons]");
{
  const failLesson = {
    rule: "FAILED: ballish-SOL, strategy=spot, bin_step=100, volatility=2.9322, fee_tvl_ratio=0.0843, organic=null",
    context: "ballish-SOL, strategy=spot, bin_step=100, volatility=2.9322, fee_tvl_ratio=0.0843",
    outcome: "poor", confidence: 0.88, pnl_pct: -6.2,
  };
  const plain = lessonToPlain(failLesson);
  assert("translates FAILED lesson to plain Indonesian", /cenderung merugi/.test(plain));
  assert("explains low fee in words ('di bawah 0.1')", plain.includes("di bawah 0.1"));
  assert("describes volatility as 'sedang' (2.93)", plain.includes("sedang"));
  assert("NO bin_step jargon", !/bin_step/.test(plain));
  assert("NO fee_tvl_ratio jargon", !/fee_tvl_ratio/.test(plain));
  assert("NO raw volatility= jargon", !/volatility=/.test(plain));
  // HONESTY FIX (Lyra): the old text claimed "bot sekarang menghindari pola ini".
  // FALSE — a derived lesson only ever entered the LLM prompt; it never created a
  // filter. The claim is now REMOVED and replaced with the true enforcement state.
  assert("does NOT claim the bot avoids the pattern (false claim removed)", !plain.includes("menghindari"));
  assert("states honestly that it is only AI context, not a block",
    /bahan pertimbangan AI/.test(plain));
  assert("does NOT claim an automatic block when no gate is configured",
    !/otomatis ditolak/.test(plain));

  const goodLesson = {
    rule: 'PREFER: SPCX-SOL-type pools (volatility=1.5589) with strategy="spot" — PnL +11.57%.',
    context: "SPCX-SOL, volatility=1.5589, fee_tvl_ratio=0.1011", outcome: "good",
    confidence: 0.82, pnl_pct: 11.57,
  };
  const goodPlain = lessonToPlain(goodLesson);
  assert("PREFER lesson → 'menguntungkan'", /cenderung menguntungkan/.test(goodPlain));
  assert("good lesson does NOT claim the bot prioritises the pattern (false claim removed)",
    !goodPlain.includes("memprioritaskan"));
  assert("'tenang' volatility for vol<2", goodPlain.includes("tenang"));

  const evolved = lessonToPlain({ rule: "[AUTO-EVOLVED @ 5 positions] minFeeActiveTvlRatio=0.06 — raised floor" });
  assert("auto-evolved → plain self-tuning sentence", evolved.includes("menyesuaikan sendiri"));
  assert("auto-evolved hides raw threshold numbers", !evolved.includes("0.06"));

  assert("null lesson → null", lessonToPlain(null) === null);

  // Section-level: no jargon leaks through full render.
  const section = buildLessonsSection({
    performance: [{ source: "live", pnl_usd: 1, recorded_at: recentIso }],
    lessons: [failLesson, goodLesson],
  }, { minOrganic: 72, minFeeActiveTvlRatio: 0.06, _lastEvolved: "2026-05-30T08:00:00Z" });
  assert("section has plain header", section.includes("Apa yang Dipelajari Bot"));
  assert("section: zero jargon (bin_step/volatility=/fee_tvl_ratio)",
    !/bin_step|volatility=|fee_tvl_ratio/.test(section));
  assert("section states current standard is stricter than base (fact, no agency claim)",
    section.includes("lebih ketat dari setelan dasar"));
  assert("section does NOT claim the bot tightened standards by itself",
    !/memperketat standar pemilihan pool sendiri/.test(section));
  assert("section states propose-only mode plainly",
    /TIDAK mengubah standar sendiri/.test(section));
}

// ── REQ 4 (Lyra): dimension-aware bucket lessons + propose-only honesty ──────
console.log("\n[REQ 4: dimension-aware bucket lessons]");
{
  const entryBucket = {
    id: "bucket:entry_direction=entry_down|volatility=vol[0,2.5)",
    bucketKey: "entry_direction=entry_down|volatility=vol[0,2.5)",
    sourceType: "bucket_aggregate", outcome: "bad",
    rule: "EV-BUCKET vol[0,2.5) × entry_down — n=14, EV -0.0190 SOL/trade, net -0.2660 SOL, W1/L9/N4 (WR 7.1%), SIGNAL t=-3.2 → AVOID",
    dims: { entry_direction: "entry_down", volatility: "vol[0,2.5)" },
    dimension: "entry_direction×volatility",
    n: 14, ev_sol: -0.019, net_sol: -0.266, wins: 1, losses: 9, neutral: 4,
    verdict: "SIGNAL", material: true, micro_ev: false, confidence: 0.8,
    created_at: "2026-07-20T00:00:00Z",
  };
  const exitBucket = {
    id: "bucket:exit_class=STOP_LOSS", bucketKey: "exit_class=STOP_LOSS",
    sourceType: "bucket_aggregate", outcome: "bad",
    rule: "EV-BUCKET STOP_LOSS — n=25, EV -0.0164 SOL/trade, net -0.4108 SOL, W0/L23/N2 (WR 0%), SIGNAL t=-11.56 → AVOID",
    dims: { exit_class: "STOP_LOSS" }, dimension: "exit_class",
    n: 25, ev_sol: -0.0164, net_sol: -0.4108, wins: 0, losses: 23, neutral: 2,
    verdict: "SIGNAL", material: true, micro_ev: false, confidence: 0.8,
    created_at: "2026-07-21T00:00:00Z",
  };
  const regimeBucket = {
    id: "bucket:regime=regime_flat", bucketKey: "regime=regime_flat",
    sourceType: "bucket_aggregate", outcome: "neutral",
    rule: "EV-BUCKET regime_flat — n=63, EV -0.0012 SOL/trade, net -0.0763 SOL, NOISE t=-1.52 → WATCH (not significant yet)",
    dims: { regime: "regime_flat" }, dimension: "regime",
    n: 63, ev_sol: -0.0012, net_sol: -0.0763, wins: 4, losses: 10, neutral: 49,
    verdict: "NOISE", material: false, micro_ev: true, confidence: 0.4,
    created_at: "2026-07-22T00:00:00Z",
  };

  // (a) The OLD renderer collapsed EVERY lesson into fee+volatility words. An
  //     entry-direction finding must now be reported as an ENTRY finding.
  const entryPlain = lessonToPlain(entryBucket, { directionGateEnabled: false, minVolatility: 0 });
  assert("renders entry_direction dimension (not collapsed to fee/vol)",
    /masuk saat harga token sedang turun/i.test(entryPlain));
  assert("renders the volatility dimension too", entryPlain.includes("pergerakan harga tenang"));
  assert("carries n", entryPlain.includes("14 posisi"));
  assert("carries realized-SOL EV per position", entryPlain.includes("-0.0190 SOL per posisi"));
  assert("carries the net SOL total", entryPlain.includes("-0.2660 SOL"));
  assert("SIGNAL + material → states the pattern is consistent",
    entryPlain.includes("polanya konsisten, bukan kebetulan"));
  assert("direction gate OFF → says so honestly (no fake filter claim)",
    entryPlain.includes("direction gate OFF"));
  assert("no false 'bot menghindari' claim on bucket rows", !entryPlain.includes("menghindari"));

  const entryPlainGateOn = lessonToPlain(entryBucket, { directionGateEnabled: true });
  assert("direction gate ON → reports the real enforcement",
    entryPlainGateOn.includes("direction gate) sedang AKTIF"));

  // (b) Volatility enforcement is only claimed when the live floor really covers
  //     the whole bucket.
  const volCovered = lessonToPlain(entryBucket, { minVolatility: 3.0 });
  assert("floor above bucket ceiling → honest 'sudah otomatis ditolak'",
    volCovered.includes("otomatis ditolak") && volCovered.includes("minVolatility 3"));
  const volPartial = lessonToPlain(entryBucket, { minVolatility: 1.5 });
  assert("floor inside the bucket → says only SOME pools are filtered",
    volPartial.includes("sebagian pool di rentang ini masih lolos"));

  // (c) Exit-side patterns are NOT entry filters — must be stated.
  const exitPlain = lessonToPlain(exitBucket, {});
  assert("exit_class rendered in plain words", /ditutup kena batas rugi/i.test(exitPlain));
  assert("exit pattern honestly labelled as not-an-entry-filter",
    exitPlain.includes("bukan filter saat memilih pool"));

  // (d) NOISE/micro must not read as a rule.
  const regimePlain = lessonToPlain(regimeBucket, {});
  assert("regime dimension rendered", /pasar SOL datar/i.test(regimePlain));
  assert("NOISE verdict reported as unproven", regimePlain.includes("belum bisa dipastikan"));

  // (e) Section-level: bucket rows rank ahead of legacy prose, and the
  //     propose-only queue is surfaced as "menunggu keputusan Bro".
  const section = buildLessonsSection(
    { performance: Array.from({ length: 25 }, () => ({ source: "live", pnl_usd: -1, recorded_at: recentIso })),
      lessons: [regimeBucket, exitBucket, entryBucket, { rule: "FAILED: old prose", outcome: "bad", confidence: 0.99, context: "X, volatility=3, fee_tvl_ratio=0.5" }] },
    { minOrganic: 72, minFeeActiveTvlRatio: 0.10, directionGateEnabled: true },
    { auto_apply: false, pending: [
      { key: "minFeeActiveTvlRatio", current: 0.1, proposed: 0.12, direction: "TIGHTEN", applied: false },
      { key: "minVolatility", current: 3.0, proposed: 2.5, direction: "LOOSEN", applied: false, requires_bro_approval: true },
    ] },
  );
  const idxExit = section.toLowerCase().indexOf("ditutup kena batas rugi");
  const idxRegime = section.toLowerCase().indexOf("pasar sol datar");
  assert("section surfaces the material bucket row first (biggest money moved)",
    idxExit >= 0 && idxRegime >= 0 && idxExit < idxRegime);
  assert("section states bot does NOT change its own standards",
    section.includes("TIDAK mengubah standar sendiri"));
  assert("section lists pending proposals with counts", section.includes("Usulan menunggu keputusan"));
  assert("section renders a TIGHTEN proposal", section.includes("minFeeActiveTvlRatio</b>: 0.1 → 0.12"));
  assert("LOOSEN proposal flagged as requiring Bro + Cassiopeia",
    /minVolatility<\/b>: 3 → 2\.5 \(⚠️ LEBIH LONGGAR — wajib persetujuan Bro \+ review Cassiopeia\)/.test(section));
  assert("section keeps zero raw jargon", !/bin_step|volatility=|fee_tvl_ratio/.test(section));

  // (f) auto-apply ON is reported differently (no propose-only claim).
  const sectionAuto = buildLessonsSection(
    { performance: [{ source: "live", pnl_usd: 1, recorded_at: recentIso }], lessons: [exitBucket] },
    { learning: { evolveAutoApply: true }, _lastEvolved: "2026-07-01T00:00:00Z" },
    { auto_apply: true, pending: [] },
  );
  assert("auto-apply ON → reports that mode honestly",
    sectionAuto.includes("BOLEH mengubah standar sendiri"));
}

console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
