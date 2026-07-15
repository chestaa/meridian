/**
 * Tests for boss-report.js new section generators.
 * Run: node scripts/test-boss-report-sections.js
 *
 * No real Telegram calls. No file I/O — section generators take in-memory
 * mock data. Each assertion logs pass/fail; non-zero exit on any failure.
 */
import {
  buildLessonsSection,
  buildDrawdownSection,
  buildOrionRejectionsSection,
  buildScreeningSummarySection,
  plainRejectBucket,
  isDeployFailure,
  escapeHtml,
  classifySignalSource,
  buildSignalSection,
  buildBalanceSection,
  sumOpenPositionsCapital,
} from "./boss-report.js";

let pass = 0;
let fail = 0;
const failures = [];

function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}

// ── Mock data ────────────────────────────────────────────────────
const nowIso = new Date().toISOString();
const recentIso = new Date(Date.now() - 2 * 3_600_000).toISOString();
const oldIso = new Date(Date.now() - 48 * 3_600_000).toISOString();

const mockLessonsState = {
  lessons: [
    { id: 1, rule: "PREFER: high-organic tokens with bin_step=100",
      confidence: 0.88, outcome: "good", created_at: recentIso, tags: ["worked"] },
    { id: 2, rule: "AVOID: micro-cap pools with high bundle pct",
      confidence: 0.82, outcome: "bad", created_at: recentIso, tags: ["bundler"] },
    { id: 3, rule: "FAILED: low fee_tvl ratio under volume collapse",
      confidence: 0.55, outcome: "poor", created_at: oldIso, tags: ["volume_collapse"] },
    { id: 4, rule: "Manual: don't trade on weekend low liquidity",
      confidence: 0.30, outcome: "manual", created_at: oldIso, tags: ["manual"] },
  ],
  performance: [
    { source: "live",  pnl_pct: 4.2,  recorded_at: recentIso },
    { source: "paper", pnl_pct: -3.0, recorded_at: recentIso },
    { source: "paper", pnl_pct: 8.5,  recorded_at: recentIso },
    { source: "paper", pnl_pct: -7.0, recorded_at: oldIso },
  ],
};

const mockUserConfig = {
  minOrganic: 65,                // evolved from 60
  minFeeActiveTvlRatio: 0.05,    // default
  _lastEvolved: "2026-05-15T10:30:00Z",
  _positionsAtEvolution: 1,      // 4 perf records − 1 = 3 evaluated since
};

const mockTrades = [
  {
    id: "p1", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "TKN-SOL", amount_sol: 0.1,
    max_drawdown_pct: 12.5, min_pnl_pct: -10, peak_pnl_pct: 2,
    final_pnl_pct: -3.0, close_action: "DRAWDOWN_RECOVERY",
  },
  {
    id: "p2", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "ABC-SOL", amount_sol: 0.1,
    max_drawdown_pct: 22.0, min_pnl_pct: -20, peak_pnl_pct: 0,
    final_pnl_pct: -20.0, close_action: "STOP_LOSS",
  },
  {
    id: "p3", status: "closed", opened_at: oldIso, closed_at: recentIso,
    pool_name: "XYZ-SOL", amount_sol: 0.1,
    max_drawdown_pct: 5.0, min_pnl_pct: -2, peak_pnl_pct: 6,
    final_pnl_pct: 5.5, close_action: "TAKE_PROFIT",
  },
  {
    // Older than 24h — should be excluded
    id: "p4", status: "closed", opened_at: oldIso, closed_at: oldIso,
    pool_name: "OLD-SOL", amount_sol: 0.1,
    max_drawdown_pct: 30.0, close_action: "STOP_LOSS",
  },
  {
    // Still open — should be ignored
    id: "p5", status: "open", opened_at: recentIso,
    pool_name: "OPEN-SOL", amount_sol: 0.1, max_drawdown_pct: 4.0,
  },
];

const mockSignalEntries = [
  { ts: recentIso, llm: { decision: "skip", reason: "Micro-cap with wash trading suggested by 5m vol/mcap ratio" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Micro-cap with wash trading suggested by 5m vol/mcap ratio" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Holder concentration above 60% top10" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "skip", reason: "Bundle pct exceeds threshold (>20%)" } },
  { ts: recentIso, llm: { decision: "pass", reason: "passed" } }, // not a skip
  { ts: oldIso,    llm: { decision: "skip", reason: "Old skip outside 24h window" } }, // excluded
];

