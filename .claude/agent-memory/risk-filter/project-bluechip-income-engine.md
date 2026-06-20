---
name: bluechip-income-engine
description: Wave 2/Phase 1 bluechip dual-mode discovery+gate — built classifier+gate+flags (OFF), inverted risk profile, live feasibility proven
metadata:
  type: project
---

Wave 2 / Phase 1 income engine = LP into DEEP STABLE pools (SOL-USDC, JLP, JitoSOL,
LSTs) for steady fees with (near-)symmetric payoff. OPPOSITE profile from memecoin
narrow-range. Bro-approved roadmap. Cassiopeia owns DISCOVERY + GATE; Vega owns
deploy structure (two-sided wide-range — design parallel, NOT built here).

**BUILT (safe, additive, flag OFF, branch feat/broad-discovery-server-client-migration):**
- `BLUECHIP_INCOME_MINTS` (screening.js): wSOL/USDC/USDT/JLP/JitoSOL/mSOL/bSOL/JupSOL/cbBTC.
- `classifyPoolMode(pool)` → "bluechip" iff BOTH legs in the set (one bluechip leg +
  memecoin leg = "memecoin", inherits directional risk). Fail-safe: missing leg → memecoin.
- `isBluechipPool(pool, s)` → flag AND classify. `bluechipModeEnabled` default FALSE.
- `bluechipPoolGateRejectReason(pool, s)` — SEPARATE gate, INVERTED risk profile.
- Config keys + reloadScreeningThresholds wired. Tests: `scripts/test-bluechip-mode.js` (30).

**INVERTED GATE (why bluechip needs its own — the key design insight):**
- NO rug/mint/freeze/bot/top10/dev_sold_all — bluechip is rug-immune (no "dev", LST
  authorities protocol-controlled).
- Volatility is a CEILING (`bluechipMaxVolatility` 1.5), NOT a floor. The memecoin
  `minVolatility` 3.0 [[volatility-floor]] would reject 100% of bluechips (SOL-USDC
  vola ~0.14) — low vol is GOOD here (less IL). Test has inversion proofs.
- Own mcap band (`bluechipMinMcap` $50M) — memecoin 50k-2M band would reject SOL ($40B).
- Gates: deep TVL ($200k), consistent volume ($50k/24h, kills deep-but-dead like the
  live bonk-SOL $634k TVL/$2k vol), fee-yield (`bluechipMinFeeTvlRatio` 0.03 ≈11% APR
  on full TVL — LOWER than memecoin 0.13 because bluechip IL far smaller).
- regime-downtrend EXEMPT — already wired via `isMemecoinNarrowProfile` [[market-regime-gate]].
- FAIL-CLOSED (anti-pattern #2 [[fail-closed-missing-data]]): missing TVL/vol/fee/mcap
  → *_unknown reject, never default-pass.

**LIVE FEASIBILITY (2026-06-20 probe, FEW-but-DEEP confirmed):**
- 23 both-leg bluechip pools at TVL>=200k; ~8 with real volume (>50k/24h).
- SOL-USDC = 4 deep deployable pools (bs 4/10/20/80). REAL 24h APR on FULL TVL (honest,
  fee/tvl*365 — NOT the misleading fee_active_tvl_ratio*365 which gives absurd 40000%):
  SOL-USDC bs4 = 75% ($3.4M TVL/$18M vol), bs10 = 60%, bs20 = 32%, bs80 = 12%.
  USDC-SOL bs2 = 141%. JLP-USDC 15% on full TVL. JitoSOL-SOL = 1% (near-dead, correctly
  cut by volume/fee floors). So 20-40%+ APR thesis HOLDS for the SOL-USDC core.

**STILL DESIGN-ONLY (needs Bro + Vega):**
1. Deploy structure — two-sided wide-range (Vega money-path). Current executor refuses
   amount_x>0 (single-side SOL only). Bluechip wants two-sided → Vega change.
2. Turning `bluechipModeEnabled` ON. Discovery wiring into getTopCandidates (route
   bluechip pools to bluechipPoolGateRejectReason instead of the memecoin gate) is the
   next build step ONCE Vega's deploy path exists — gating without a deploy path = waste.
3. `requireSolQuote` pre-filter currently rejects non-wSOL quotes (USDC-quoted bluechips
   like JLP-USDC) — must be relaxed for bluechip mode WHEN two-sided deploy lands.

How to apply: bluechip path is fully inert until the flag flips. Do NOT enable without
Vega's two-sided deploy + Bro sign-off. When wiring discovery, branch on isBluechipPool
EARLY in getTopCandidates so bluechip pools skip the memecoin rug/vol-floor/mcap gates
entirely and hit bluechipPoolGateRejectReason instead.
