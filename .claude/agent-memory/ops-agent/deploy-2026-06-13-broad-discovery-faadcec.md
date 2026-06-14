---
name: deploy-2026-06-13-broad-discovery-faadcec
description: CROWN JEWEL deploy faadcec broad discovery (breadth 3→1000); merge+restart+verify, cost flat, gate now bottleneck not breadth
metadata:
  type: project
---

Deployed Cassiopeia **faadcec** "broad discovery — server→client gate migration (breadth 3→1000)" to main + live VPS on 2026-06-13. Fixes Bro's #1 complaint "cuma 5 pool dari jutaan".

**Why:** old code sent the full strict 16-clause filter to the Pool Discovery API server-side, so we only ever LOOKED AT ~50 pools (server pre-rejected the rest, page_size headroom thrown away). Bro wants "transaksi tiap hari ADA" (daily deploys) — needed breadth.

**How to apply:** the fix is a LOCATION move, NOT a loosening. `broadDiscoveryEnabled` (code default `true`, NOT in user-config → uses default) sends only a WIDE cheap server pre-filter (`pool_type=dlmm` + sanity flags + WIDE mcap 10k-50M + tvl floor 1k + free server sort `fee_active_tvl_ratio:desc`) at `page_size=broadDiscoveryPageSize` (1000), then runs the IDENTICAL strict Cassiopeia gate (`getRawPoolScreeningRejectReason`) CLIENT-side. Rollback = set `broadDiscoveryEnabled=false` in user-config (→ legacy full-server-filter, fully reversible). config.js keys are TOP-LEVEL user keys mapped to config.screening.*.

**Deploy mechanics:**
- Merge `feat/broad-discovery-server-client-migration` → main was FAST-FORWARD `a4d5bf4..faadcec` (linear, no merge commit), pushed origin/main, HEAD=faadcec.
- 6 files: config.js +35, tools/screening.js +185, scripts/test-broad-discovery.js (new 278), CLAUDE.md +7, risk-filter memory (new).
- Tests: `scripts/test-broad-discovery.js` = 38/38 PASS local (gate identical, fail-closed preserved, pre-rank cost boundary, legacy mode reversible).
- Restarted 3 svc: meridian + meridian-signal-runner + meridian-auto-screener — all active, NRestarts=0, 0 err.

**LIVE VERIFY (first cycle 22:14 CST):**
- Broad fetch = **1000 raw pool(s)** (server total=1059), was ~50. Log line: `Discovery fetch: BROAD mode, page_size=1000, sort=fee_active_tvl_ratio:desc → 1000 raw pool(s)`.
- **Client gate = 1/1031 passed** the strict gate. KEY INSIGHT: breadth fix works (we now look at 1031 vs ~50) but the STRICT GATE is now the bottleneck, NOT discovery breadth. Only 1 quality pool existed in the universe this cycle. This is correct/honest behavior — broad discovery surfaces MORE to evaluate but does NOT lower quality bar. Daily-deploy frequency now gated by genuine pool quality + maxPositions, not by artificial server pre-rejection.
- Pre-rank: `1 gate-passed → top-1 by score enter enrichment+judge (cost-flat at limit=10)`. Cost boundary = pre-rank slices to `limit` (10) BEFORE any per-pool enrichment.
- Judge: Orion `judged 1 candidates: 1 enter, 0 skip`. auto-screener parallel cycle: saved 1 candidate to inbox + Telegram.
- DEPLOY: open=0 (no deploy yet — only 1 candidate, judge discipline).

**COST CONTROL — NO EXPLOSION (critical):** cost today $0.064662 / 93 calls, cap $1.10 (baseline $0.05-0.13/day held). Enrichment probe-gated against strict thresholds + pre-rank top-N slice BEFORE enrich = enrichment + judge cost FLAT regardless of 1000-pool fetch. Cycle time fetch→gate ~16.5s for 1031 pools (acceptable, no slowdown). NO Lyra flag needed, NO rollback needed.

**Encryption + band INTACT post-restart:** wallet `enc:AES-256-GCM` pubkey `DgA9MZYE...1Hiu` MATCH, balance 0.836296 SOL, DRY_RUN=false model deepseek-v4-flash. Runtime band signalMinMcap=50000 signalMaxMcap=2000000. Strict gate unchanged: minOrganic 72, minFeeActiveTvlRatio 0.06, minHolders 500, minTvl 10000, maxMcap 10M, maxPositions 3. env-key at /etc/meridian/env-key (600 root) untouched.

**GOTCHA:** config.js is ESM on VPS — `node -e "require('./config.js')"` throws ERR_REQUIRE_ESM. Use `node --input-type=module -e "import('./config.js').then(...)"`.

Relates to [[deploy-2026-06-11-mcap-band-widen-a4d5bf4]] (prior HEAD), [[deploy-2026-06-11-encrypted-env-ACTIVATED]] (encryption preserved).
