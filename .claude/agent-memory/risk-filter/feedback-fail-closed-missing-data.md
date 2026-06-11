---
name: feedback-fail-closed-missing-data
description: Rug/safety gates must fail-closed — missing data = reject, never default to a safe value (anti-pattern #2)
metadata:
  type: feedback
---

All rug/safety gates must be FAIL-CLOSED: when the data field is null/undefined, REJECT — never default to a "safe" value.

**Why:** Anti-pattern #2 in Cassiopeia's spec. `const holders = token.holders || 0` style defaults silently let bad/unknown signals through. Blind scanner historically let bad picks through partly from assuming defaults. A renounce check must use `mint_disabled !== true` (rejects both `false` = authority live, and `null/undefined` = unknown), NOT `mint_disabled === false` (which would pass on unknown).

**How to apply:** Any new gate touching authority/risk/rug data: write the predicate so missing data lands in the reject branch. When a gate needs enrichment data (e.g. Jupiter audit for mint/freeze), ensure the enrichment fetch actually runs when the gate is active — otherwise `p.audit` stays null and fail-closed rejects everything indiscriminately. See [[project-gate-hardening-batch]].
