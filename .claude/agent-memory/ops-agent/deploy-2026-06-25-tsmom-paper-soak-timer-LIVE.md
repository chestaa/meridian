---
name: deploy-2026-06-25-tsmom-paper-soak-timer-LIVE
description: TSMOM B1 forward paper-soak systemd timer staged+ENABLED on VPS (Lyra v3-btc-long); merge ff to main, one-shot verified, freshness guard wired, all services undisturbed + main bot HALTED
metadata:
  type: project
---

TSMOM paper-soak deploy — Lyra B1 forward soak now on a daily systemd timer.

**Why:** Lyra validated B1 (TSMOM) = PARTIALLY VALIDATED, BTC-only, long/chop-biased
(v2-deephistory backtest, BTC EDGE_POSITIVE t=4.14; ETH/SOL NOISE). Forward
out-of-sample paper-soak is the honest next step before any capital. Draco staged
+ enabled the ops plumbing.

**How to apply / facts:**
- **Merge:** clean fast-forward main e051beef → b3f7661d (backtest harness) →
  28a7944b (Draco units). No conflicts. VPS autopull pulled each.
- **GOTCHA / interface coordination WIN:** Polaris warned re prior interface-
  mismatch. On first recon Lyra's forward-soak runner did NOT exist yet — branch
  had only the BACKTEST harness (`tsmom/tsmom-run.js`, which re-runs same backtest +
  would SPAM ~hundreds of journal rows/run — DO NOT point a daily timer at it).
  Staged a DISABLED placeholder unit. Mid-session Lyra pushed the real runner
  `tsmom/tsmom-paper-soak.js`; READ her in-file CLI contract (lines 30-39) and
  wired the EXACT interface — no guessing.
- **Lyra's CLI (exact):** `node tsmom/tsmom-paper-soak.js run` (fetch latest BTC
  close, mark/rebalance, log) | `status` (no write) | `--help`. Env: TSMOM_SOAK_STATE
  (default tsmom/data/soak-v3-btc-long.json), JOURNAL_FILE (default ./journal.jsonl),
  TSMOM_DATA_DIR, TSMOM_SOAK_NO_FETCH=1. IDEMPOTENT — date-guarded on latest CLOSED
  bar, re-run same UTC day = mark only, NO double-rebalance, NO journal spam. Safe
  for daily timer. Config = v3-btc-long: 252d lookback, 21d rebalance, vol-scaled
  0.4 ann, allowShort=FALSE (long/flat only). NO money / NO LLM / NO on-chain.
- **Units (in repo deploy/systemd/ + installed /etc/systemd/system, ENABLED):**
  - meridian-tsmom-soak.{service,timer}: oneshot, daily 00:30 UTC (08:30 CST VPS),
    Nice=10 + IOSchedulingClass=idle + ProtectSystem=strict + ProtectHome=true +
    NoNewPrivileges + ReadWritePaths=/opt/meridian /opt/meridian/tsmom/data,
    OnFailure=meridian-notify@%n. Mirrors capture-logger/intel-digest pattern.
  - meridian-tsmom-freshness.{service,timer}: daily 06:00 UTC, stall guard.
    `scripts/tsmom-soak-freshness.js` reads soak STATE last_run_at as PRIMARY
    heartbeat (every run stamps it → catches stall from day 1, NOT only after
    rebalances which are ~21d apart). exit 1 (Telegram via OnFailure) if last_run_at
    > TSMOM_FRESH_MAX_DAYS (2). Journal recency = secondary note. Tested exit
    0/1/1/0 for fresh/stale/corrupt/pre-launch. Guards the 18-day-stale lesson.
- **One-shot test (Task 4) VERIFIED on VPS via systemd:** Result=success
  ExecMainStatus=0. First run action=cold_open (BTC closed bar 2026-06-24 @
  $60995.13, signal FLAT weight=0 — trailing-252d −44.94% → cash, correct for
  long/flat). State file soak-v3-btc-long.json written. 2nd run action=mark
  (idempotent confirmed). **First JOURNAL row defers to first rebalance (~21 days,
  ~mid-Jul 2026)** — cold-open logs no period BY DESIGN; do not expect a journal
  row before then. Journal-append path proven separately (backtest je_..._y1oh27).
- **Storage:** soak STATE = tsmom/data/soak-v3-btc-long.json (in tsmom/data,
  committed-dir but state file gitignored-runtime alongside). Journal =
  /opt/meridian/journal.jsonl (gitignored, SHARED ledger so journal-cli report
  sees TSMOM). BTC-daily.json refreshed in tsmom/data each run.
- **FLAGGED (not fixed) — journal off-box backup gap:** journal.jsonl has NO
  off-box backup. Existing meridian-capture-backup.sh only seals DAILY-ROTATED
  tier files (capture-data orphan branch) — journal is a single growing append-only
  file, doesn't fit seal-by-day. Recommend: add a dated daily snapshot copy of
  journal.jsonl into capture-backup worktree, OR a separate journal-backup. Did NOT
  edit VPS-only capture-backup.sh (it's not in git — editing un-versioned VPS script
  out of scope). Low urgency: journal is proxy/sim, reconstructable from soak state +
  re-run. Capture units (meridian-capture-*) live ONLY on VPS, never committed to repo.
- **Services undisturbed:** meridian (main bot) = inactive/HALTED ✓; signal-runner +
  auto-screener active; 5 capture timers active; snapshot/intel/discord active; both
  new tsmom timers active. Pre-existing failed units (ipmi/logrotate/mcelog) = OS-
  level, NOT mine.
- **Reversible:** `systemctl disable --now meridian-tsmom-soak.timer
  meridian-tsmom-freshness.timer`.
- HEAD main = 28a7944b. See also [[deploy-2026-06-25-measurement-journal-v1-VERIFY-already-landed]].