// ── Test: buildLessonsSection ───────────────────────────────────
console.log("\n[buildLessonsSection]");
{
  const text = buildLessonsSection(mockLessonsState, mockUserConfig);
  assert("returns non-null", text != null);
  assert("uses plain header 'Apa yang Dipelajari Bot'", text.includes("Apa yang Dipelajari Bot"));
  assert("states live close count (1) in plain language", text.includes("<b>1</b> posisi sungguhan"));
  assert("mentions tightened standards (minOrganic evolved)", text.includes("memperketat"));
  assert("includes last evolution timestamp", text.includes("2026-05-15"));
  assert("clarifies date = last AUTO standard change (not last activity)", text.includes("Standar terakhir berubah otomatis"));
  assert("shows positions evaluated since (4−1=3)", text.includes("3 posisi dievaluasi sejak itu"));
  assert("reassures stale date is normal, not a dead engine", /normal, bukan berhenti/.test(text));

  // No _positionsAtEvolution → falls back to non-counted reassurance, never errors
  const noCount = buildLessonsSection(mockLessonsState, { ...mockUserConfig, _positionsAtEvolution: undefined });
  assert("graceful when _positionsAtEvolution missing", noCount.includes("Standar terakhir berubah otomatis") && noCount.includes("tetap evaluasi"));

  assert("NO raw bin_step jargon", !/bin_step/.test(text));
  assert("NO raw fee_tvl_ratio jargon", !/fee_tvl_ratio/.test(text));
  assert("NO raw volatility= jargon", !/volatility=/.test(text));
  assert("renders plain insight sentence", /cenderung (menguntungkan|merugi)/.test(text));

  // Graceful degradation
  const empty = buildLessonsSection(null, {});
  assert("returns null on missing state", empty === null);
}

// ── Test: buildDrawdownSection ──────────────────────────────────
console.log("\n[buildDrawdownSection]");
{
  const text = buildDrawdownSection(mockTrades);
  assert("returns non-null", text != null);
  assert("contains header 'Drawdown Stats'", text.includes("Drawdown Stats"));
  assert("counts 3 closed (24h, excludes old + open)", text.includes("Closed paper: <b>3</b>"));
  assert("shows DD-Rec exit count = 1", /DD-Rec 1/.test(text));
  assert("shows SL exit count = 1", /SL 1/.test(text));
  assert("shows TP exit count = 1", /TP 1/.test(text));
  assert("worst drawdown is 22.00%", text.includes("22.00%"));

  const emptyText = buildDrawdownSection([]);
  assert("returns null on empty trades", emptyText === null);
}

// ── Test: buildOrionRejectionsSection ───────────────────────────
console.log("\n[buildOrionRejectionsSection]");
{
  const text = buildOrionRejectionsSection(mockSignalEntries);
  assert("returns non-null", text != null);
  assert("contains header 'Orion rejected'", text.includes("Orion rejected"));
  assert("total skip count is 6 (24h only)", text.includes("6 signals"));
  assert("top bucket: bundle pct (3 occurrences)", /3×.*Bundle pct/.test(text));
  assert("includes Micro-cap reason (2×)", /2×.*Micro-cap/.test(text));
  assert("excludes old skips (outside 24h)", !text.includes("Old skip"));
  assert("excludes pass decisions", !text.includes("passed"));

  const emptyText = buildOrionRejectionsSection([]);
  assert("returns null on empty signal entries", emptyText === null);
}

