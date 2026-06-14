---
name: sourcing-breadth-audit
description: Pool-discovery breadth ground-truth — why we see ~3-50 pools, API page_size ceiling 1000, the FILTER (not page_size) is the real choke
metadata:
  type: project
---

Sourcing-breadth audit (Bro complaint "we only trade ~5 pools out of millions"), 2026-06-13.

**Ground truth — what we fetch now:**
- `discoverPools()` calls `fetchPoolDiscoveryPage({ page_size: 50 })` — hardcoded `page_size=50`, ONE call, page 1 only.
- Pool Discovery API (`pool-discovery-api.datapi.meteora.ag/pools`) has NO working pagination: `page`/`current_page`/`skip`/`offset`/`cursor`/`p` are ALL ignored (verified live — every variant returns identical first-page rows). The ONLY breadth lever is `page_size`.
- **`page_size` ceiling = exactly 1000** (1000 returns 1000 distinct pool_addresses; 1200/1500/2000/5000 all return 0/empty). So one call can pull 1000 pools — we pull 50. **20× headroom left on the table, free.**
- Meteora DLMM universe total = **114,516 pools** (the API's `total` field, minimal filter `pool_type=dlmm`). `category` (trending/top/new) and `timeframe` (5m/1h/24h) do NOT change total — they only re-order/sub-select. `category=gainers/graduated/verified` → empty (unsupported).

**THE REAL CHOKE IS THE FILTER, NOT page_size:** our full live `filter_by` (mcap 150k-10M && holders≥500 && vol≥500 && tvl 10k-150k && binStep 80-125 && feeTvl≥0.06 && organic≥60) matches **only 3 pools** total. Relax to mcap/tvl/holders only → 210. Signal band 50k-2M relaxed → 125. So even page_size=1000 returns just those 3 — pulling more pages does nothing until the server-side filter widens. Widening page_size 50→1000 ONLY helps once the filter is loosened OR when we move filtering client-side (pull broad, rank, then gate locally).

**sort_by IS supported** on pool-discovery-api (`sort_by=fee_active_tvl_ratio:desc`, `volume:desc`, `tvl:desc` all honored) — re-orders within the `category` candidate set. Good for deterministic pre-rank before LLM judge.

**Signal sources per cycle (cross-ref via `dlmm.datapi.meteora.ag`, NOT pool-discovery):**
- solscan-trending: Jupiter `lite-api.jup.ag/tokens/v2/toptraded/24h?limit=30` (keyless) → cross-ref → only DLMM-backed kept. ~30 tokens in, handful of pools out.
- pumpfun-graduated: `frontend-api-v3.pump.fun/coins?limit=50&complete=true` → cross-ref. 50 in.
- discord-meteoraidn: parses ranked-digest file (selfbot-mirrored), Top-10 lists. Tiny.
- `dlmm.datapi.meteora.ag` exposes `pages: 57258` + `current_page` metadata BUT current_page is ALSO ignored (same bug). page_size up to 1000 works there too.

**Alternate breadth sources tested live:** GeckoTerminal `/networks/solana/dexes/meteora/pools` = 20/page, free tier page 2+ empty (capped). DexScreener search = 30 pairs. Both far narrower than Meteora's own 114k index — Meteora native is the breadth winner.

**How to apply:** the expansion is (1) raise page_size 50→1000 with broad server filter, (2) move strict gates client-side so we rank 1000 → pre-rank deterministic (scoreCandidate by feeTvl/vol/tvl) → judge only top-N. Do NOT loosen rug/bot/top10/organic gates (anti-pattern #8). Cost control: LLM judge stays top-10-15, the 1000 just feed a deterministic pre-rank. See [[three-dead-sources-diagnosis]], [[solscan-trending-keyless-jupiter]].
