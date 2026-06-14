---
name: reference-profit-potential-and-win-bar
description: PIECE 1 profit-share judge factor (where + tier thresholds + anti-dormancy framing) and PIECE 2 honest realized-SOL win bar (minMeaningfulProfitSol + Lyra tiers + which files)
metadata:
  type: reference
---

Shipped 2026-06-13 (commit 588f9d8) — Bro's "transaksi tiap hari + PROFITABLE"
ask, two profitability domains.

# PIECE 1 — profit-potential judge factor (PROMPT-ONLY, no extra LLM call)
Economics handed to the judge: profit ≈ our_position / pool_TVL × pool_fees ×
time-in-range. A SAFE pool with huge TVL pays our small position a MICRO fee
share (the $0.001 trap) even at healthy fee/TVL.

- Pure helpers: `profitShareHint(positionSol, tvlUsd, solUsd)` in `agents/orion.js`
  and `signalProfitShareHint(...)` in `signal-judge.js` (decoupled local copy).
  Both compute `share% = position/TVL ×100` and a **tier**:
  micro `<0.05%` · thin `<0.2%` · healthy `>=0.2%`. (0.05% = Bro's RED line.)
- Hand the LLM the PRE-COMPUTED `{ fee_share_pct, tier }` — small models can't
  divide reliably. Native judge sizes position via `computeDeployAmount(wallet)`;
  signal judge uses the 0.05 SOL probe cap.
- **FRAMED AS A FACTOR, NEVER A GATE** (anti-pattern #8 / dormancy). Prompt
  contains explicit guard "never skip a clearly good pool solely on TVL size" —
  micro-share only DEMOTES an otherwise-borderline pool. FAIL-SAFE: missing/zero
  TVL → null hint (neutral; LLM falls back to mcap reasoning).
- DO NOT turn this into a hard reject in a future iteration — that re-creates the
  0-deploy-day dormancy we fought off on the fee/TVL floor. See
  [[reference-dlmm-profit-benchmarks]] (0.20 fee/TVL would've been a dormancy gate).

# PIECE 2 — honest realized-SOL win bar (REPORTING ONLY, no money path)
A close is a WIN only when its TRUE realized SOL delta (net of IL+slippage+gas,
from `realized_sol_delta`, NOT price-only `pnl_pct`) clears the bar. Micro-profit
below the bar = NOISE, shown as breakeven, NOT a win. Answers "$0.001 dianggap
profit".

- Config: `config.management.minMeaningfulProfitSol` (default **0.005 SOL** ~$0.75),
  reloadable via `reloadScreeningThresholds`.
- Lyra tiers (realized SOL): NOISE `<0.005` · MARGINAL `0.005-0.02` ·
  REAL `>=0.02` · MEANINGFUL `>=0.05`. LOSS `<0`, UNKNOWN when no realized figure.
- Applied in: `scripts/boss-report.js` (`profitTier`, `classifyTrade`,
  `realizedSolOf`, rewritten `buildTradeSection` — headline win-rate + net
  realized SOL + tier distribution + NOISE disclosure); `lessons.js`
  (`isMeaningfulWin`, used by `getPerformanceHistory`); `scripts/lib/snapshot-builder.js`
  (win_rate now realized-bar based — DROPPED the Trailing-TP auto-win that masked
  dust). Each falls back to LP-PnL sign only for legacy records lacking realized.
- `realized_sol_delta` is produced by `realized-sol.js` (Vega fix #1, wallet-delta
  preferred). See [[vega-realized-sol-accounting]].

# Tests
`scripts/test-profit-heuristic.js` (26 — tiers, fail-safe, anti-dormancy prompt
language, single-LLM-call proof). `scripts/test-profit-reporting-bar.js` (37 —
tier ladder, classifyTrade realized-vs-LP, honest 50%-not-75% win-rate, config
wiring).
