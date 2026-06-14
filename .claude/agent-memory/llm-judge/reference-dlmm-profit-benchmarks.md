---
name: reference-dlmm-profit-benchmarks
description: External DLMM LP profit benchmarks (fee/TVL "KING" line, bin-step bands, distribution choice) + sources, gathered for Orion judge-prompt calibration
metadata:
  type: reference
---

DLMM LP profit-quality benchmarks from exhaustive web/GitHub riset (2026-06-13), for
calibrating Orion's judge prompt toward PASS-ing only MEANINGFUL-profit pools.

# Concrete numbers (sourced)
- **Fee/TVL (24h) is the KING metric.** Community/yunus: "below ~20% doesn't cover IL."
  Our `liveOverrides.minFeeActiveTvlRatio = 0.10` is a deliberate ANTI-DORMANCY floor
  (0.20 hard floor = permanent dormancy per our own 0-deploy-day history). Captured as
  a SCORE BONUS ramp 0.10→0.20 (`feeTvlHighBonus`), not a gate. See CLAUDE.md.
- **Bin-step bands (Meteora docs + fciaf420/meteora-dlmm-lp-skill SKILL.md):**
  stablecoin 1-5bps, blue-chip 10-25, mid-cap volatile 25-80, **memecoin 80-200+bps**.
  Our `minBinStep 80 / maxBinStep 125` sits correctly in the memecoin zone.
- **Distribution choice (Meteora docs strategies-and-use-cases):** Curve = stable/calm
  (high cap-efficiency, high OOR risk). Bid-Ask = volatile + DCA. Spot-Concentrated 1-3
  bins (max concentration, highest OOR risk), Spot-Spread 20-30 bins (balance),
  Spot-Wide ~50 bins (low rebalance, "lower fee capture per dollar"). We use bid_ask +
  35-69 bins below — correct for volatile single-side-SOL memecoin LP.
- **Fee formula (docs/formulas):** base = baseFactor×binStep×10×10^powerFactor;
  variable = ⌈varCtrl×(volAccum×binStep)²/1e11⌉; total capped 10%. Bigger binStep →
  bigger base fee per crossing. Narrow range = more fee/$ but goes inactive faster.
- **No published APR/$ promises** — fciaf420 skill explicitly REFUSES APR targets
  ("depends on volume through YOUR bins"). So profit-quality must be judged on
  fee/TVL + volume/TVL + range-fit, not an absolute APR.

# Sources
- docs.meteora.ag/core-products/dlmm/{what-is-dlmm, strategies-and-use-cases, formulas, dynamic-positions}.md
- github fciaf420/meteora-dlmm-lp-skill (SKILL.md), GeekLad/meteora-profit-analysis (80★, tooling not strategy)

See [[reference-meridian-llm-pipelines]] for where Orion's judge sits.
