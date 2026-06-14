---
name: intel-digest-pipeline
description: How the auto-learn intel digest ingests crawls — staleness guard, crawl-before-digest, dedup-vs-existing; deploy + systemd wiring
metadata:
  type: project
---

The auto-learn intel digest (`scripts/intel-digest.js`, Orion-authored, advisory-only) runs daily via systemd `meridian-intel-digest.timer` at 06:00 UTC on the VPS.

**Fixed 2026-06-02 (fresh-ingest bug):** digest had been re-ingesting a frozen 2026-05-30 crawl for days → empty output. Two faults, both now fixed:

1. **No crawl-before-digest.** The systemd `.service` ran `intel-digest.js` alone; nothing refreshed crawls first. **Why it matters:** crawlers (intel-x/telegram/discord.js) only ran when someone invoked them manually, so the timer read whatever stale file was on disk. **How to apply:** the unit now runs `intel-digest.js --crawl` + `Environment=INTEL_DIGEST_CRAWL=1`; `runCrawlers()` shells out to the 3 crawlers via `child_process.spawnSync` (NEVER imported — preserves zero money/config imports). `TimeoutStartSec` bumped to 900s (crawl of 3 sources ≈ 70s + DeepSeek call).

2. **`findLatestCrawls` picked latest-by-mtime with no age guard.** **Why it matters:** mtime gets bumped by `git pull`/scp without the data being newer, AND when no fresh crawl landed it silently re-fed the old file forever. **How to apply:** selection is now by EMBEDDED timestamp (filename ISO stamp / `crawled_at`), and `buildCorpus` EXCLUDES crawls older than `STALE_MAX_AGE_DAYS` (default 2, env `INTEL_DIGEST_STALE_DAYS`). All-stale → `stale_blocked` verdict, no LLM spend.

**Dedup-vs-existing:** `dedupVsExisting()` drops suggestions re-proposing already-live features (TVL/MC + Fees/MC gates, partial/trailing TP, velocity exit, rug gates, bundler caps, dynamic sizing) by READ-ONLY regex match against `user-config.json` (merges `liveOverrides` + `internalAgents`). Surfaced as `deduped_suggestions` for Lyra audit, never auto-applied. CAUTION on the `cheap_llm` rule: it must only fire on "switch TO deepseek" phrasing, NOT any mention of "deepseek" — else a suggestion to evaluate a *different* cheaper model (e.g. MiMo, Minimax M3) that name-drops our baseline gets wrongly filtered.

**Deploy mechanism (load-bearing):** VPS `/opt/meridian` runs `git pull origin main` via a `*/2 * * * *` cron (`logger -t meridian-autopull`). Code fixes MUST land on `main` to reach the VPS — a feature branch will never autopull. Systemd unit edits are separate (live in `/etc/systemd/system/`, NOT in git) — edit on VPS + `systemctl daemon-reload`; backup saved at `/root/meridian-intel-digest.service.bak.<date>`.

Tests: `scripts/test-intel-digest.js` (42, dedup-aware) + `scripts/test-intel-digest-fresh.js` (32: timestamp-over-mtime, stale exclusion, all-stale verdict, dedup, child-proc guardrail). Model unchanged: `deepseek/deepseek-v4-flash`. See [[intel-output-locations]], [[intel-crawlers]].
