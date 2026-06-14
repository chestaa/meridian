---
name: deploy-2026-06-11-saveinbox-fieldmap-funnel-unblocked
description: PENUTUP — Sirius f4a3d3f saveToInbox field-map fix; funnel UNBLOCKED end-to-end, Orion judge called with real cost, NO-DEPLOY by quality
metadata:
  type: project
---

Deployed Sirius **f4a3d3f** `fix(signal): saveToInbox reads condensePool shape — candidates reach Orion judge`. Merged branch `fix/saveinbox-candidate-field-mapping` → main (fast-forward 24e2ab5..f4a3d3f, pushed origin/main), restart 3x (meridian, meridian-signal-runner, meridian-auto-screener) all active NRestarts=0.

**FUNNEL FULLY UNBLOCKED END-TO-END — goal gas-to-live hop terakhir TERCAPAI.**

**Why:** chain of funnel-wall fixes (0db9228 quote-organic exempt → 24e2ab5 enrich-probe sentinel back-fill → f4a3d3f saveToInbox field-map) finally let a candidate flow screener→inbox→signal-runner→Orion judge with full data.

**How to apply:** this is the SUCCESS baseline. The fix changed auto-screener.js + signal-parser.js so saveToInbox reads condensePool shape (token mint vs pool addr). Proof points to recall:
- PRE-fix cycle 10:11: `[screener] Saved 0 candidates to inbox (skipped 1 with no token address)` — the bug.
- POST-fix cycle 10:20 (f4a3d3f): `[screener] Saved 1 candidates to inbox` + file `signals/inbox/<ts>-screener-PARQ.txt` written.
- Inbox file CORRECT: `Token: VtwGKv...parq` = real mint (NOT pool addr), `Pool: 7EXyMv5B...pDKL` = pool addr. Field mapping verified.
- signal-runner consumed (inbox emptied next 30s poll), `[ENRICH] PARQ mcap=$922,221`, pre-score 55/75 watch.
- **ORION JUDGE CALLED** (KUNCI FINAL): `LLM: WATCH (35%) | max 0 SOL`, full reason (PARQ $922k mcap above early-entry band, thin $29k TVL/$4.7k vol), `LLM cost: $0.00016970 | 7421ms`.
- Verdict NO-DEPLOY (WATCH) = quality discipline, NOT failure — funnel works, judge just declined a mediocre pool.
- No new position opened (state.json only legacy SPCX-SOL carry-over). Cost today $0.000170 / 1 call (was $0, cap $1.10). 0 err 15min.

HEAD main = f4a3d3f. See chain: [[deploy-2026-06-11-quote-organic-0db9228]], [[deploy-2026-06-11-native-enrich-quoteorganic-wall]], [[deploy-2026-06-11-crossref-fieldmap-empiris]].