// ── Test: HTML-escape in the send path (BUG fix 2026-07-11) ─────
// parse_mode HTML 400s on raw <, >, & in interpolated free text. A reject reason
// like "mcap < $200k & bot flagged" MUST render escaped or the whole report drops.
console.log("\n[escapeHtml + HTML-safe Orion section]");
{
  assert("escapeHtml turns < into &lt;", escapeHtml("mcap < $200k") === "mcap &lt; $200k");
  assert("escapeHtml turns > into &gt;", escapeHtml("5M > cap") === "5M &gt; cap");
  assert("escapeHtml turns & into &amp; (order-safe)", escapeHtml("rug & bot") === "rug &amp; bot");
  assert("escapeHtml passes plain $200 unchanged", escapeHtml("net $200 profit") === "net $200 profit");
  assert("escapeHtml handles a <b>-like raw tag", escapeHtml("<b>fake</b>") === "&lt;b&gt;fake&lt;/b&gt;");
  assert("escapeHtml null → empty string", escapeHtml(null) === "");

  // End-to-end: a raw reason with <, &, $200, and a <b>-like tag flows through
  // buildOrionRejectionsSection HTML-safe (no raw '<'/'&' survives except our tags).
  const rawReasonEntries = [
    { ts: recentIso, llm: { decision: "skip", reason: "mcap < $200k & top10 > 60% <b>rug</b>" } },
    { ts: recentIso, llm: { decision: "skip", reason: "mcap < $200k & top10 > 60% <b>rug</b>" } },
  ];
  const htmlText = buildOrionRejectionsSection(rawReasonEntries);
  assert("raw reason escaped: contains &lt; not literal '< $200'", htmlText.includes("&lt; $200k") && !htmlText.includes("< $200k"));
  assert("raw reason escaped: & became &amp;", htmlText.includes("&amp; top10"));
  assert("raw reason escaped: injected <b> tag neutralised", htmlText.includes("&lt;b&gt;rug&lt;/b&gt;"));
  assert("our authored <b> header tag preserved", htmlText.includes("<b>Orion rejected"));
  // The ONLY '<' followed by 'b>' should be our own tags, never the payload's.
  assert("no unescaped payload tag leaks", !/<b>rug<\/b>/.test(htmlText));
}

// ── Test: buildScreeningSummarySection ──────────────────────────
console.log("\n[buildScreeningSummarySection]");
{
  const TODAY = new Date().toISOString().slice(0, 10);
  const t = (h, m, s = 0) => `${TODAY}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.000Z`;

  // Two screening cycles today (14:25 and 15:09 — >90s apart), 3 candidates each.
  const verdictRows = [
    { ts: t(14,25,1), path: "native", verdict: "skip",  reason: "low volatility and bots high" },
    { ts: t(14,25,2), path: "native", verdict: "enter", reason: "good fee/tvl and smart wallets" },
    { ts: t(14,25,3), path: "native", verdict: "skip",  reason: "organic too low" },
    { ts: t(15,9,46), path: "native", verdict: "skip",  reason: "low volatility and bots high" },
    { ts: t(15,9,47), path: "native", verdict: "skip",  reason: "mcap out of target band" },
    { ts: t(15,9,48), path: "native", verdict: "watch", reason: "organic borderline, wait" },
    // A row from a DIFFERENT day — must be excluded.
    { ts: "2020-01-01T00:00:00.000Z", path: "native", verdict: "skip", reason: "old" },
  ];

  const decisions = [
    // Category 1 — deploy success.
    { ts: t(14,25,5), type: "deploy",    actor: "SCREENER", summary: "Relay deployed 0.5 SOL" },
    // Category 2 — gagal deploy (attempted, blocked by 429).
    { ts: t(15,9,50), type: "no_deploy", actor: "SCREENER", summary: "Deploy attempt did not succeed", reason: "snapshot_verify_failed 429 rate-limit" },
    // Category 3 — ga di-deploy (judge skip).
    { ts: t(16,0,0),  type: "no_deploy", actor: "SCREENER", summary: "LLM chose no deploy", reason: "organic too low across candidates" },
    // Category 4 — ga ada kandidat.
    { ts: t(17,0,0),  type: "no_deploy", actor: "SCREENER", summary: "No candidates available", reason: "All candidates filtered before deploy" },
    // Different day — excluded.
    { ts: "2020-01-01T00:00:00.000Z", type: "deploy", summary: "old deploy" },
  ];

  const text = buildScreeningSummarySection(verdictRows, decisions, TODAY);
  assert("returns non-null", text != null);
  assert("has header 'Ringkasan Screening Harian'", text.includes("Ringkasan Screening Harian"));
  assert("counts 2 screening cycles (90s clustering)", /Total screening: <b>2x<\/b>/.test(text));
  assert("counts 6 candidates judged (excludes other-day row)", /Lolos ke penilai \(judge\): <b>6<\/b>/.test(text));

  // ── 3 categories clearly DIFFERENTIATED ──
  assert("CAT1 deploy berhasil = 1", /Deploy berhasil: <b>1<\/b>/.test(text));
  assert("CAT2 gagal deploy distinguished (1x, 429)", /Gagal deploy: <b>1x<\/b>/.test(text) && /rate-limit/.test(text));
  assert("CAT3 ga di-deploy distinguished (judge skip)", /Ga di-deploy: <b>1x<\/b>/.test(text) && /pool kurang bagus/.test(text));
  assert("CAT4 ga ada kandidat distinguished", /Ga ada kandidat lolos filter: <b>1x<\/b>/.test(text));

  // ── Reject reasons aggregated + plain language ──
  assert("lists top reject reasons", text.includes("Alasan paling sering pool ditolak"));
  assert("aggregates 'pergerakan harga' bucket (2 low-vol rows)", /Pergerakan harga/.test(text));
  assert("shows reject % figure", /\d+%/.test(text));

  // ── Plain language: NO raw jargon leaks into output ──
  assert("NO raw 'organic' jargon", !/organic/i.test(text) || /organik/i.test(text));
  assert("NO raw 'mcap' jargon in output", !/mcap/i.test(text));
  assert("NO raw 'fee_tvl' / 'fee/tvl' jargon", !/fee.?tvl/i.test(text));
  assert("NO raw 'volatility' jargon", !/volatility/i.test(text));
  assert("NO raw 'snapshot_verify' token leaked", !/snapshot_verify/.test(text));

  // ── Graceful when data empty (anti-fabrication) ──
  const empty = buildScreeningSummarySection([], [], TODAY);
  assert("graceful empty: honest 'data mulai terkumpul' message", /mulai terkumpul/.test(empty));
  assert("graceful empty: does NOT fabricate cycle numbers", !/Total screening: <b>\d/.test(empty));

  // ── Verdict-log present but decision-log empty: still reports judged + reasons ──
  const noDecisions = buildScreeningSummarySection(verdictRows, [], TODAY);
  assert("verdict-only: still counts candidates judged", /Lolos ke penilai \(judge\): <b>6<\/b>/.test(noDecisions));
  assert("verdict-only: deploy berhasil falls back to 0", /Deploy berhasil: <b>0<\/b>/.test(noDecisions));
  assert("verdict-only: ga di-deploy falls back to per-candidate count", /Ga di-deploy:/.test(noDecisions));
}

