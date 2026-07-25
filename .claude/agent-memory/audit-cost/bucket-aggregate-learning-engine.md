---
name: bucket-aggregate-learning-engine
description: Lyra's dimension-aware bucket-aggregate learning engine (exit_class, EV buckets, propose-only thresholds) — branch feat/lyra-bucket-aggregate-learning, commit e34aff96, NOT pushed
metadata:
  type: project
---

# Bucket-aggregate learning engine (built 2026-07-25)

Branch `feat/lyra-bucket-aggregate-learning`, commit **e34aff96**, NOT pushed
(Draco ships). Answers Bro requirement #6 ("belajar dari kesalahan, jangan
mengulang, data jadi training"). Scope: `lessons.js` + `scripts/boss-report.js`
+ `cli.js`/`index.js` output honesty + `user-config.example.json` + tests. No
money/gate/DRY_RUN code touched.

**Why:** the old loop pushed ONE PROSE lesson PER TRADE → 70 lessons on the VPS,
worst duplicate group = 7 near-identical `FAILED: <pool>, volatility=…` rows,
no counts, no EV; `entry_features` was WRITE-ONLY (nothing read it); 76% of
closes were dropped as "neutral"; `evolveThresholds` AUTO-APPLIED from an
all-history min/max comparator (self-locking ratchet).

**How to apply / key facts**
- `classifyExitClass(close_reason)` — 8+1 enum. **Ordering is load-bearing:**
  `"⚡ Trailing TP:"` is a NOTIFICATION PREFIX prepended to EVERY exit (stop
  loss, low yield, harvest, OOR), so the specific trigger must match FIRST.
  Verified 100% coverage / ZERO UNKNOWN on 160 live closes (135 distinct
  strings). Distribution: PUMP_ABOVE 46, OOR_TIMEOUT 29, STOP_LOSS 26,
  LOW_YIELD 23, OOR_UP_HARVEST 22, TRAILING_TP 13, MANUAL 1.
  Direction-less OOR (Rule 4 / max_hold_oor) → `OOR_TIMEOUT`, never a
  fabricated `OOR_DOWN`. `Break-even stop` → TRAILING_TP (peak-armed family).
- Buckets: `VOLATILITY_BUCKETS` (edges match the 39-trade EV study that produced
  the minVolatility floor), `FEE_TVL_BUCKETS`, `ENTRY_DIRECTION_BUCKETS`
  (token_price_change_1h: down/flat/up/pump), `REGIME_BUCKETS` (sol_regime_24h).
  entry_features present on only 96/160 live records, and 15 of those have null
  fields → those records are counted in `unknown_excluded`, NOT bucketed.
- `aggregateBuckets` = realized_sol_delta ONLY (12/160 records lack it → skipped,
  no fabricated EV). Neutral band KEPT in n. Verdict ladder THIN(n<10) /
  NOISE(|t|<2) / SIGNAL, plus a `micro_ev` flag = statistically real but below
  the 0.005 SOL bar. Report BOTH — several live buckets are SIGNAL+micro.
- Live findings at build time: `exit_class=STOP_LOSS` n=25 EV −0.0164 net
  −0.4108 SOL SIGNAL (the whole drain); `vol[2.5,3.5)` n=69 EV −0.0024 SIGNAL;
  `PUMP_ABOVE` n=40 EV +0.0027 SIGNAL; `fee0.4+` n=97 EV −0.0016 but NOISE.
- Dedup of the existing backlog: 70 → 42 active, 28 merged into counts,
  duplicates + cap overflow ARCHIVED to `lesson_archive` (never deleted).
- **PROPOSE-ONLY guard (`learning.evolveAutoApply` default FALSE)** —
  `evolveThresholds` returns `changes:{}` and writes ONLY
  `threshold-proposals.json` (gitignored) + a Telegram notice. LOOSEN of a risk
  gate ⇒ `requires_bro_approval` + Cassiopeia review. Comparator is now a
  WINDOWED percentile (p20 winners / p80 losers over last `evolveWindowN`=40).
  Legacy auto-apply is still reachable behind the flag (that path is what
  `scripts/test-evolve-thresholds.js` opts into).
- **False claim REMOVED from boss-report:** "bot sekarang menghindari pola ini"
  (+ "memprioritaskan", "memperketat … sendiri"). Lessons only enter the LLM
  prompt; they never create a filter. `enforcementNote(dims, userConfig)` now
  states the truth per dimension (direction gate ON/OFF, whether the
  minVolatility floor covers the whole bucket or only part, exit-side patterns
  are not entry filters).
- Tests: `scripts/test-bucket-learning.js` (141). Pre-existing unrelated
  failures in `test-briefing-executive.js` (2: "headline is live money",
  "live counts 2 wins / 1 loss in 30d") exist on main too — not from this work.
- Still open: CLAUDE.md has no entry for the `learning.*` config block (agents
  must not edit CLAUDE.md — Bro/Polaris call).

Related: [[loss-attribution-64-live-2026-07-06]], [[reaudit-postfix-n17-2026-07-22]],
[[realized-pnl-source-of-truth]], [[measurement-journal-system]]

— Lyra 🎵
