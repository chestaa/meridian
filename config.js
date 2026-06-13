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
    // Intel adoption — modest floor bump toward the fee/TVL "king" line (0.20)
    // WITHOUT hard-gating it. Base default 0.05→0.06 (paper headroom kept); live
    // overlay carries 0.10 (was 0.08). High fee/TVL is rewarded via the
    // feeTvlHighBonus SCORE BONUS, not a punishing 0.20 reject floor (dormancy).
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.06,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    // Quote-organic floor — default 0 (gate effectively off). The quote token is
    // always a blue-chip (wSOL/USDC) for this single-side-SOL bot, with no
    // meaningful organic score; quoteOrganicGateRejectReason() also EXEMPTS those
    // mints, so even a non-zero floor never rejects a blue-chip-quoted pool. A
    // non-zero floor only gates exotic non-blue-chip quotes (defense in depth).
    minQuoteOrganic:   u.minQuoteOrganic   ?? 0,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    // Signal-mode mcap band — used by signal-parser.js + backtest-harness, NOT pool discovery.
    // Widened 2026-06-11 (Bro-authorized opt Y) from 5k-80k → 50k-2M. The old 80k ceiling
    // rejected the actual quality DLMM zone (yunus SOL-USDC $100k-1M, PARQ $922k, Jotchua
    // $3.6M). Floor RAISED 5k→50k (sub-50k = degen/rug/thin zone, blind-scanner historically
    // leaked bad picks there). Ceiling 80k→2M covers the documented quality cluster with PARQ
    // inside; capped at 2M (NOT 3.6M) — late-stage large-cap is native discovery's job
    // (minMcap 150k-10M). Signal band stays intentionally distinct: floor BELOW native (earlier
    // entry justified by alpha), ceiling BELOW native (single-signal bets avoid late-stage thin
    // fee velocity). Old dead zone (80k<150k, nobody covered) now CLOSED — bands overlap 150k-2M.
    // WIDENING MCAP DOES NOT LOOSEN ANY OTHER GATE — rug/bot/top10/holders/fee-TVL/organic/
    // TVL-MC/volatility are separately keyed and stay strict. Mcap band only sets pool SIZE.
    signalMinMcap:     u.signalMinMcap     ?? 50_000,
    signalMaxMcap:     u.signalMaxMcap     ?? 2_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    // Cassiopeia 2026-06-13 — maxBinStep 125→200. Orion research + Cassiopeia live
    // probe: memecoin DLMM pools cluster at bin_step 80/100/125/200 (the 126-200 band
    // held 87/1000 broad pools, ~8.7%). Base fee scales LINEARLY with bin_step
    // (baseFactor*binStep/1e6) so a 200-bps pool earns ~1.6x the fee-per-crossing of a
    // 125-bps pool — meaningful fee capture on the same volume. Deploy-side safe: the
    // bins_below formula clamps to [35,69] INDEPENDENT of bin_step, and a wider bin =
    // wider price tolerance per bin = LESS OOR churn, not more. Quality gates unchanged
    // (most 126-200 pools still fail organic/fee-TVL on merit). Reversible: set 125.
    maxBinStep:        u.maxBinStep        ?? 200,
    // Cassiopeia 2026-06-13 — timeframe 5m→1h (ROOT-CAUSE BOTTLENECK FIX, NOT a gate
    // loosening). Live probe vs the broad set: at timeframe=5m, 271/300 pools read
    // volume=0 and 266/300 read fee/TVL=0 — the 5m window is structurally EMPTY (no
    // trade in the last 5 min for the vast majority), so the volume gate (minVolume
    // 500) and fee/TVL gate rejected fee-GENERATING pools on a stale-window artifact
    // (the same class as the RICH-SOL volatility miss, but volume/fee/TVL have no
    // refetch-rescue). The dominant reject was volume_below_min at 59.4% — a DATA
    // shape, not low quality. At 1h only 26/300 read zero; the raw gate passes 1→15
    // pools (14 deployable after sol-quote) with EVERY quality threshold byte-identical
    // (organic 60, holders 500, fee/TVL, mcap band, rug/bot/top10 all unchanged —
    // counterfactuals proved loosening them unlocks ~nothing; they are NOT the binding
    // constraint). 1h (not 24h) chosen to preserve the magnitude the minVolume/fee-TVL
    // thresholds were tuned for; volatility is insulated (read at a 30m floor via
    // getVolatilityTimeframe regardless). Reversible: set "5m".
    timeframe:         u.timeframe         ?? "1h",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 15,  // global fees paid (priority+jito tips). below = bundled/scam. recalibrated 30→15 for low-cap target (now 50k-2M signal band, was $5-80k; 15 SOL floor still appropriate at the lower end of the widened band)
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    discordSource: u.discordSource ?? "meteoraidn_ranked", // meteoraidn_ranked (real local) | hivemind (legacy 404 phantom)
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
    minTokenAgeHours:   u.minTokenAgeHours   ?? 12,  // intel: catch 12-48h sweet-spot START (was 24; rug-heavy <12h still skipped). user-config may lower further (currently 8).
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
    // ─── Item 2 (yunus screen) — TVL/MC ratio gate (LIVE-ONLY) ───
    // @0xyunss + community (71% win backtest): smaller TVL/MC → thinner liquidity
    // vs cap → tighter active range → better fee capture. Reject pools whose
    // tvl/mcap exceeds maxTvlMcapRatio. Fires ONLY when dryRun===false (paper
    // unaffected). FAIL-SAFE: missing/zero mcap or tvl → reject (anti-pattern #2).
    // Reject reasons: tvl_mcap_ratio_too_high, tvl_mcap_ratio_unknown.
    tvlMcapGateEnabled: u.tvlMcapGateEnabled ?? true,
    maxTvlMcapRatio:    u.maxTvlMcapRatio    ?? 0.2,
    // ─── Enrich-before-gate for the holder floor (Cassiopeia) ───
    // Signal pools (discord/solscan/pumpfun) often arrive with holders null/0
    // because the source didn't carry the field — DATA-MISSING, not a real low
    // count. When true, fetch the real holder count (assets/search holderCount,
    // cached) for pools that clear every OTHER cheap gate, so the floor judges a
    // REAL number. Floor (minHolders) is UNCHANGED. NOT a bypass: enrich failure
    // → holders stays null → gate rejects "holders_unknown" (fail-closed,
    // anti-pattern #2). Set false to restore legacy hard-reject-on-missing.
    enrichHolderCountBeforeGate: u.enrichHolderCountBeforeGate ?? true,
    // ─── Enrich-before-gate for the volatility + organic structural gaps (Cassiopeia) ───
    // Cross-ref signal pools (discord/solscan/pumpfun via dlmm.datapi.meteora.ag)
    // arrive WITHOUT volatility + organic_score — those fields are a STRUCTURAL GAP
    // on the cross-ref endpoint (they don't exist there; a 0 read = DATA-MISSING, not
    // a real low score). When true, fetch the NATIVE Pool-Discovery detail once per
    // pool (by pool_address, cached) for survivors of every other cheap gate, filling
    // volatility + organic (+ fee/age/mcap) so the gates judge REAL numbers. minOrganic
    // is UNCHANGED. NOT a bypass: enrich failure → field stays null → gate rejects
    // "volatility_unknown" / "organic_unknown" (fail-closed, anti-pattern #2). Set
    // false to restore legacy hard-reject-on-missing for cross-ref pools.
    enrichNativeDetailBeforeGate: u.enrichNativeDetailBeforeGate ?? true,
    // ─── Broad discovery — server→client gate migration (Cassiopeia, CROWN JEWEL) ───
    // ROOT CAUSE (Sirius, verified live): we sent EVERY strict gate (organic>=60,
    // fee/TVL, binStep, mcap band, holders, age, ...) to the Pool-Discovery server as
    // filter_by params, so the server cut the 114k-pool universe down to ~3 BEFORE we
    // ever saw a candidate. We were "playing 5 pools out of millions." Pagination on
    // that API is broken (page/offset ignored) — page_size is the only lever, ceiling
    // 1000 (we used 50 = 20x headroom thrown away).
    //
    // FIX (NOT a loosening): when broadDiscoveryEnabled, send ONLY a WIDE cheap server
    // pre-filter (pool_type=dlmm + critical-warning sanity flags + a WIDE mcap band +
    // a low tvl floor) and a free server pre-sort (fee_active_tvl_ratio:desc), pull up
    // to broadDiscoveryPageSize pools, then run the IDENTICAL strict client gate
    // (getRawPoolScreeningRejectReason) on the broad set. The gate is byte-identical;
    // ONLY the evaluation LOCATION moved (server→client) so we LOOK AT more candidates.
    // The broad server bounds are deliberately WIDER than the strict client thresholds
    // (broadMcapFloor <= minMcap, broadMcapCeil >= maxMcap, broadMinTvl <= minTvl), so
    // the server can NEVER reject a pool the strict client gate would have passed —
    // the broad filter is a strict SUPERSET of what survives the client gate.
    // Set broadDiscoveryEnabled=false → legacy strict-server-filter behavior (fully
    // reversible). Cost-control: enrich-before-gate passes are probe-gated against the
    // STRICT thresholds (a pool failing strict mcap/organic/fee-TVL is dropped from the
    // enrich set for free), and getTopCandidates pre-ranks + slices to `limit` BEFORE
    // any per-pool enrichment (PVP/Jupiter audit/OKX) → enrichment + judge cost FLAT.
    broadDiscoveryEnabled:   u.broadDiscoveryEnabled   ?? true,
    broadDiscoveryPageSize:  u.broadDiscoveryPageSize  ?? 1000,   // API ceiling; broken pagination makes this the only breadth lever
    broadMcapFloor:          u.broadMcapFloor          ?? 10_000, // WIDE — well below strict minMcap (150k native / 50k signal). Server sanity floor only; strict mcap gate runs client-side.
    broadMcapCeil:           u.broadMcapCeil           ?? 50_000_000, // WIDE — above strict maxMcap (10M). Strict ceil runs client-side.
    broadMinTvl:             u.broadMinTvl             ?? 1_000,  // WIDE — below strict minTvl (10k). Strict tvl floor runs client-side.
    broadSortBy:             u.broadSortBy             ?? "fee_active_tvl_ratio:desc", // free server pre-sort: if page_size clips, the highest fee/TVL pools are pulled first
    // ─── Item (a) Fee-Gen-Token signal — balanced two-sided flow (SCORE BONUS ONLY) ───
    // NEVER a gate (dormancy risk — a one-sided pump can still be a fine LP).
    // Pool Discovery API exposes NO per-side fee field (verified live: only aggregate
    // fee/avg_fee/fee_pct/dynamic_fee_pct). PROXY: buy/sell volume symmetry. A pool with
    // balanced buy/sell flow (ratio in [0.4,0.6] of total) churns both directions →
    // crosses the active bin repeatedly → generates fees on each swap (vs a one-sided
    // drift that parks price at one edge). Awards feeGenSymmetryWeight when buy/(buy+sell)
    // sits in the balanced band. FAIL-SAFE (anti-pattern #2): missing/zero side volume →
    // 0 bonus (NEUTRAL, never penalize). Default OFF (opt-in).
    feeGenSymmetryBonusEnabled: u.feeGenSymmetryBonusEnabled ?? false,
    feeGenSymmetryWeight:       u.feeGenSymmetryWeight       ?? 300,
    // ─── Intel adoption — fee/TVL HIGH-PREFERENCE score bonus (NEVER a gate) ───
    // Community/yunus: "24h fee/TVL is KING, below ~20% doesn't cover IL." The
    // literal advice = hard floor 0.20. We REFUSE to hard-gate 0.20 (we already
    // had 0-deploy days at a 0.08 floor → 0.20 = permanent dormancy; yunus runs
    // more sources/volume than us). We adopt the INSIGHT as a RANKING preference:
    // linear ramp from feeTvlHighBonusFloor (0.10) to feeTvlHighBonusTarget (0.20,
    // the "king" line), full weight at/above target. The actual reject floor stays
    // modest (minFeeActiveTvlRatio — base 0.06, live overlay 0.10). FAIL-SAFE
    // (anti-pattern #2): missing fee/TVL → 0 bonus (NEUTRAL, never penalize/reject).
    // Default OFF (opt-in — Bro Dikta enables after paper-soak).
    feeTvlHighBonusEnabled: u.feeTvlHighBonusEnabled ?? false,
    feeTvlHighBonusWeight:  u.feeTvlHighBonusWeight  ?? 250,
    feeTvlHighBonusFloor:   u.feeTvlHighBonusFloor   ?? 0.10,
    feeTvlHighBonusTarget:  u.feeTvlHighBonusTarget  ?? 0.20,
    // ─── Intel adoption — token-age SWEET-SPOT score bonus (NEVER a gate) ───
    // Community: token-age sweet spot ~12-48h. The literal advice = REPLACE our
    // 24-720h band with 12-48h. We REFUSE to slash maxTokenAgeHours to 48 (would
    // reject every mature pool → mass dormancy). Instead: soft-PREFER pools in the
    // [12,48]h band via flat full-weight bonus; mature pools get no age credit but
    // still deploy. (Note: minTokenAgeHours hard floor already catches fresher
    // pools — user-config currently 8h.) FAIL-SAFE (anti-pattern #2): missing age
    // → 0 bonus (NEUTRAL). Default OFF (opt-in).
    tokenAgeSweetSpotBonusEnabled: u.tokenAgeSweetSpotBonusEnabled ?? false,
    tokenAgeSweetSpotWeight:       u.tokenAgeSweetSpotWeight       ?? 200,
    tokenAgeSweetSpotLowHours:     u.tokenAgeSweetSpotLowHours      ?? 12,
    tokenAgeSweetSpotHighHours:    u.tokenAgeSweetSpotHighHours     ?? 48,
    // ─── Deployability pre-filter (Cassiopeia, Lyra cost-cut) — NOT a risk gate ───
    // This bot deploys single-side SOL ONLY (executor.js refuses amount_x>0). Pools
    // quoted in anything but wSOL (USDC etc.) are UNDEPLOYABLE — judged then refused
    // at deploy. Pure SCREENER+enrichment waste (Lyra: ~17% of candidates, e.g.
    // GACHA-USDC, AVICI-USDC). When true (default — we ARE SOL-only), reject non-SOL
    // -quoted pools BEFORE enrichment AND the LLM judge. BASE filter (paper+live).
    // FAIL-SAFE: missing quote mint → reject (anti-pattern #2). Reject reason:
    // non_sol_quote_undeployable. Set false to disable (no filter).
    requireSolQuote: u.requireSolQuote ?? true,
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
    // Vega Item 9 — anti-churn cap. A position may re-center on OOR at most
    // maxRebalances times; once hit, OOR → hard close (state.js falls through).
    // Each re-center is 3 tx + slippage, so unbounded churn would bleed the
    // wallet. Default 3.
    maxRebalances:         u.maxRebalances         ?? 3,
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
    // ─── PIECE 2 — Meaningful-profit reporting bar (Lyra + Orion) ───
    // REPORTING THRESHOLD ONLY — does NOT touch exit/close/money logic. A closed
    // trade whose TRUE realized SOL delta (net of IL + slippage + gas, NOT
    // LP-only PnL) is below this is NOISE: gas + IL ate it, so it is NOT counted
    // a "win" in the honest win-rate. Answers Bro's "$0.001 dianggap profit"
    // complaint. Tiers (realized SOL): NOISE < 0.005, MARGINAL 0.005-0.02,
    // REAL >= 0.02, MEANINGFUL >= 0.05. Reloadable. ~$0.75 at 150 SOL/USD.
    minMeaningfulProfitSol: u.minMeaningfulProfitSol ?? 0.005,
  },

  // ─── DAMM v2 Idle-Reserve Parking (item 8, BRAND NEW — flag OFF) ──
  // Vega owns this money path. Park ONLY idle SOL (above gasReserve + active-LP
  // headroom) into a Meteora DAMM v2 fee-compounding pool to earn yield on
  // un-deployed capital. SEPARATE from DLMM LP — does not touch deploy_position,
  // close_position, swap_token, maxDeployAmount, maxPositions, or DRY_RUN.
  //
  // STRICT defaults (brand-new = paranoid):
  //   enabled       — DEFAULT FALSE. Live activation is VETO'd until SDK
  //                   installed + Bro explicit gate. Flag flip alone is NOT
  //                   sufficient; the module also hard-requires the SDK present
  //                   and DRY_RUN===false at call time.
  //   maxParkSol    — HARDCAP. The module NEVER parks more than this in one call
  //                   nor leaves more than this parked. Clamp, never throw-to-park.
  //   poolAddress   — curated SOL-stable DAMM v2 pool. null = no pool = no park
  //                   (fail-safe: unset pool means parking is impossible).
  //   minIdleToPark — don't bother parking dust; require at least this much idle
  //                   SOL above all reserves before a park is attempted.
  damm: {
    enabled:        u.dammV2Enabled        ?? false,
    maxParkSol:     u.dammV2MaxParkSol      ?? 0.3,
    poolAddress:    u.dammV2PoolAddress     ?? null,
    minIdleToPark:  u.dammV2MinIdleToPark   ?? 0.1,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    // ── Item (b) — Volume-regime strategy spread (Andromeda plan) ──
    // When enabled AND no explicit strategy is passed, pickRegimeStrategy()
    // chooses spot (HIGH volume → tight fee capture) vs bid_ask (LOW volume →
    // catch volatility). Default OFF — Bro Dikta enables manually after
    // paper-soak. LLM/manual strategy override always wins. Volatility guard
    // (Andromeda risk): a high-volatility pool is NEVER assigned spot —
    // spot on a volatile pool = instant OOR + IL. Fail-safe: bad/missing
    // volume → fall back to config.strategy.strategy (no silent flip).
    volumeRegimeEnabled:      u.volumeRegimeEnabled      ?? false,
    volumeRegimeHighThreshold: u.volumeRegimeHighThreshold ?? 50000,
    volumeRegimeMaxVolForSpot: u.volumeRegimeMaxVolForSpot ?? 3,
    // ── Item 1 — "Fast bid-ask bonus stage" (intel @bengsharksol) ──
    // Narrow OVERRIDE layered on top of the volume-regime picker: when a pool
    // is FRESH (token_age_hours <= fastBidAskMaxAgeHours) AND volatile
    // (volatility >= fastBidAskMinVolatility), force `bid_ask` so the position
    // sits edge-weighted to catch the early/bonus-stage volatility burst.
    // HONEST SCOPE: the Meteora SDK has NO custom per-bin weight — StrategyType
    // .BidAsk *is* the edge-weighted shape. So this is a TIMING override, not a
    // new distribution. It only changes anything when the regime picker would
    // otherwise have chosen `spot` (high-volume fresh pool) — exactly the case
    // where spot gets shredded by a bonus-stage pump. Default OFF — opt-in.
    // FAIL-SAFE: missing/zero/non-finite age or volatility → no override
    // (defer to regime picker; never silently flip).
    fastBidAskBonusEnabled:  u.fastBidAskBonusEnabled  ?? false,
    fastBidAskMaxAgeHours:   u.fastBidAskMaxAgeHours   ?? 24,
    fastBidAskMinVolatility: u.fastBidAskMinVolatility ?? 3,
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
    // Orion cost fix (2026-06-01) — screening is lookup-heavy (candidates pre-loaded,
    // active_bin pre-fetched); it needs at most pick→deploy→ack. A dedicated, lower cap
    // bounds runaway/stall loops on the 97%-cost SCREENER without touching MANAGER/GENERAL.
    screeningMaxSteps: u.screeningMaxSteps ?? 8,
    // Orion cost fix (2026-06-01) — cap how many scored candidates are rendered into the
    // SCREENER goal. Trims the dominant prompt-token driver; reporting still sees all.
    screeningPromptCandidateCap: u.screeningPromptCandidateCap ?? 5,
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
    // Vega fix #1 — TRUE realized SOL delta accounting. When ON, every closed
    // position/trade record carries realized_sol_delta + realized_sol_delta_pct
    // (economic outcome incl. IL + close-swap slippage + gas) ALONGSIDE the
    // existing price-only lp_pnl_pct. Pure accounting/reporting — does NOT change
    // any deploy/close behavior, TX, DRY_RUN, or risk constant. Default ON; flip
    // false for silent revert to lp_pnl-only reporting. See realized-sol.js.
    realizedSolAccounting: u.internalAgents?.realizedSolAccounting ?? true,
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
    if (fresh.discordSource != null) s.discordSource = fresh.discordSource;
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
    if (fresh.tvlMcapGateEnabled !== undefined) s.tvlMcapGateEnabled = fresh.tvlMcapGateEnabled;
    if (fresh.maxTvlMcapRatio    != null) s.maxTvlMcapRatio = fresh.maxTvlMcapRatio;
    if (fresh.enrichHolderCountBeforeGate !== undefined) s.enrichHolderCountBeforeGate = fresh.enrichHolderCountBeforeGate;
    if (fresh.enrichNativeDetailBeforeGate !== undefined) s.enrichNativeDetailBeforeGate = fresh.enrichNativeDetailBeforeGate;
    if (fresh.broadDiscoveryEnabled  !== undefined) s.broadDiscoveryEnabled  = fresh.broadDiscoveryEnabled;
    if (fresh.broadDiscoveryPageSize != null) s.broadDiscoveryPageSize = fresh.broadDiscoveryPageSize;
    if (fresh.broadMcapFloor != null) s.broadMcapFloor = fresh.broadMcapFloor;
    if (fresh.broadMcapCeil  != null) s.broadMcapCeil  = fresh.broadMcapCeil;
    if (fresh.broadMinTvl    != null) s.broadMinTvl    = fresh.broadMinTvl;
    if (fresh.broadSortBy    != null) s.broadSortBy    = fresh.broadSortBy;
    if (fresh.feeGenSymmetryBonusEnabled !== undefined) s.feeGenSymmetryBonusEnabled = fresh.feeGenSymmetryBonusEnabled;
    if (fresh.feeGenSymmetryWeight != null) s.feeGenSymmetryWeight = fresh.feeGenSymmetryWeight;
    if (fresh.feeTvlHighBonusEnabled !== undefined) s.feeTvlHighBonusEnabled = fresh.feeTvlHighBonusEnabled;
    if (fresh.feeTvlHighBonusWeight != null) s.feeTvlHighBonusWeight = fresh.feeTvlHighBonusWeight;
    if (fresh.feeTvlHighBonusFloor  != null) s.feeTvlHighBonusFloor  = fresh.feeTvlHighBonusFloor;
    if (fresh.feeTvlHighBonusTarget != null) s.feeTvlHighBonusTarget = fresh.feeTvlHighBonusTarget;
    if (fresh.tokenAgeSweetSpotBonusEnabled !== undefined) s.tokenAgeSweetSpotBonusEnabled = fresh.tokenAgeSweetSpotBonusEnabled;
    if (fresh.tokenAgeSweetSpotWeight    != null) s.tokenAgeSweetSpotWeight    = fresh.tokenAgeSweetSpotWeight;
    if (fresh.tokenAgeSweetSpotLowHours  != null) s.tokenAgeSweetSpotLowHours  = fresh.tokenAgeSweetSpotLowHours;
    if (fresh.tokenAgeSweetSpotHighHours != null) s.tokenAgeSweetSpotHighHours = fresh.tokenAgeSweetSpotHighHours;
    if (fresh.requireSolQuote     !== undefined) s.requireSolQuote = fresh.requireSolQuote;
    if (fresh.minMeaningfulProfitSol != null) config.management.minMeaningfulProfitSol = fresh.minMeaningfulProfitSol;
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
