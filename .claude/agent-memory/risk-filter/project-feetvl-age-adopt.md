---
name: project-feetvl-age-adopt
description: Intel adoption — fee/TVL high-pref + token-age 12-48h SCORE BONUSES (never gates); refused blind 0.20 hard floor / 48h max as dormancy risk
metadata:
  type: project
---

Adopted community/yunus intel 2026-06-02 as `scoreCandidate` SCORE BONUSES, NEVER gates.
Evidence-based + anti-dormancy — refused the literal "blind" advice.

**The intel & why I refused the blind version:**
- "24h fee/TVL is KING, below ~20% doesn't cover IL" → literal = hard floor 0.20.
  REFUSED: we already had 0-deploy days at a 0.08 live floor; 0.20 = permanent
  dormancy. yunus runs more sources/volume → can't copy his floor without throughput.
- token-age sweet spot 12-48h → literal = replace 24-720h band with 12-48h.
  REFUSED slashing maxTokenAgeHours to 48 → would reject every mature pool = mass dormancy.

**What I shipped (flags default FALSE — opt-in, Bro enables after paper-soak):**
- `feeTvlHighBonus(pool, cfg)` — linear ramp floor 0.10 → target 0.20, full weight 250
  at/above target, capped above. Reads `fee_active_tvl_ratio` (raw + condensed).
- `tokenAgeSweetSpotBonus(pool, cfg)` — flat weight 200 inside [12,48]h, 0 outside.
  Reads `token_age_hours` (condensed) OR derives from `token_x.created_at` (raw).
- Both exported, pure, fail-safe neutral (missing/non-finite/negative → 0, never penalize/reject).
- Wired into both `scoreCandidate` callers + the final `getTopCandidates` re-sort
  (re-sort now fires when ANY of the 3 bonus flags is on).

**Hard-floor changes (the anti-dormancy guarantee — reject floor ≠ bonus floor):**
- `minFeeActiveTvlRatio` base default 0.05→0.06; live overlay (user-config liveOverrides)
  0.08→0.10. NOT 0.20.
- `minTokenAgeHours` default 24→12. `maxTokenAgeHours` left generous (NOT 48).

**Fresh-read finding (Sirius/Orion edited recently):** user-config.json already had
`minTokenAgeHours: 8` and `maxTokenAgeHours: null` — so live age min was already below my
12 proposal; I did NOT push it back up. Documented config default = 12, live reality = 8.

Tests: `scripts/test-feetvl-age-adopt.js` (25 assertions, incl. dormancy-safety proof that a
blind 0.20 hard floor WOULD reject a mature/moderate pool our ranking keeps). Re-ran
test-gate-batch (22) + test-feegen-symmetry (17) — all green. Touched ONLY screening.js +
config.js + user-config.json (live overlay) + CLAUDE.md. No executor/dlmm/wallet/state.

Same pattern as [[project-feegen-symmetry-bonus]]; see [[feedback-fail-closed-missing-data]].
Floor history in [[project-feetvl-tvlmc-binsbelow]].