// ── Test: plainRejectBucket (pure mapper) ───────────────────────
console.log("\n[plainRejectBucket]");
{
  assert("organic → organik bucket", plainRejectBucket("organic too low") === "Aktivitas organik rendah");
  assert("mcap → ukuran pool bucket", /Ukuran pool/.test(plainRejectBucket("mcap out of target band")));
  assert("volatility → pergerakan harga", /Pergerakan harga/.test(plainRejectBucket("low volatility")));
  assert("bot → bot/bundler bucket", /bot\/bundler/.test(plainRejectBucket("bot holders 40% high")));
  assert("rug/mint → keamanan bucket", /keamanan/.test(plainRejectBucket("mint authority not renounced")));
  assert("unknown → 'Alasan lain'", plainRejectBucket("something totally novel xyz") === "Alasan lain");
  assert("empty → 'Alasan lain'", plainRejectBucket("") === "Alasan lain");
  assert("null-safe", plainRejectBucket(null) === "Alasan lain");
}

// ── Test: isDeployFailure (category 2 vs 3 splitter) ────────────
console.log("\n[isDeployFailure]");
{
  assert("429 = deploy failure", isDeployFailure({ reason: "429 rate-limit" }) === true);
  assert("snapshot_verify = deploy failure", isDeployFailure({ reason: "snapshot_verify_failed" }) === true);
  assert("'Deploy attempt did not succeed' summary = failure", isDeployFailure({ summary: "Deploy attempt did not succeed" }) === true);
  assert("judge 'LLM chose no deploy' = NOT a deploy failure", isDeployFailure({ summary: "LLM chose no deploy", reason: "organic too low" }) === false);
  assert("no candidate = NOT a deploy failure", isDeployFailure({ summary: "No candidates available" }) === false);
}

