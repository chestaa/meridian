---
name: incident-2026-06-06-snapshot-service-failed-transient
description: 2026-06-06 meridian-snapshot.service FAILED alert at 09:32:06Z — transient single-cycle git/flock collision, NOT a code regression; SSH-blocked diagnosis
metadata:
  type: project
---

Telegram alert "SERVICE FAILED: meridian-snapshot.service at 2026-06-06T09:32:06Z". Polaris reads VPS status via this publisher (WebFetch to status branch), so failure = Polaris blind.

**Root cause (high confidence, code-ruled-out):** transient single-cycle failure of the oneshot, NOT a regression from today's merges (`78e179a` drain-fix, `fb670d3` intel-digest).
- snapshot-builder.js + snapshot-publisher.js are deliberately decoupled — import ONLY fs/path/url/@solana/web3.js. Neither commit touched these files (78e179a = index.js/executor.js/wallet.js/test; fb670d3 = intel-digest only).
- Local proof: `node scripts/test-snapshot-imports.js` → PASS (no forbidden imports); `node scripts/snapshot-publisher.js` (dry) → clean JSON, fresh wallet read 0.851234 SOL.
- Public status branch IS reachable: `raw.githubusercontent.com/chestaa/meridian/status/status-snapshot.json` last good `ts=2026-06-06T09:27:02Z` (the 5-min-prior cycle succeeded). So 09:27 pushed fine, 09:32 failed → single missed cycle.
- Likely mechanism: git collision on `.git-worktrees/status` — `*/N` autopull cron's `git reset --hard` on main OR a prior snapshot run held `.git/index.lock` / the `flock -n .snapshot.lock` (NON-BLOCKING → aborts non-zero immediately if locked), OR `git push --force-with-lease origin status` lease went stale. Oneshot exits non-zero → systemd marks failed. Next timer tick self-heals once lock clears.

**Why:** publisher is the only file-based comms channel for Polaris (bypasses SSH classifier).

**How to apply:** This failure mode is SELF-HEALING on the next timer tick — a single `failed` alert with a fresh-ish status branch (≤1 cycle stale) does NOT require intervention. ESCALATE only if status branch `ts` goes >2 cycles stale (>~15min) = persistent. See [[deploy-2026-05-28-snapshot-publisher]].

**HARDENING SHIPPED 2026-06-06 (commit `b3390c3`):** snapshot-publisher.js `pushSnapshot()` now uses `flock -w 30` (blocks up to 30s for the lock instead of `-n` aborting instantly) + retry-once wrapper (on first push failure: `git fetch origin status` to refresh the force-with-lease base, then re-push). This is the exact fix anticipated above — a momentary autopull collision no longer trips a `failed` alert. Code-only, no money/gate/config change, import-lint PASS. Lands on VPS via */N autopull cron (no SSH this session — SSH still ABSENT, see blocker below). Live confirmation pending next SSH re-provision.

**BLOCKER this session:** SSH key ABSENT again (Test-Path on ~/.ssh, key, config all False — the recurring disappearance, see [[reference-vps-ssh-canonical-path]]). Could NOT run journalctl / systemctl start / list-timers / confirm live recovery. Diagnosis done from code + public status fetch only. Bro must re-provision `~/.ssh/meridian_vps_ed25519` for live VPS confirmation + the ExecStart hardening.
