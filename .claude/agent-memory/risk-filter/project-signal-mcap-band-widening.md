---
name: signal-mcap-band-widening
description: Signal mcap band widened 5k-80k -> 50k-2M (2026-06-11, Bro opt Y); other gates UNTOUCHED; native band unchanged
metadata:
  type: project
---

Signal-mode mcap band widened **5k-80k → 50k-2M** on 2026-06-11 (Bro-authorized opt Y). Commit `a4d5bf4` on branch `fix/saveinbox-candidate-field-mapping`.

**Why:** old 80k ceiling rejected the actual quality DLMM zone — yunus SOL-USDC operates $100k-1M, PARQ $922k, Jotchua $3.6M all got rejected. Floor RAISED 5k→50k (sub-50k = degen/rug/thin zone, blind-scanner historically leaked bad picks there — a tightening). Ceiling 80k→2M covers the documented cluster (PARQ inside), capped at 2M NOT 3.6M because late-stage large-cap is native discovery's job. Old 80k<150k dead zone now CLOSED — bands overlap 150k-2M.

**Band topology (3 readers, all read config.screening.signalMinMcap/signalMaxMcap):**
- `signal-parser.js` scoreEnrichedProfile + scoreLegacyProfile: band is a **+20 SCORE component** (out-of-band → lose 20pts, often drops below 55 watch threshold = de facto choke, NOT a hard reject). Hard rejects there are separate: `>50M` (strict) and `<1k`.
- `backtest-harness.js` cassiopeiaCheck: band is a **HARD reject**.
- All 3 default fallbacks updated to 50k/2M to avoid stale-default masking.

**Why native band stays distinct (DID NOT align):** `minMcap/maxMcap` (150k-10M) unchanged. Signal floor BELOW native (50k vs 150k — alpha justifies earlier entry); signal ceiling BELOW native (2M vs 10M — single-signal bets avoid late-stage thin fee velocity). Intentional divergence, not a bug.

**How to apply:** widening mcap is purely a SIZE window — it does NOT loosen rug/bot/top10/holders/fee-TVL/organic/TVL-MC/volatility (separately keyed, stay strict per [[feedback-fail-closed-missing-data]]). Verified in tests: in-band $900k + top10 75% still hard-skips; + bundlers 45% still hard-skips. If asked to widen further toward native, push back — 2M ceiling is deliberate (Jotchua $3.6M belongs to native).

**Risk trade-off flagged to Bro (he authorized anyway):** larger/thicker pools = different fee velocity + drawdown profile than micro-cap degen.

**VPS pending (Draco):** local user-config.json + VPS still have OLD 5k/80k explicit override — must edit to 50k/2M + restart-3, else the config override masks the new defaults. Tests: `scripts/test-mcap-band-widening.js` (18 assertions).