// ── Test: classifySignalSource (origin bucketing) ───────────────
// Filenames below are REAL patterns observed on the VPS 2026-07-11 signal dirs.
console.log("\n[classifySignalSource]");
{
  // auto-screener: signal-runner prepends one ts, saveToInbox prepends another → 2 ts groups
  assert("2-ts screener → screener", classifySignalSource("1783781805072-1783781770832-screener-HAALAND.txt") === "screener");
  assert("2-ts screener-ok → screener", classifySignalSource("1783778182076-1783778160967-screener-ok.txt") === "screener");
  // discord-listener: channel-named files (dead since 2026-05-16)
  assert("2-ts meridian-discussion → discord", classifySignalSource("1778914294516-1778849359-meridian-discussion.txt") === "discord");
  assert("2-ts agentmeridian → discord", classifySignalSource("1778853412585-1774802787-agentmeridian.txt") === "discord");
  // manual/test drops: single ts prefix
  assert("1-ts hanta-service-test → manual", classifySignalSource("1778638695950-hanta-service-test.txt") === "manual");
  assert("1-ts hanta-clean → manual", classifySignalSource("1778638094114-hanta-clean.txt") === "manual");
  assert("test prefix → manual", classifySignalSource("1778638000000-test-foo.txt") === "manual");
  // edge cases
  assert("no ts prefix screener → screener", classifySignalSource("screener-ABC.txt") === "screener");
  assert(".md ext handled", classifySignalSource("1778914294516-meridian-discussion.md") === "discord");
  assert("empty → other", classifySignalSource("") === "other");
  assert("null-safe → other", classifySignalSource(null) === "other");
  assert("only-timestamps → other", classifySignalSource("1783781805072-.txt") === "other");
}

// ── Test: buildSignalSection (honest processed+rejected+inbox counting) ──
console.log("\n[buildSignalSection]");
{
  // Real VPS distribution 2026-07-11: processed 685 (683 screener + 2 discord),
  // rejected 394 (371 screener + 19 discord + 4 manual), inbox 0.
  const processed = { screener: 683, discord: 2, manual: 0, other: 0, total: 685 };
  const rejected  = { screener: 371, discord: 19, manual: 4, other: 0, total: 394 };
  const inbox     = { screener: 0, discord: 0, manual: 0, other: 0, total: 0 };
  const out = buildSignalSection(processed, rejected, inbox);
  assert("shows PASSED count (was the 0-passed bug)", out.includes("Lolos filter: <b>685</b>"));
  assert("shows REJECTED count", out.includes("Ditolak filter: <b>394</b>"));
  assert("shows WAITING 0", out.includes("Menunggu: <b>0</b>") || out.includes("Menunggu diproses: <b>0</b>"));
  assert("per-source split on passed", out.includes("screening 683") && out.includes("Discord 2"));
  assert("per-source split on rejected", out.includes("screening 371") && out.includes("Discord 19"));
  assert("no longer titled bare 'Sinyal Discord'", !/📡 Sinyal Discord\b/.test(out));
  assert("clarifies Discord merges into screening", /merge screening|ranked-digest/.test(out));
  // null-safety (graceful degradation)
  const empty = buildSignalSection(null, null, null);
  assert("null args → still renders, 0/0/0", empty.includes("<b>0</b>"));
  // inbox waiting path
  const withWaiting = buildSignalSection(processed, rejected, { screener: 3, discord: 0, manual: 0, other: 0, total: 3 });
  assert("waiting>0 renders 'Menunggu diproses'", withWaiting.includes("Menunggu diproses: <b>3</b>"));
}

// ── Test: sumOpenPositionsCapital (recorded principal, sync, no RPC) ──
console.log("\n[sumOpenPositionsCapital]");
{
  // Single-side positions sum amount_sol; two-sided uses notional_sol.
  const state = {
    positions: {
      a: { amount_sol: 0.1, closed: false },
      b: { amount_sol: 0.13, closed: false },
      // two-sided: notional_sol (0.2) preferred over amount_sol y-leg (0.05)
      c: { amount_sol: 0.05, two_sided: true, two_sided_live: { notional_sol: 0.2 }, closed: false },
      // closed → excluded
      d: { amount_sol: 5.0, closed: true },
      // closed_at set (no `closed` flag) → excluded
      e: { amount_sol: 5.0, closed_at: "2026-07-14T00:00:00Z" },
    },
  };
  assert("sums open single-side + two-sided notional (0.1+0.13+0.2=0.43)", sumOpenPositionsCapital(state) === 0.43);

  assert("null state → null (unreadable, never fabricate)", sumOpenPositionsCapital(null) === null);
  assert("non-object state → null", sumOpenPositionsCapital("nope") === null);
  assert("readable state, no positions map → 0 (flat, not null)", sumOpenPositionsCapital({}) === 0);
  assert("all-closed positions → 0", sumOpenPositionsCapital({ positions: { d: { amount_sol: 1, closed: true } } }) === 0);

  // strictNumeric fail-safe: a null/garbage amount contributes 0, never fabricates.
  const junk = { positions: {
    a: { amount_sol: null, closed: false },
    b: { amount_sol: "not-a-number", closed: false },
    c: { amount_sol: 0.15, closed: false },
  } };
  assert("null/garbage amount coerces to 0 (no fabrication), only real 0.15 counts", sumOpenPositionsCapital(junk) === 0.15);

  // two-sided with stranded notional → falls back to amount_sol y-leg (conservative undercount)
  const stranded = { positions: { c: { amount_sol: 0.05, two_sided: true, two_sided_live: { notional_sol: null }, closed: false } } };
  assert("two-sided stranded notional → fallback amount_sol (0.05)", sumOpenPositionsCapital(stranded) === 0.05);
}

