---
name: deploy-2026-06-11-mcap-band-widen-a4d5bf4
description: opsi Y deploy — widen signal mcap band 5k/80k -> 50k/2M (Cassiopeia a4d5bf4); top-level user-config fields; signal band is SCORING ±20 not a hard gate; encryption survived restart
metadata:
  type: project
---

Deployed opsi Y (Bro gas-to-live) 2026-06-11: widen SIGNAL mcap band 5k/80k → 50k/2M.

**Merge:** Cassiopeia `a4d5bf4` (feat(risk): widen signal mcap band). ff `1a02ca3..a4d5bf4` → main, pushed. 5 files: config.js, signal-parser.js, CLAUDE.md, backtest-harness.js, +new scripts/test-mcap-band-widening.js. HEAD main=a4d5bf4.

**Config edit:** `signalMinMcap`/`signalMaxMcap` are **TOP-LEVEL** keys in user-config.json (lines 29-30), NOT nested under `screening`. config.js:123-124 maps `u.signalMinMcap ?? 50_000` / `u.signalMaxMcap ?? 2_000_000` → `config.screening.signalMinMcap/signalMaxMcap`. Old explicit override 5000/80000 MASKED the new defaults — had to overwrite top-level fields. Set to 50000/2000000. Backup: `user-config.json.bak-mcapband-2026-06-11`.

**CRITICAL mechanism (don't mis-report):** signal mcap band is a SCORING factor (±20 of 55-pass threshold) in signal-parser.js `scoreEnrichedProfile`/`scoreLegacyProfile` (lines 114-118, 156-159), NOT a hard gate. In-band = +20, out-band = lose +20 + reason "mcap outside early signal band". So "reject count → 0" is the WRONG metric — correct metric = in-band signals now collect +20 → more often cross threshold 55 → reach Orion judge. Live re-score proof: $534k/$922k(PARQ)/$200k/$1M now IN-BAND; $3.4M(Jotchua)/$45k still out (correct).

**Path scope:** opsi Y affects ONLY signal-runner path (Discord/Solscan/screener-signal inbox via signal-parser.js). Auto-screener path uses SEPARATE native band `minMcap 150k`/`maxMcap 10M` (config keys minMcap/maxMcap) — UNAFFECTED.

**Why:** old 5k/80k band penalized the real quality zone (yunus $100k-1M, PARQ $922k) — they scored out-of-band and barely reached judge. Widening lets that zone earn +20.

**How to apply:** when verifying band funnel effect, look for `preScore.reasons` in signal-results.jsonl — pre-restart records still show old-band "mcap outside early signal band" for $100k-2M pools; post-band those score in-band. Don't claim deploy/reject-drop until a FRESH post-restart in-band signal flows (signal-runner polls 30s; was inbox-empty at deploy time).

**Encryption (opsi B) survived restart:** confirmed `source=BURNER_WALLET_KEY (enc:AES-256-GCM) pubkey=DgA9MZYE...1Hiu` post-restart — master key systemd drop-in re-injected fine. Restart of 3 svc does NOT break [[deploy-2026-06-11-encrypted-env-ACTIVATED]].

**State at deploy:** 3 svc active NRestarts=0, Mode LIVE deepseek-v4-flash, bal 0.851956 SOL, 0 open positions (25 historical/closed), verdict-log logs/verdicts-2026-06-11.jsonl exists (Orion persist OK), cost today $0.127402/167 calls cap$1.10, 0 err. No fresh post-restart deploy yet.
