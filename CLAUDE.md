# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.06 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| signalMinMcap / signalMaxMcap | screening | 50k / 2M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 15 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| minTokenAgeHours | screening | 12 |
| maxTokenAgeHours | screening | 720 |
| requireMintRenounced | screening | true |
| requireFreezeRenounced | screening | true |
| rejectRugpullFlag | screening | true |
| devSoldAllRequiresHighConcentration | screening | true |
| tvlMcapGateEnabled | screening | true |
| maxTvlMcapRatio | screening | 0.2 |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**Dual mcap band (Cassiopeia):** two intentionally distinct mcap windows.

- `minMcap / maxMcap` (150k–10M) — **native pool discovery** (Hunter), conservative deep-screen.
- `signalMinMcap / signalMaxMcap` (50k–2M) — **signal-mode only** (`signal-parser.js` + `backtest-harness.js`), for alpha/KOL-surfaced earlier-stage opportunities. Floor sits *below* native (50k vs 150k — alpha justifies earlier entry); ceiling sits *below* native (2M vs 10M — late-stage large-cap is native's job). Widened 2026-06-11 (Bro opt Y) from 5k–80k: old 80k ceiling rejected the real quality DLMM zone (yunus SOL-USDC $100k-1M, PARQ $922k, Jotchua $3.6M); floor RAISED 5k→50k (sub-50k = degen/rug/thin). Bands now overlap 150k–2M, closing the old 80k–150k dead zone. **Widening mcap does NOT loosen any other gate** — rug/bot/top10/holders/fee-TVL/organic/TVL-MC/volatility stay strict; mcap only sets pool SIZE. In `signal-parser.js` the band is a +20 score component (out-of-band → lose 20pts, often drops below the 55 watch threshold); in `backtest-harness.js` it is a hard reject. Hard late-stage cut (>50M) and implausible-low cut (<1k) are separate and unchanged. Tests: `scripts/test-mcap-band-widening.js` (18 assertions).

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected. NOTE: `discoverPools()` runs a refetch-before-reject pass (`refetchVolatilityForUnusable`) — pools reading vol≤0 on the 5m feed are re-fetched at 30m; only those STILL ≤0 at 30m are dropped (avoids stale-feed false-positives like the RICH-SOL miss)
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

**TVL/MC ratio gate (Cassiopeia, Item 2 — LIVE-ONLY):** in `getTopCandidates()`, fires only when `DRY_RUN=false` AND `tvlMcapGateEnabled`. Rejects pools whose `tvl/mcap > maxTvlMcapRatio` (default 0.2). Thesis (@0xyunss + community, 71% win backtest): smaller TVL/MC → thinner liquidity vs cap → tighter active range → better fee capture. FAIL-SAFE: missing/zero mcap or tvl → `tvl_mcap_ratio_unknown` reject (anti-pattern #2). Pure fn `tvlMcapGateRejectReason(pool, s)`. Reject reasons: `tvl_mcap_ratio_too_high`, `tvl_mcap_ratio_unknown`. Paper/backtest unaffected (live overlay).

**SOL-quote deployability pre-filter (Cassiopeia, Lyra cost-cut — NOT a risk gate):** in `getTopCandidates()`, fires BEFORE all enrichment (PVP/Jupiter/OKX) AND before the LLM judge when `requireSolQuote` (default `true`). This bot deploys **single-side SOL only** (executor.js refuses `amount_x>0`), so pools quoted in anything but wSOL (`So11111111111111111111111111111111111111112`) are undeployable — judged then refused at deploy = pure SCREENER+enrichment waste (Lyra: ~17% of candidates, e.g. GACHA-USDC, AVICI-USDC). BASE filter (fires paper AND live). FAIL-SAFE: missing quote mint → reject (anti-pattern #2). Pure fn `solQuoteRejectReason(pool, s)` (reads condensed `pool.quote.mint`). Reject reason: `non_sol_quote_undeployable`. Tests: `scripts/test-sol-quote-filter.js` (10 assertions).

---

## Cassiopeia Rug-Protection Gates (screening.js)

Applied inside `getTopCandidates()` after OKX/Jupiter enrichment. All **base gates** (fire in BOTH paper and live) and **fail-closed** per anti-pattern #2 — missing data = reject, never default to safe.

| Gate | Config flag (default) | Reject reason | Data source |
|------|----------------------|---------------|-------------|
| Mint authority renounced | `requireMintRenounced` (true) | `mint_authority_not_renounced` | `p.audit.mint_disabled` (Jupiter audit) — reject unless `=== true` |
| Freeze authority renounced | `requireFreezeRenounced` (true) | `freeze_authority_not_renounced` | `p.audit.freeze_disabled` (Jupiter audit) — reject unless `=== true` |
| Rugpull / liquidity removal | `rejectRugpullFlag` (true) | `liquidity_removal_rugpull` | `p.is_rugpull` (OKX `isLiquidityRemoval`) — reject if `=== true` |
| dev_sold_all (compound) | `devSoldAllRequiresHighConcentration` (true) | `dev_sold_all_high_concentration` | rejects only if `dev_sold_all === true` AND `top_holders_pct > maxTop10Pct`. Set flag `false` → legacy hard-reject (`dev_sold_all`). |

- Pure decision fns: `rugGateRejectReason(pool, s)`, `devSoldAllShouldReject(pool, s)` (both exported, unit-tested).
- When any mint/freeze gate is active, the Jupiter audit fetch runs even if bot/top10 caps are off (else `p.audit` is null → fail-closed reject everything).
- Smart-money hard coupling (`requireSmartWalletOrHighOrganic`) was **removed** — it was a disguised organic floor. Organic is now governed solely by `minOrganic` (live overlay recommends 72); smart-money stays a `scoreCandidate` bonus only.
- Tests: `scripts/test-gate-batch.js` (22 assertions).

### Item (a) Fee-Gen-Token — balanced two-sided flow (SCORE BONUS, never a gate)

`feeGenSymmetryBonus(pool, cfg)` (exported, pure, unit-tested) adds a `scoreCandidate` bonus
for pools with balanced buy/sell flow. **DATA VERDICT:** the Pool Discovery API exposes NO
per-side fee field (verified by live raw fetch — only aggregate `fee`/`avg_fee`/`fee_pct`/
`dynamic_fee_pct`). So this is a **PROXY** on buy/sell volume symmetry: `pool.buy_vol`/
`pool.sell_vol` are aggregated from OKX cluster flow (`buy_vol_usd`/`sell_vol_usd`) during
`getTopCandidates` enrichment — no extra fetch. A pool whose buy share `buy/(buy+sell)` sits
in the balanced band `[0.4, 0.6]` churns the active bin both directions → fees per crossing.

- **Scoring:** triangular falloff — full `feeGenSymmetryWeight` (default 300) at perfect 0.5,
  decaying linearly to 0 at band edges (0.4/0.6); outside band → 0.
- **Config:** `feeGenSymmetryBonusEnabled` (default **FALSE** — opt-in), `feeGenSymmetryWeight` (300).
- **FAIL-SAFE (anti-pattern #2):** missing/zero/non-finite/negative side volume → 0 bonus (NEUTRAL,
  never penalize). **NEVER a gate** — a one-sided pump can still be a fine LP; gating on symmetry
  would risk dormancy. Bonus is strictly additive (≥0), never a reject.
- After OKX enrichment, `getTopCandidates` re-sorts (only when flag on) so the bonus influences
  final ordering (the initial sort runs pre-enrichment when flow isn't yet attached → neutral there).
- Tests: `scripts/test-feegen-symmetry.js` (17 assertions).

### Intel adoption — fee/TVL high-preference + token-age sweet-spot (SCORE BONUSES, never gates)

Community/yunus intel adopted RESPONSIBLY (evidence-based, anti-dormancy): the literal advice was
a HARD fee/TVL floor at 0.20 and a HARD token-age band 12-48h. Both would starve the funnel
(0.20 ⇒ permanent dormancy — we already had 0-deploy days at 0.08; 48h max ⇒ reject every mature
pool). So both insights are captured as `scoreCandidate` SCORE BONUSES (re-ranking), NOT gates.

- **`feeTvlHighBonus(pool, cfg)`** (exported, pure, unit-tested): linear ramp from
  `feeTvlHighBonusFloor` (0.10) to `feeTvlHighBonusTarget` (0.20, the "king" line); 0 at/below
  floor, full `feeTvlHighBonusWeight` (250) at/above target, capped above (no over-reward).
  Reads `pool.fee_active_tvl_ratio` (present raw AND condensed).
- **`tokenAgeSweetSpotBonus(pool, cfg)`** (exported, pure, unit-tested): flat full
  `tokenAgeSweetSpotWeight` (200) inside `[tokenAgeSweetSpotLowHours, tokenAgeSweetSpotHighHours]`
  (12-48h), 0 outside. Reads `pool.token_age_hours` (condensed) OR derives from
  `pool.token_x.created_at` (raw).
- **Hard floors stay modest (the anti-dormancy guarantee):** `minFeeActiveTvlRatio` base default
  0.05→**0.06** (live overlay 0.08→**0.10**); `minTokenAgeHours` default 24→**12** (user-config
  may go lower — currently 8); `maxTokenAgeHours` left generous (null/720, NOT slashed to 48).
  The reject floor is NOT the bonus floor — a pool below 0.10 fee/TVL or outside 12-48h still
  deploys, it just earns 0 bonus and ranks lower.
- **Config (all default FALSE — opt-in, Bro enables after paper-soak):** `feeTvlHighBonusEnabled`,
  `feeTvlHighBonusWeight` (250), `feeTvlHighBonusFloor` (0.10), `feeTvlHighBonusTarget` (0.20);
  `tokenAgeSweetSpotBonusEnabled`, `tokenAgeSweetSpotWeight` (200), `tokenAgeSweetSpotLowHours` (12),
  `tokenAgeSweetSpotHighHours` (48). All wired into `reloadScreeningThresholds`.
- **FAIL-SAFE (anti-pattern #2):** missing/non-finite/negative input → 0 bonus (NEUTRAL, never
  penalize, never reject). The final `getTopCandidates` re-sort fires when ANY of the three bonus
  flags is on.
- Tests: `scripts/test-feetvl-age-adopt.js` (25 assertions, incl. a dormancy-safety proof that a
  blind 0.20 hard floor WOULD have rejected a mature/moderate pool that our ranking approach keeps).

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
