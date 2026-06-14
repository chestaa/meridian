---
name: deploy-2026-06-01-intel-ab-bossreport
description: commit 7eb0ffe; intel a (fee-gen symmetry score-bonus flag-off) + b (volume-regime strategy flag-off Vega VETO) + boss-report display fixes (live USD price, live-only win rate, plain-language lessons); flags confirmed false, tests 17+31+34+26 PASS, meridian LIVE
metadata:
  type: project
---

Deploy 2026-06-01: three workstreams, all flag-OFF or display-only. Commit `7eb0ffe`, pushed main, VPS auto-pulled clean.

**Workstreams:**
- intel (a) fee-gen-token symmetry bonus (Cassiopeia): `scoreCandidate` add-only bonus for ~50/50 buy/sell flow pools, triangular weighting. Flag `config.screening.feeGenSymmetryBonusEnabled` — **stays false** (opt-in). Never gates, only adds score. Test: scripts/test-feegen-symmetry.js (17).
- intel (b) volume-regime strategy: flag `config.strategy.volumeRegimeEnabled` — **stays false** (Vega VETO pending live validation). Test: scripts/test-volume-regime.js (31).
- boss-report display fixes: live SOL USD price (not hardcoded 135/$118), live-only win rate from lessons.performance source!==paper windowed 30d (NOT polluted 14W/33L paper batch), plain-Indonesian lessons (no bin_step/volatility/fee_tvl_ratio jargon). Tests: test-briefing-executive.js (34) + test-boss-report-sections.js (26).

**Why:** a/b are intel-driven enhancements gated until Vega lifts VETO. boss-report fix is display-honesty: old report showed stale/fabricated numbers to Bro.

**How to apply:** both flags MUST stay false until explicit opt-in / Vega VETO lift. boss-report builders are pure exported fns (buildBalanceSection, buildTradeSection, buildLessonsSection, lessonToPlain) — render read-only via node --input-type=module import, do NOT sed-edit source on prod (classifier blocks remote-write).

**Verify results (live render @ SOL $82):** wallet 0.8797 SOL ~$72.20 (live, correct); live win rate 65% (11W/6L 30d, 17 open positions), paper 14/33 shown separately labelled practice; lessons plain language confirmed. meridian restarted active Mode LIVE model deepseek/deepseek-v4-flash, no errors. Snapshot oneshot exit 0.

Note: boss-report render workaround — the script only sends to Telegram (no stdout dump, no env switch). To inspect rendered output, import exported builders with live state files + live RPC balance + live Jup/Coingecko price. See [[deploy-2026-05-31-encrypted-env]] for prior deploy context.
