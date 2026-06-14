---
name: realized-pnl-source-of-truth
description: Realized PnL lives in lessons.json performance[] on VPS, NOT state.json (peak-only). source field separates real vs paper.
metadata:
  type: project
---

Realized per-trade PnL for closed positions is in `lessons.json` `performance[]` on the
VPS (`/opt/meridian`), NOT in `state.json`. `state.json` only carries `peak_pnl_pct`
(peak, not realized) and `total_fees_claimed_usd: 0` for every position (claim-on-close
nets into PnL, the field is never populated) — using it for PnL gives wrong answers.

Key fields in `performance[]`: `pnl_usd`, `pnl_pct`, `fees_earned_usd`, `fees_earned_sol`,
`close_reason`, `fee_tvl_ratio`, `amount_sol`, `source` (`"paper"` vs real — real has no
`source` or non-paper). `decision-log.json`/`signal-results.jsonl`/`paper-trades.json` are
NOT on the path locally and are sparse; lessons.json is the authoritative outcome ledger.

**Why:** Bro audits risk-reward asymmetry; must separate 33 real (DRY_RUN=false) from 14
paper records or the EV math is polluted. Paper records have fees_earned_usd=0 (paper
doesn't accrue fee USD); real records DO populate fees_earned_usd.

**How to apply:** Any PnL / W-R / EV / fee-accrual audit pulls from lessons.json
performance[], filter `source!=="paper"` for real money. See [[telegram-reporting-inventory]].
