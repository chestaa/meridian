---
name: deploy-2026-06-11-crossref-fieldmap-empiris
description: Deployed 2b4be22 (Sirius cross-ref full field-mapping) + EMPIRIS funnel verify — volume wall CLEARED, new wall = volatility/organic structural gap (cross-ref endpoint has NEITHER field), 0 deploy still
metadata:
  type: project
---

Deployed commit **2b4be22** (Sirius, follow-up to b233425) — "map ALL cross-ref window-object/misplaced fields → gate scalars". SSH worked first try (meridian-vps alias, key auth). Autopull cron had ALREADY pulled (Already up to date), HEAD correct. Restarted 3 services: meridian + meridian-signal-runner + meridian-auto-screener — all 3 active.

**Why:** Two Meteora datapi endpoints have DIFFERENT shapes. Cross-ref (dlmm.datapi) returns volume/fees/fee_tvl_ratio as window-OBJECTS `{30m,1h,...}`, bin_step at `pool_config.bin_step`, holders at `token.holders`. Native pool-discovery API (gate-calibrated) returns scalars. Sources were reading the native field names → choked one gate at a time. b233425 fixed volume only; 2b4be22 centralized ALL via `crossrefPoolFields()` helper so no source can re-drift.

**EMPIRIS funnel verdict (post-restart, 2 screening cycles 01:06 UTC observed):**
- **Volume wall CLEARED.** `volume below minVolume` dropped to non-dominant — only 24 total today, 8 of which literal `volume 0`. Signal pools now carry REAL volume and clear the volume gate.
- **New funnel walls (today histogram, signal-source pools):** `mcap below/above` (100+70) and `holders` (107 holders_unknown + 62 below minHolders) dominate. A handful reach FURTHEST and die at: `base organic 0 below minOrganic 75` (1-SOL, Bountywork, CHANCE, Magpie, PARQ, getmeajob, 清正) and Magpie at `fee/active-TVL 0.0555 below 0.1` (fee/TVL now maps REAL value — proves fix works).
- **STRUCTURAL GAP CONFIRMED (the deciding finding):** cross-ref endpoint exposes NO `volatility`, NO `organic_score`, NO token `created_at`. Commit 2b4be22 FLAGS these (anti-pattern #2, never fabricated). So cross-ref/signal pools report `organic 0` (default, not real) and can NEVER clear minOrganic 75 or the volatility deploy-check **without a separate native-detail enrichment fetch**. `volatility` reject count today = 0 only because pools die at organic/mcap/holders first.
- **Judge NOT called, $0 LLM today.** `candidates passed filter` = 0; the 7 "judge"-grep hits were just `[CRON] model: deepseek-v4-flash` header lines. Last llm-usage.json entry = 2026-06-10T16:14, nothing 06-11. Same as baseline (0 judge seharian).
- **0 deploy.** Open positions unchanged: 1 legacy SPCX-SOL (8nVdsMz...), maxPositions room exists. No new deploy.
- **Source mix:** funnel is ~fully SIGNAL-source (413 Discord-signal lines vs 10 native scan headers today). Native Meteora discovery SEPI.

**How to apply:** The last wall before judge is now the volatility/organic STRUCTURAL GAP, not field-mapping. Next step is **Cassiopeia native-detail enrichment** (fetch volatility + organic_score per cross-ref-sourced candidate before gating) — without it signal pools structurally cannot reach Orion. Field-mapping side is DONE. See [[deploy-2026-06-04-drain-falsealarm-fix]] for prior meridian-restart pattern. Sources route through `crossrefPoolFields()` — never read pool.volume/bin_step/holders/fee_active_tvl_ratio directly.
