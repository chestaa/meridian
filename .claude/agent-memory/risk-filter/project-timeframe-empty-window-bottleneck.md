---
name: timeframe-empty-window-bottleneck
description: Post-breadth 1/1031 gate-pass bottleneck was timeframe=5m EMPTY WINDOW (volume/fee/TVL=0), NOT miscalibrated quality gates — fixed 5m→1h + maxBinStep 125→200
metadata:
  type: project
---

After the broad-discovery breadth fix ([[broad-discovery-server-client-migration]]) the
bottleneck moved to the GATE: only ~1/1031 pools passed. Bro asked: which gate is
MISCALIBRATED (rejects good pools) vs PROTECTIVE (rejects real junk)? Tune the
miscalibrated only, "ga maksa" (don't force deploys / sacrifice quality).

**ROOT CAUSE (live probe `scripts/probe-reject-histogram.js`, 2026-06-13): NOT a quality
gate — a DATA-WINDOW artifact.** The discovery `timeframe` was `5m`. At 5m, 271/300 broad
pools read `volume=0` and 266/300 read `fee_active_tvl_ratio=0` — the 5m window is
structurally EMPTY (no trade in the last 5 min for the vast majority of pools). So the
dominant reject was `volume_below_min` at **59.4%**, and the fee/TVL floor compounded it.
Fee-GENERATING pools were dying on a STALE-WINDOW read (same class as the RICH-SOL
volatility miss — but volume/fee/TVL have NO refetch-rescue, unlike volatility which has
`refetchVolatilityForUnusable` + a 30m floor via `getVolatilityTimeframe`).

**Evidence per gate (counterfactual: relax ONE gate, hold all else, recount survivors):**
- At 1h, baseline raw-gate passers = 15. Relaxing organic 60→0: still 15. holders 500→200:
  still 15. fee/TVL 0.05→0: 17. **These quality gates are NOT the binding constraint — they
  are correctly calibrated/PROTECTIVE.** Loosening them unlocks ~nothing.
- The ONLY thing that moved the needle was the timeframe (5m→1h: 1→15; →24h: 22) and bin_step
  (off: 15→22 at 1h).

**Why minOrganic/minHolders/fee-TVL are PROTECTIVE not miscalibrated:** the 1h survivors all
have organic 61-78 (floor 60), holders 660-4651 (floor 500), fee/TVL 0.065-3.97 (floor 0.05),
mcap in band. The gates pass quality pools naturally once the data window is real. Loosening
would only admit junk. KEEP THEM.

**Fix applied (commit 7610145, branch feat/broad-discovery-server-client-migration):**
- `timeframe` 5m→1h (config.js default + user-config.json). 1h not 24h: preserves the
  magnitude `minVolume 500` / `minFeeActiveTvlRatio` were tuned for (24h volume/fee are far
  larger → would change threshold meaning). Volatility insulated (30m floor regardless).
- `maxBinStep` 125→200 (Orion fee-capture research): base fee scales linearly with bin_step
  (~1.6x fee/crossing at 200 vs 125); `bins_below` clamps [35,69] independent of bin_step;
  wider bin = wider price tolerance = LESS OOR. 87/1000 broad pools in the 126-200 band.
  Deploy-side safe. Most 126-200 pools still fail quality gates on merit.
- NO quality gate loosened (anti-pattern #8 respected). Both reversible via user-config.

**Result:** funnel 1→14 deployable/cycle. Enough for daily transactions, quality preserved.

**IMPORTANT for future tuning:** `user-config.json` is GITIGNORED and the VPS has its OWN
copy. A config.js default change is INERT in live until the VPS user-config.json is updated
too (Draco/Bro must sync `timeframe:"1h"` + `maxBinStep:200` there, or the `u.X ?? default`
falls back to the stale user-config value). I updated the LOCAL user-config.json; VPS needs
the same. Always check `git check-ignore user-config.json` + whether a key is set there
before assuming a config.js default takes effect.

Related: [[broad-discovery-server-client-migration]], [[fail-closed-missing-data]].
