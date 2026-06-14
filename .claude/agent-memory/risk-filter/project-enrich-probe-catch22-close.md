---
name: enrich-probe-catch22-close
description: Enrich cost-probe catch-22 closed — probe must sentinel ALL nine native-detail back-fill fields (not just vol+organic); dual numeric(null)===0 coercion bug
metadata:
  type: project
---

The TRUE last wall (Draco empirical 2026-06-11, post commit 0db9228; fix commit
`24e2ab5`). Supersedes the "wall closed" claim in [[native-detail-enrich-before-gate]].
After quote-organic ([[quote-organic-bluechip-exempt]]) was confirmed fixed over 2
cycles, `enrichNativeDetailBeforeGate` STILL fired 0 times — a catch-22 in its own
cost-probe.

**The catch-22:** the probe deciding "is the native fetch worth spending?" sentinelled
ONLY `volatility` + `organic_score`. But the fetch back-fills NINE fields. A signal pool
genuinely missing `created_at` (structural gap on the cross-ref endpoint) hit the AGE
gate INSIDE the probe → `getRawPoolScreeningRejectReason` returned a token-age reject →
fetch skipped → created_at never back-filled → pool never reached the judge. The probe
gated the very field the fetch was about to fill. 5 clean pools (清正/CHANCE/1-SOL/
Bountywork/PARQ) cleared every quality gate but died here.

**Dual root cause — both `numeric(null) === 0`:**
1. Probe sentinelled only 2 of 9 back-fill fields. The other 7 (created_at, mcap, tvl,
   volume, fee/tvl, holders, bin_step) were gated against their real (missing→coerced-0)
   values.
2. SECOND bug in the back-fill block itself: its missing-test used `numeric(pool.X) == null`,
   which is ALWAYS false for an absent field (`Number(null)===0`, `0 == null` is false).
   So even when the fetch DID fire, created_at/mcap/fee-tvl/volume/bin_step were NEVER
   written. Only vol+organic worked because they already used `strictNumeric`.

**Fix (single source of truth):** `buildEnrichProbe(pool, s)` (exported via
`__buildEnrichProbeForTests`) co-located with the fill block — sentinels ALL nine
back-fill fields, optimistically, ONLY where genuinely missing (via `strictNumeric`, NOT
`numeric`). created_at sentinel = midpoint of the active age band (clears min AND max).
Back-fill block's missing-test switched to `strictNumeric` so genuinely-null fields are
detected and written.

**Why:** probe must predict the post-fetch gate verdict. If it gates a field the fetch
fills, it strangles its own funnel. Co-location + the audit-guard test mean a future
10th back-fill field that's left un-sentinelled fails loudly in CI, not silently in prod.

**How to apply (the invariant):** the probe may gate ONLY fields that are genuinely
available pre-enrich AND not back-filled. ANY field the fetch can fill MUST be sentinelled
in the probe. Use `strictNumeric` for every missing-test that must tell null from a real 0
(anti-pattern #2 corollary — the coercion form of it).

**Fail-closed PRESERVED:** sentinel lives ONLY in the probe (the worth-fetching
decision). After the fetch runs, real-eval re-evaluates ACTUAL data — a field the native
detail genuinely lacks (or a failed fetch) stays null and the gate rejects it (age reject
/ volatility_unknown / organic_unknown / holders_unknown). A real present value (e.g.
mcap below floor) is NOT sentinelled → doomed pools still drop pre-fetch, no native fetch
wasted (Lyra cost order intact). Probe optimistic, real-eval fail-closed. See
[[feedback-fail-closed-missing-data]].

**Test:** `scripts/test-native-detail-enrich-before-gate.js` now 43 assertions (+6):
[11] probe clears w/ missing created_at + active age band; [11b] e2e stuck-pool→judge;
[12] missing created_at after fetch → age reject (real-eval fail-closed); [12b]
enrich-fail after probe-clear → vol/organic_unknown; [13] real mcap below floor → no
fetch (cost guard); [14] AUDIT guard — probe with ALL 9 fields missing clears (tenth-field
catch-22 tripwire). Full gate suite green. Reminder: Draco restart-3 to deploy.
