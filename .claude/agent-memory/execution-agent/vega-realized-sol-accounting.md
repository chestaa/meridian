---
name: vega-realized-sol-accounting
description: Vega fix #1 — realized_sol_delta accounting (TRUE economic SOL vs price-only lp_pnl); where computed, LIVE vs PAPER methods
metadata:
  type: project
---

Vega fix #1 (shipped 2026-05-30): the bot reported LP-PnL (+X%, price-only) while
wallet SOL dropped — IL + close-swap slippage + gas were not in the PnL figure.
Cross-validated by the 2026-05-28 wallet reconcile (0.057 SOL gap) and flagged
the #1 trust-eroder in the Telegram community.

**Fix:** new pure module `realized-sol.js` exposes `computeLiveRealizedSolDelta`
+ `computePaperRealizedSolDelta`. Formula:
`realized_sol_delta = (sol_received_on_close + fees_claimed_sol) - (sol_deployed + gas_spent_est)`.

**Why it's accounting-only:** ADDITIVE — lp_pnl_pct (= result.pnl_pct / trade.final_pnl_pct)
is left untouched; realized_sol_delta is a SECOND figure surfaced alongside it.
No deploy/close behavior, TX, DRY_RUN, or risk constant changed. Gated by
`config.internalAgents.realizedSolAccounting` (default true).

**LIVE method (preferred = wallet-delta, estimate=false):** executor.js close
handler snapshots wallet SOL before `closePosition` and after the post-close
auto-swap; `after - before` is ground truth (IL + slippage + gas baked in). When
the snapshot pair is missing it falls back to the FORMULA path (estimate=true)
using closed-PnL API SOL figures (`allTimeWithdrawals.total.sol`,
`allTimeFees.total.sol`) + `DEFAULT_CLOSE_GAS_SOL`. dlmm.js close returns
`sol_deployed`/`sol_received`/`fees_claimed_sol` for the fallback, and persists
a formula-based realized delta into the lessons performance record.

**PAPER method (paper_sim, estimate=true):** paper has no wallet, so simulate the
exit with `DEFAULT_PAPER_EXIT_SLIPPAGE_PCT` (1%) + gas → realized strictly <= lp_pnl.

**Surfaced in:** telegram notifyClose (Realized SOL line, ⚠️est tag), digest
(executive EN + ID), snapshot-builder (closed_24h/7d_realized_sol_sum).

**Fail-safe:** missing data → null delta + estimate flag (NEVER fabricate).

Test: `scripts/test-realized-sol-delta.js` (10/10). Regression
`scripts/test-money-exit-batch.js` 29/29 still green. The test sets
`config.internalAgents.paperFeedsLessons=false` so closePaperTrade does not
pollute lessons.json/pool-memory.json.
