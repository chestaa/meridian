---
name: saveinbox-candidate-shape
description: saveToInbox + signal-parser field gaps that block screener candidates from reaching the Orion judge — condensePool nested shape, and Pool/Token line ordering trap in parseSignalMessage
metadata:
  type: project
---

THE LAST WALL before the Orion judge (fixed commit f4a3d3f, Draco empirical
2026-06-11 post 24e2ab5). Candidates cleared every Cassiopeia gate but were
dropped at `saveToInbox` ("Saved 0 candidates, skipped N with no token address").

**Two independent field gaps, both pure mapping bugs (data was present):**

1. **Candidate object shape (auto-screener `saveToInbox`).** `getTopCandidates`
   returns the `condensePool` shape (`tools/screening.js`, `condensePool()`):
   - token mint  → `c.base.mint`   (NOT `c.base_mint` / `c.token_address`)
   - pool addr   → `c.pool`        (NOT `c.pool_address`)
   - symbol      → `c.base.symbol` (NOT `c.symbol`)
   - scalars OK as-is: `c.tvl`, `c.volume_window`, `c.fee_active_tvl_ratio`,
     `c.organic_score`, `c.bin_step`, `c.volatility`.
   `saveToInbox` was reading the flat names → guard skipped EVERY candidate.
   This is NOT a `crossrefPoolFields` bug ([[crossref-endpoint-shape-mismatch]] —
   that maps gate INPUTS for signal sources and works); signal-source raw pools
   carry a flat `base_mint` alias, but they all pass through `condensePool` before
   reaching `saveToInbox`, so the inbox writer ALWAYS sees the nested shape.
   Fix = `resolveCandidateFields()` reads nested first, flat alias as fallback.

2. **Inbox-file parse-back (`signal-parser.js` `parseSignalMessage`).** The
   screener inbox file carries BOTH a `Pool: <addr>` and a `Token: <mint>` line,
   with **Pool FIRST**. The old `addresses[0]` heuristic picked the POOL address
   as the token mint → enricher (`signal-enricher.js`) queried Jupiter/Meteora
   for a pool address as if it were a token → fail / mis-ID. Parser now prefers
   the explicit `Token:` line and excludes the `Pool:` line address from token
   selection. The `pump/bonk/moon/uniP`-suffix heuristic still handles plain KOL
   "ape this CA" messages with no Pool:/Token: lines.

**Why the bug shipped green:** the old `test-auto-screener-guard.js` validated a
FICTIONAL flat candidate shape (`{ symbol, pool_address, base_mint }`) that
`getTopCandidates` never produces. Lesson: when testing a consumer of an upstream
object, mock the upstream's REAL shape, not a guessed one.

**How to apply:** anything consuming `getTopCandidates()` candidates reads the
`condensePool` nested shape (`base.mint` / `pool` / `base.symbol`). Anything
parsing a structured inbox `.txt` must not assume `addresses[0]` is the token —
prefer the explicit `Token:` line. Both fail-closed (anti-pattern #2): no mint OR
no pool addr → skip, never fabricate. Pipeline now: screener → inbox →
signal-runner → enrich → Cassiopeia pre-score → Orion judge.
