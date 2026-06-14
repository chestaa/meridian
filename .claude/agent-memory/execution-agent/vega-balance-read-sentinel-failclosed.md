---
name: vega-balance-read-sentinel-failclosed
description: getWalletBalances returns sol:null+error:true on read failure (NOT sentinel 0); all money gates fail-closed on unknown balance
metadata:
  type: project
---

Fixed the phantom "BURNER BALANCE DRAIN" false-alarm class (2026-06-04). Shipped to main.

**Root cause:** `tools/wallet.js getWalletBalances()` returned sentinel `sol: 0` on
EVERY Helius failure (non-200 / 429 / timeout / empty `balances` array). Two failure
modes downstream:
- Drain monitor `(prev - 0)/prev = 100%` -> phantom 100% drain alert while wallet intact.
- Deploy SOL-coverage gate + live screening pre-check FAILED OPEN: `null < minRequired`
  is falsy in JS, so a naive `balance.sol < x` lets an unknown balance pass the gate.

**The contract now (load-bearing — do not regress):**
- `getWalletBalances()` returns `sol: null` + `error: true` + `error_message` on ANY read
  failure or missing `balances` array. A GENUINE empty wallet (`balances: []`) still
  returns real `sol: 0` with NO error. Callers MUST distinguish "truly 0" vs "unread".
- `tokens` stays `[]` (not null) on failure so auto-swap callers (`.tokens?.find`) never throw.
- Every money gate fail-closes on `error || sol == null || !Number.isFinite`: executor
  SOL-coverage (`solCoverageRejectReason`, exported pure fn), index.js deploy-sizing abort,
  index.js live screening pre-check, agents/vega.js deterministic deploy (already via
  `numberOrNull`). Circuit breaker already halts on null (now reached correctly).

**Why:** money-path balance-read integrity. Anti-pattern #2/#3 — never assume funds when
the read failed; a Helius blip must defer a cycle, never fire a fake alert or fail-open a gate.

**How to apply:** any NEW caller of getWalletBalances that gates money MUST guard
`bal?.error || bal?.sol == null || !Number.isFinite(Number(bal.sol))` BEFORE comparing
`.sol`. Never write `balance.sol < x` without that guard. See
[[executor-test-seam-pattern]] for the test-seam convention used by the drain monitor
(`runBalanceDrainMonitor` takes injectable `secondRead`/`fireAlert`/`store`; `index.js`
exports `__setLastBalanceSampleForTest`).

**Drain monitor design:** catastrophic drop (>=90%) now REQUIRES a confirming SECOND read
before any alert — intact-or-failed second read => blip suppressed. `solNow > 0` guard so a
0-read can never compute a 100% drop. Pure core = `decideBalanceDrainAction`.

Test: `scripts/test-drain-monitor.js` (34 assertions).
