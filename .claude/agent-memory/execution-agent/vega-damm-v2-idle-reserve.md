---
name: vega-damm-v2-idle-reserve
description: DAMM v2 idle-reserve parking (item 8) — scaffold built flag-OFF, live VETO'd pending SDK install + Bro gate
metadata:
  type: project
---

DAMM v2 idle-reserve parking (item 8) — park genuinely-idle SOL (above gas +
active-LP headroom) into a Meteora DAMM v2 fee-compounding pool for yield on
un-deployed capital. Vega owns this money path; it is a SEPARATE path from DLMM.

**Why:** Sirius intel — earn yield on idle gas-reserve / un-deployed capital
instead of letting it sit; secondary use is position-NFT splitting for partial
exits. Built 2026-05-30 on Bro's "build now, flag-OFF, Vega gates live" request.

**How to apply:**
- SDK is `@meteora-ag/cp-amm-sdk` ("SDK for DAMM v2", latest 1.4.3 at build).
  NOT installed (only `@meteora-ag/dlmm` 1.9.4 is). Same `@coral-xyz/anchor`
  dep → same ESM/CJS lazy-import hazard, so the module uses a lazy dynamic
  import that returns null (never throws) when SDK absent.
- Real CpAmm API confirmed from bundled types: `createPositionAndAddLiquidity`,
  `removeAllLiquidity`, `claimPositionFee`, `getDepositQuote`,
  `fetchPositionState`. Position-NFT based; compounding mode exists.
- Module `tools/damm-v2.js` is SCAFFOLD: money-decision logic (computeParkableSol,
  hardcap clamp, flag gate, fail-safe) is COMPLETE + tested (26/26). On-chain
  SDK wiring is behind a lazy import currently unreachable (SDK absent → no-op).
- Config keys (config.js `damm` section): `dammV2Enabled` (default FALSE),
  `dammV2MaxParkSol` (0.3 hardcap), `dammV2PoolAddress` (null), `dammV2MinIdleToPark` (0.1).
- Test: `scripts/test-damm-v2.js`. Did NOT touch executor.js/dlmm.js/wallet.js.
  money-exit-batch regression still 30/30.
- LIVE VETO still in force. To lift: (1) `npm install @meteora-ag/cp-amm-sdk`
  on a controlled deploy, (2) implement the on-chain branch with confirmTransaction
  + on-chain verify (anti-pattern #3), NO retry (#4), (3) curate + verify a
  SOL-stable DAMM v2 pool address, (4) Cassiopeia + Lyra sign-off, (5) Bro
  explicit gate + flag flip. Flag flip ALONE is insufficient by design.

Related: [[vega-realized-sol-accounting]] (same additive-flag-OFF discipline).
