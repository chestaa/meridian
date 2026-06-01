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
  assert("says bot avoids the pattern", plain.includes("menghindari"));

  const goodLesson = {
    rule: 'PREFER: SPCX-SOL-type pools (volatility=1.5589) with strategy="spot" — PnL +11.57%.',
    context: "SPCX-SOL, volatility=1.5589, fee_tvl_ratio=0.1011", outcome: "good",
    confidence: 0.82, pnl_pct: 11.57,
  };
  const goodPlain = lessonToPlain(goodLesson);
  assert("PREFER lesson → 'menguntungkan'", /cenderung menguntungkan/.test(goodPlain));
  assert("good lesson → bot prioritises pattern", goodPlain.includes("memprioritaskan"));
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
  assert("section flags tightened standards plainly", section.includes("memperketat"));
}

console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
