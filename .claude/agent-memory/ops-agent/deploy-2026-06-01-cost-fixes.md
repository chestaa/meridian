---
name: deploy-2026-06-01-cost-fixes
description: commit ed2440a; 3 cost fixes (SCREENER flash-only + step cap 8, USDC-quote pre-filter, daily cap 1.10) + manual VPS llmRouting sync removing v4-pro premium tier (the 97% cost center)
metadata:
  type: project
---

Deploy 2026-06-01 cost-burn kill. Commit `ed2440a`, pushed main, VPS fast-forwarded from `7eb0ffe`.

**Three code fixes (in git):** SCREENER flash-only + screeningMaxSteps cap 8 + prompt trim; USDC-quote pre-filter (`requireSolQuote` default true, fail-safe rejects missing/non-wSOL quote); daily cap raised 0.75→1.10 in cost-guard.js. Weekly $5 backstop unchanged.

**CRITICAL manual sync (gitignored user-config.json):** VPS `llmRouting.screening` had a third `premium` tier → `deepseek/deepseek-v4-pro` (maxInputTokens null) plus `workhorse` maxInputTokens 8000. This v4-pro escalation was the 97% cost center. Orion removed it locally; I replicated local's 2-tier screening (compact 2000 + workhorse null, both v4-flash) onto VPS via node read-modify-write. Backup: `/opt/meridian/.bak-llmrouting-2026-06-01.json`. management + general tiers already matched — only screening differed.

**Why:** SCREENER LLM calls were escalating to v4-pro on large prompts, dominating spend. Removing the premium tier makes v4-pro escalation structurally impossible.

**How to apply:** llmRouting lives in user-config.json (gitignored) — config changes there need manual VPS sync, never auto-pull. screeningMaxSteps lives under `config.llm.screeningMaxSteps` NOT config.screening (verify snippet that reads config.screening.screeningMaxSteps returns undefined — wrong path, value is fine).

Tests on VPS: test-screener-cost 12, test-sol-quote-filter 10, test-cost-guard 20 — all PASS. meridian restarted active Mode LIVE model v4-flash. Screening cron skipped (max positions 1/1, open position) so live USDC-filter / flash-vs-pro behavior not yet observed in logs — will surface when a position closes and screener fires. See [[deploy-2026-06-01-intel-ab-bossreport]].
