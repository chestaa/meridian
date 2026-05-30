import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.burnerWalletKey) process.env.BURNER_WALLET_KEY ||= u.burnerWalletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Run Mode ───────────────────────────
  // dryRun: derived from env DRY_RUN ("true"/"false"); falls back to user-config.json.
  // Cassiopeia liveOverrides only activate when dryRun === false.
  dryRun: (process.env.DRY_RUN === "true")
    ? true
    : (process.env.DRY_RUN === "false")
      ? false
      : (u.dryRun ?? true),

  // ─── Cassiopeia Live Overlay (Option C) ──
  // Tighter thresholds applied ONLY when dryRun === false. null = legacy behavior.
  // Surfaces: minOrganic, maxBotHoldersPct, minFeeActiveTvlRatio, maxTop10Pct,
  // orionMinConfidence, requireDevNotSoldAll, requireSmartWalletOrHighOrganic.
  liveOverrides: u.liveOverrides ?? null,

  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // Vega Item 7 — Dynamic sizing by Orion confidence. Tiers MULTIPLY the
    // base deploy amount, then computeDynamicDeployAmount HARD-CAPS at
    // maxDeployAmount (belt). The executor's amountY > maxDeployAmount reject
    // is the suspenders — sizing can NEVER produce an oversize deploy.
    // Reversibility: dynamicSizingEnabled=false → fixed base amount (legacy).
    dynamicSizingEnabled: u.dynamicSizingEnabled ?? true,
    // Tiers are evaluated in order; first matching [minConf, maxConf) wins.
    // mult applied to the base (computeDeployAmount) result.
    sizingTiers: Array.isArray(u.sizingTiers) ? u.sizingTiers : [
      { minConf: 70, maxConf: 80,  mult: 0.5 },  // 70-80 → 0.5x
      { minConf: 80, maxConf: 90,  mult: 1.0 },  // 80-90 → 1x
      { minConf: 90, maxConf: 101, mult: 1.5 },  // 90+   → 1.5x (capped at maxDeployAmount)
    ],
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    // Signal-mode mcap band — used by signal-parser.js, NOT pool discovery.
    // Signals discover earlier-stage opportunities; pool-screen keeps conservative 150k floor.
    signalMinMcap:     u.signalMinMcap     ?? 5_000,
    signalMaxMcap:     u.signalMaxMcap     ?? 80_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    useSolscanTrending: u.useSolscanTrending ?? false, // Phase D: Birdeye/Solscan trending source
    solscanTrendingMode: u.solscanTrendingMode ?? "merge", // merge | only
    usePumpfunGraduated: u.usePumpfunGraduated ?? false, // Phase B: pump.fun graduated-token source
    pumpfunGraduatedMode: u.pumpfunGraduatedMode ?? "merge", // merge | only
    pumpfunMaxGraduationAgeHours: u.pumpfunMaxGraduationAgeHours ?? 48, // only tokens graduated within this window
    requireMultiSourceConfirm: u.requireMultiSourceConfirm ?? false, // Phase G: live hard gate — reject single-source pools (default OFF = soft bonus only)
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxSniperPct:      u.maxSniperPct      ?? 0.5, // max sniper holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? 24,  // skip rug-heavy <24h tokens (Cassiopeia gate)
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? 720, // 30d — skip stale tokens (Cassiopeia gate)
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    // ─── Cassiopeia Rug-Protection Base Gates (always-on, fail-closed) ───
    // Universal rug protection — fire in BOTH paper and live. Per anti-pattern #2,
    // missing authority data = REJECT (never default to safe). Each toggle-able.
    requireMintRenounced:   u.requireMintRenounced   ?? true,  // REJECT unless audit.mint_disabled === true
    requireFreezeRenounced: u.requireFreezeRenounced ?? true,  // REJECT unless audit.freeze_disabled === true
    rejectRugpullFlag:      u.rejectRugpullFlag      ?? true,  // REJECT when OKX is_rugpull === true (isLiquidityRemoval)
    // dev_sold_all demotion — was a hard live-reject (false-positive: blocked SQUIRE +8%).
    // When true (default), dev_sold_all only rejects if compounded with high top10
    // concentration (>maxTop10Pct). When false, reverts to legacy hard live-reject.
    devSoldAllRequiresHighConcentration: u.devSoldAllRequiresHighConcentration ?? true,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    // Vega Item 2A — trailing trigger lowered 40→18, drop tightened 10→6.
    // Rationale: at 40% almost no pump armed the trail (most peak <40% then
    // give it back). 18% arms on realistic pumps; 6% drop locks gains tighter
    // once armed. Reversibility: restore 40/10 in user-config.json to revert.
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 18,   // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 6,    // close when drops X% from peak
    // Vega Item 2B — Partial TP scale-out. At peak +partialTpTriggerPct, pull
    // partialTpPct% of liquidity (bps via removeLiquidity, shouldClaimAndClose:
    // false → account stays open, rest runs with trailing). Fires ONCE per
    // position (partial_tp_done flag in state.js / paper-trades.js).
    // Reversibility: partialTpEnabled=false → silent revert (no partial path).
    partialTpEnabled:      u.partialTpEnabled      ?? true,
    partialTpTriggerPct:   u.partialTpTriggerPct   ?? 15,   // peak PnL that arms partial scale-out
    partialTpPct:          u.partialTpPct          ?? 50,   // % of position to pull (→ bps = pct*100)
    // Vega Item 6 — Velocity-drop exit. If position in profit AND 1h price
    // change < -velocityDropPct AND net_buyers_1h < 0 → exit (momentum reversal
    // captured BEFORE trailing drop fully materializes). Precedence: after
    // partial TP, before OOR. Reversibility: velocityExitEnabled=false → revert.
    velocityExitEnabled:   u.velocityExitEnabled   ?? true,
    velocityDropPct:       u.velocityDropPct       ?? 15,   // 1h price drop magnitude that triggers exit
    // Vega Item 9 — Rebalance-on-OOR (instead of hard close) for high-organic
    // tokens (organic >= rebalanceOnOorMinOrganic). DEFAULT OFF — too risky for
    // same-day live (re-center = extra TXs, slippage, IL realization). Behind
    // flag pending more design. When OFF, OOR → legacy hard close (no change).
    rebalanceOnOorEnabled: u.rebalanceOnOorEnabled ?? false,
    rebalanceOnOorMinOrganic: u.rebalanceOnOorMinOrganic ?? 80,
    // Andromeda PR-A — max-drawdown-recovery exit (paper-trades.js).
    // ARM when max_drawdown (peak−trough) >= armPct; FIRE when current pnl
    // recovers deltaPct above trough. Distinct from trailing TP, which gates
    // on peak >= trailingTriggerPct. Toggle internalAgents.drawdownRecoveryEnabled.
    drawdownRecoveryArmPct:  u.drawdownRecoveryArmPct  ?? 10,  // require >= X% drawdown before arming
    drawdownRecoveryDeltaPct: u.drawdownRecoveryDeltaPct ?? 5, // close after X% recovery from trough
    // Andromeda X2 — Max-hold-time forced exit (paper-trades.js).
    // Time-based forced close: a paper trade older than maxHoldMinutes is force-
    // closed regardless of PnL/OOR. Highest precedence in evaluatePaperExit so
    // SL/TP/Trailing/DD_RECOVERY cannot delay an exit past the holding window.
    // Reversibility: set to 0 → silent revert to legacy (no time-based gate).
    maxHoldMinutes:        u.maxHoldMinutes        ?? 720,    // 12h forced exit default
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "xiaomi/mimo-v2-omni",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "xiaomi/mimo-v2-pro",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "xiaomi/mimo-v2-omni",
    routing: u.llmRouting ?? null,
  },

  // ─── Internal Multi-Agents (Orion judge, Andromeda planner) ──
  internalAgents: {
    orionEnabled:    u.internalAgents?.orionEnabled    ?? true,
    andromedaEnabled: u.internalAgents?.andromedaEnabled ?? false,
    // Sirius — signal enrichment pipeline (fills mcap/vol/tvl from live APIs
    // before Cassiopeia gate). Default ON; toggle false to revert to parse-only.
    enricherEnabled: u.internalAgents?.enricherEnabled ?? true,
    // Cassiopeia 👁️ — enriched-profile scoring for Telegram/KOL bare-CA signals.
    // Default ON (Phase 1 unblock). Toggle false for emergency rollback to
    // Discord-LP-only scoring (vol5m + distributedSol gated path).
    useEnrichedScoring: u.internalAgents?.useEnrichedScoring ?? true,
    // PR-B — feed paper-trade closes into lessons.recordPerformance so Phase 0
    // (DRY_RUN) actually populates the learning loop. Default ON; flip false
    // for emergency rollback to forensic-only paper closes.
    paperFeedsLessons: u.internalAgents?.paperFeedsLessons ?? true,
    // PR-A — Andromeda max-drawdown-recovery exit (paper-trades.js).
    // Default ON; flip false for silent revert to legacy exit precedence
    // (SL → TP → TRAILING_TP → OOR, no DRAWDOWN_RECOVERY).
    drawdownRecoveryEnabled: u.internalAgents?.drawdownRecoveryEnabled ?? true,
    // Vega X1 — Fresh snapshot guard before deploy_position. Re-fetches
    // pool metrics and aborts on material drift (volume drop >50%, vol≤0,
    // bot_pct surge, top10>60%, dev_sold_all flip). Default ON; flip false
    // for emergency rollback. Single boolean, fully reversible.
    freshSnapshotGuardEnabled: u.internalAgents?.freshSnapshotGuardEnabled ?? true,
    // Vega PR-3 — Deterministic deploy after Orion ENTER verdict. When ON,
    // skips the fat SCREENER agentLoop and invokes deploy_position directly
    // with deterministic params (bins_below formula + computeDeployAmount +
    // config.strategy). Default OFF — Bro Dikta enables manually after
    // paper-trade equivalence is confirmed. Toggle false to revert silently
    // to legacy LLM-driven SCREENER path; no other config change needed.
    vegaDeterministicDeploy: u.internalAgents?.vegaDeterministicDeploy ?? false,
    // Andromeda PR-4 — Deterministic manager. When ON, the management cycle
    // skips the MANAGER agentLoop LLM call entirely and dispatches
    // close_position / claim_fees directly through executeTool. SL/TP/
    // Trailing/OOR/DRAWDOWN_RECOVERY/MAX_HOLD logic is unchanged — it
    // already lives in state.js + paper-trades.js. Default OFF — Bro Dikta
    // enables manually after live-equivalence is confirmed. Toggle false
    // to revert silently to legacy LLM-driven MANAGER path. INSTRUCTION-
    // bearing positions are deferred (logged, not auto-closed) when this
    // path is active — operator must intervene or re-enable the LLM path.
    managerDeterministic: u.internalAgents?.managerDeterministic ?? false,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    enabled: u.hiveMindEnabled ?? false,
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  // ─── Telegram Notification Mode ────────
  // Executive mode silences per-cycle/per-signal/per-paper-deploy spam.
  // KEEPS: daily boss-report, morning briefing, circuit breaker, big-PnL paper
  // closes (|PnL| >= bigPnlThresholdPct). Flip executiveMode=false for legacy
  // verbose behavior — every gate is a single boolean check, fully reversible.
  telegram: {
    executiveMode:        u.telegramExecutiveMode        ?? true,
    bigPnlThresholdPct:   u.telegramBigPnlThresholdPct   ?? 15,
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Vega Item 7 — Dynamic deploy sizing by Orion confidence.
 *
 * Multiplies the base deploy amount by a confidence-tiered factor, then
 * HARD-CAPS at maxDeployAmount. This is the BELT. The executor's
 * `amountY > config.risk.maxDeployAmount` reject is the SUSPENDERS — the two
 * are independent, so a bug in either layer cannot produce an oversize deploy.
 *
 * INVARIANT (proven by test): for ALL confidence values and ALL base amounts,
 *   computeDynamicDeployAmount(base, conf) <= maxDeployAmount.
 *
 * @param {number} baseAmount - base deploy amount (from computeDeployAmount)
 * @param {number} confidence - Orion confidence 0-100
 * @param {object} cfg - config (test seam; defaults to live config)
 * @returns {number} sized amount, never exceeding maxDeployAmount
 */
export function computeDynamicDeployAmount(baseAmount, confidence, cfg = config) {
  const ceil = Number(cfg?.risk?.maxDeployAmount ?? 0);
  const base = Number(baseAmount);
  if (!Number.isFinite(base) || base <= 0) return 0;

  // Disabled → fixed base (still capped at ceil — never trust caller).
  if (cfg?.risk?.dynamicSizingEnabled === false) {
    const fixed = ceil > 0 ? Math.min(base, ceil) : base;
    return parseFloat(fixed.toFixed(2));
  }

  const conf = Number(confidence);
  const tiers = Array.isArray(cfg?.risk?.sizingTiers) ? cfg.risk.sizingTiers : [];
  // First matching [minConf, maxConf) tier wins. No match (e.g. conf < lowest
  // tier floor) → mult 1.0 (treat as base; the deploy still has to clear
  // Orion's own confidence floor upstream, so this is conservative).
  let mult = 1.0;
  if (Number.isFinite(conf)) {
    for (const t of tiers) {
      const lo = Number(t?.minConf);
      const hi = Number(t?.maxConf);
      const m  = Number(t?.mult);
      if (Number.isFinite(lo) && Number.isFinite(hi) && Number.isFinite(m) && conf >= lo && conf < hi) {
        mult = m;
        break;
      }
    }
  }

  const sized = base * mult;
  // BELT — hard cap. ceil<=0 means "no cap configured" (defensive; live always >0).
  const capped = ceil > 0 ? Math.min(sized, ceil) : sized;
  return parseFloat(Math.max(0, capped).toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.signalMinMcap  != null) s.signalMinMcap  = fresh.signalMinMcap;
    if (fresh.signalMaxMcap  != null) s.signalMaxMcap  = fresh.signalMaxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxSniperPct      != null) s.maxSniperPct     = fresh.maxSniperPct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