// ── Test: buildBalanceSection (phantom-drain DISPLAY fix) ───────────
// The bug: a deployed-capital dip in LIQUID sol read as a scary drain to Bro.
// Fix: show TOTAL account value = liquid + deployed, prominent, so intact-but-
// working capital can't read as a drop.
console.log("\n[buildBalanceSection]");
{
  const PUB = "AbCdEfGh1234567890zzzzWXYZ";

  // ── Scenario 1: capital deployed (liquid 0.43, 0.23 in a position) ──
  const deployed = buildBalanceSection(0.43, 150, PUB, 0.23);
  assert("deployed: renders TOTAL 0.6600 (0.43+0.23), the intact figure", deployed.includes("0.6600 SOL total"));
  assert("deployed: shows breakdown likuid 0.4300", deployed.includes("likuid 0.4300"));
  assert("deployed: shows breakdown di posisi 0.2300", deployed.includes("di posisi 0.2300"));
  assert("deployed: total appears BEFORE liquid (total is prominent)", deployed.indexOf("total") < deployed.indexOf("likuid"));
  assert("deployed: NOT a bare headline 0.43 (no '0.4300 SOL</code>' as the total)", !deployed.includes("0.4300 SOL</code>"));
  assert("deployed: USD is computed on the TOTAL (0.66×150=99.00)", deployed.includes("$99.00"));

  // ── Scenario 2: flat wallet (0 open positions) → clean render ──
  const flat = buildBalanceSection(0.43, 150, PUB, 0);
  assert("flat: renders liquid cleanly", flat.includes("0.4300 SOL</code>"));
  assert("flat: NO 'di posisi 0' clutter", !flat.includes("di posisi"));
  assert("flat: NO misleading 'total' label when nothing deployed", !flat.includes("SOL total"));
  assert("flat: USD on the liquid figure (0.43×150=64.50)", flat.includes("$64.50"));

  // ── Scenario 3: deployed unreadable (state.json parse fail) → honest note ──
  const unreadable = buildBalanceSection(0.43, 150, PUB, null);
  assert("unreadable: shows liquid figure", unreadable.includes("0.4300 SOL"));
  assert("unreadable: honest open-positions note", /posisi terbuka|cek \/positions/.test(unreadable));
  assert("unreadable: does NOT fabricate a total", !unreadable.includes("SOL total"));

  // ── Edge: liquid unreadable → 'tidak terbaca', no crash ──
  assert("liquid null → 'tidak terbaca'", buildBalanceSection(null, 150, PUB, 0.23).includes("tidak terbaca"));
  assert("liquid NaN → 'tidak terbaca' (no NaN string leak)", buildBalanceSection(NaN, 150, PUB, 0.23).includes("tidak terbaca"));

  // ── Edge: USD price unavailable → honest USD note, still decomposes SOL ──
  const noUsd = buildBalanceSection(0.43, null, PUB, 0.23);
  assert("no USD price: still shows total SOL", noUsd.includes("0.6600 SOL total"));
  assert("no USD price: 'nilai USD tidak tersedia' (never hardcoded)", noUsd.includes("nilai USD tidak tersedia"));

  // ── Real state.json shape end-to-end (sumOpenPositionsCapital → buildBalanceSection) ──
  const realState = {
    positions: {
      POS1: { amount_sol: 0.05, two_sided: true, two_sided_live: { notional_sol: 0.1 }, closed: false },
      be1:  { amount_sol: 0.05, closed: false },
    },
  };
  const cap = sumOpenPositionsCapital(realState); // 0.1 + 0.05 = 0.15
  const e2e = buildBalanceSection(0.3, 150, PUB, cap);
  assert("e2e: state→capital 0.15 flows into total 0.4500", cap === 0.15 && e2e.includes("0.4500 SOL total"));
  assert("e2e: breakdown di posisi 0.1500", e2e.includes("di posisi 0.1500"));
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${pass} passed · ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
