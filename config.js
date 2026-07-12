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
    // ── Bluechip per-position SOL cap (Vega — Opsi B, money-path) ──
    // SEPARATE hard cap for bluechip deploys, INDEPENDENT of memecoin maxDeployAmount.
    // Default 0.45 SOL — deliberately conservative + equal to current memecoin sizing,
    // NOT auto-raised: bluechip carries lower IL risk, but a wider range parks more
    // notional per bin, so we do NOT loosen the cap without an explicit Bro decision.
    // dlmm.js also pins a hardcoded MAX_BLUECHIP_POSITION_SOL belt — config can only
    // TIGHTEN below it, never exceed it (the deploy money path takes the min of both).
    maxBluechipPositionSol: numericConfig(u.maxBluechipPositionSol) ?? 0.45,
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
    // ── Auto-compound sizing (Vega, money-path) ──────────────────────────────
    // When ON, computeDeployAmount lets the position scale with the wallet:
    // deployable (= wallet − gasReserve) × positionSizePct, clamped between
    // deployAmountSol (floor) and maxDeployAmount (ceiling). As profit grows the
    // wallet, deployable grows, so the position grows — until a bound binds.
    // Symmetric: after a loss the wallet shrinks, deployable shrinks, the next
    // position shrinks (auto de-risk). This is compounding in BOTH directions.
    //
    // The flag only GOVERNS THE BOUNDS, never disables them: with the flag OFF
    // computeDeployAmount returns the fixed floor (legacy behavior, fully
    // reversible). With the flag ON the two extra anti-over-leverage bounds below
    // apply ON TOP of the floor/ceiling clamp.
    autoCompoundEnabled: u.autoCompoundEnabled ?? false,
    // Concentration cap: a single position may never exceed this fraction of the
    // TOTAL wallet (not deployable — total, so the buffer is even more
    // conservative). maxPositions=1 means this fraction IS the single-position
    // exposure. Default 0.60 → at most 60% of wallet in one LP, ≥40% + gas always
    // held back. NEVER auto-raised above 0.70 without an explicit Bro decision.
    maxConcentrationPct: numericConfig(u.maxConcentrationPct) ?? 0.60,
    // Absolute hard ceiling (SOL). A second, hardcoded-default belt INDEPENDENT of
    // the configurable maxDeployAmount: no matter how large the wallet grows or
    // how maxDeployAmount is mis-set, a single auto-compounded position can never
    // exceed this. This is the "unbounded wallet" guard — Bro raises it
    // explicitly when the strategy graduates to larger size. Default 1.0 SOL.
    autoCompoundHardCeilingSol: numericConfig(u.autoCompoundHardCeilingSol) ?? 1.0,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    // IL-coverage floor (Cassiopeia, 2026-06-14, evidence-based). yunus thesis:
    // fee/TVL below ~0.20 does not cover IL → LP loses by math (the win-tiny/loss-big
    // asymmetry Bro observed). Live-universe calibration (1h, 1000 dlmm) showed the
    // deployable set is BIMODAL, not floor-hugging: of 11 native-band pools >=0.10,
    // 9 are >=0.15 (82% throughput retained) — the marginal 0.10-0.20 sub-IL zone held
    // only ~3 pools. So raising the floor toward IL-coverage costs ~no throughput while
    // killing the structural loss. user-config sets base 0.13 / live overlay 0.15; the
    // >=0.20 "king" tier is further favored by feeTvlHighBonus. Base DEFAULT stays 0.06
    // as a safety fallback only — the real floor is the user-config overlay (0.13/0.15).
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
    // Cassiopeia 2026-06-16 — volatility FLOOR (NOT a ceiling). Lyra finding on 39
    // REAL trades inverted the prior whipsaw hypothesis: LOW-vol pools are the
    // bleeders, not high-vol. Buckets: vol[0,2.5) EV -$0.41/trade (sum -$4.06,
    // worst), [2.5,3.5) EV -$0.21 (-$2.07), [3.5,4.5) EV +$0.34 (+$3.09, best),
    // [4.5+) EV +$0.20 (+$1.95). Win avg vol 3.99, Loss avg 3.34, SL avg 3.01 —
    // low-vol pools slow-bleed into the stop without ever pumping to a realized win.
    // NO CEILING (4.5+ still EV-positive — zero evidence for an upper bound).
    // FLOOR CHOSEN = 3.0 (NOT the 3.5 Lyra proposed): live anti-dormancy probe
    // (scripts/probe-volatility-floor.js, 1h timeframe, 1000-pool broad page) showed
    // a HARD 3.5 floor cut the full-gate deployable set to 1 pool/page (near-dormancy,
    // 0-deploy-day risk), 3.0 → 2 pools, while killing the catastrophic [0,2.5) bucket
    // (8 of 12 current survivors, Lyra's biggest bleeder). 3.0 trades the mild [2.5,3.5)
    // bleeder for funnel survival — recoverable once Lyra's SL-fix ships. The raw-gate
    // count is a FLOOR; runtime adds more via the vol-rescue + native-detail enrich
    // passes. Base 0 = OFF (safety fallback). user-config sets the real floor (3.0).
    // FAIL-CLOSED (anti-pattern #2): null/missing/0 vol already rejects upstream
    // (volatility_unknown / unusable); this floor adds vol<minVolatility → reject.
    minVolatility:     u.minVolatility     ?? 0,
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
    // ─── H3 edge filter (Cassiopeia, 2026-06-28 — the safety for the memecoin lane) ───
    // Pairs with re-enabling the memecoin DEPLOY lane (bluechipOnlyMode=false). From the
    // 59-real-trade brain analysis ([[project-edge-stoploss-tail-2026-06-28]]): the only
    // losing mechanism is the stop-out TAIL. The 2x2 intersection ftvl∈[0.2,1.0) AND
    // vol≥2.5 flipped the in-sample book −$1.74 → +$9.36, EV +0.32, stop-losses 14→3.
    // STRICTER on quality (a NEW reject), NOT a loosening — the wider lane is paid for by
    // this filter. ftvl≥1.0 = transient spike on thin/just-launched pool (EV −0.50);
    // vol<2.5 = slow-bleed band (EV −0.41). Default OFF (opt-in: Bro enables with the lane).
    // FAIL-CLOSED (anti-pattern #2): missing ftvl OR vol → reject (edge_filter_data_unknown).
    edgeFilterEnabled:     u.edgeFilterEnabled     ?? false,
    // Track-B B1 (Cassiopeia 2026-07-11): floor lowered 0.2 → 0.10 so the data-mode
    // fee/TVL overlay stops being cosmetic and ADMITS [0.10,0.20) pools for density
    // data collection (the feeTvlHighBonus ranking already prefers the denser end
    // inside that band). ftvlMax (1.0) and the vol floor (2.5) are UNCHANGED — this
    // widens the LOW edge of the accepted fee/TVL band only, it is not a safety loosen.
    edgeFilterFtvlMin:     u.edgeFilterFtvlMin     ?? 0.10,
    edgeFilterFtvlMax:     u.edgeFilterFtvlMax     ?? 1.0,
    edgeFilterMinVolatility: u.edgeFilterMinVolatility ?? 2.5,
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
    // 429 ROOT-CAUSE FIX (Cassiopeia, 2026-06-20): TTL (minutes) for the raw
    // broad-discovery page cache in fetchPoolDiscoveryPage. The pool universe is
    // stable over a few minutes, so within-TTL cycles (and the snapshot-verify
    // reuse path) reuse the cached 1000-pool fetch instead of re-hitting Meteora —
    // collapsing the same-cycle / multi-service thundering-herd that drives the
    // chronic 429. 7 min = mid 5-10 band (long enough to dedup the herd, short
    // enough that no deploy rides a stale universe). FAIL-SAFE: miss/expired →
    // fresh fetch; a failed fetch is never cached. Set 0 → cache OFF (reversible).
    // Breadth + quality UNTOUCHED: only the RAW page is cached; the strict client
    // gate, enrichment, and vol-refetch all run fresh on the cached set each cycle.
    broadDiscoveryCacheTtlMin: u.broadDiscoveryCacheTtlMin ?? 7,
    // Per-pool DETAIL cache TTL (minutes) for fetchPoolDiscoveryDetail — hit by the
    // volatility-timeframe fan-out, vol-rescue, native-detail enrich, and snapshot-
    // verify reuse, all on the same endpoint. Shorter than the page TTL (5 min)
    // because detail volatility is the most time-sensitive field. Set 0 → OFF.
    broadDiscoveryDetailCacheTtlMin: u.broadDiscoveryDetailCacheTtlMin ?? 5,
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
    // Track-B B1 (Cassiopeia 2026-07-11): default flipped OFF → TRUE. This is a
    // RANKING bonus only (re-sort in getTopCandidates) — it rejects NOTHING and is
    // funnel-neutral, so turning it on cannot starve deploys. It floats fee-dense
    // pools (toward the 0.20 "king" line) to the top of the cost-flat judge slice.
    feeTvlHighBonusEnabled: u.feeTvlHighBonusEnabled ?? true,
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
    // ─── Market-regime gate (Cassiopeia — STOP BLEED T3) ───
    // ROOT CAUSE of T3 bleed (-$4.67): memecoin narrow-range pools deployed into a
    // FALLING market get stopped out repeatedly (price drifts down out of the active
    // bin → cut at stop → repeat). A single-side-SOL narrow position has an
    // ASYMMETRIC payoff in a downtrend (limited bounce upside, full bleed if it keeps
    // falling). FIX: PAUSE memecoin deploys while the broad market trends down. This
    // is a STRICTER condition (adds a pause) — it does NOT loosen any other gate.
    // Detection: SOL 24h % change (SOL is the beta of the Solana memecoin complex),
    // reusing the boss-report price chain (CoinGecko include_24hr_change → no history
    // store). regime DOWNTREND when SOL 24h <= regimeDowntrendThresholdPct.
    // CONDITIONAL: only memecoin/narrow profiles are paused — blue-chip base tokens
    // (symmetric payoff) are EXEMPT (Phase 1 bluechip mode ready). FAIL-SAFE
    // (anti-pattern #2): regime fetch failure → NEUTRAL (deploy as legacy), NEVER a
    // blind freeze and NEVER a false DOWNTREND. ANTI-DORMANCY: fires ONLY on a
    // confirmed downtrend; releases the moment SOL recovers above the threshold.
    // Reject reason: market_regime_downtrend_memecoin_paused. Reloadable.
    marketRegimeGateEnabled:     u.marketRegimeGateEnabled     ?? true,
    regimeDowntrendThresholdPct: u.regimeDowntrendThresholdPct ?? -5,  // SOL 24h <= -5% = downtrend (pause memecoin)
    regimeUptrendThresholdPct:   u.regimeUptrendThresholdPct   ?? 5,   // SOL 24h >= +5% = uptrend (label only; doesn't gate)
    // ─── Direction gate (Cassiopeia — Track-B B2, 2026-07-11) ───
    // Per-POOL directional guard (vs marketRegimeGate's market-wide SOL beta). A pool
    // whose OWN price is measurably DOWN at entry has an asymmetric single-side-SOL
    // narrow payoff (limited bounce upside, full bleed if it keeps falling) — the same
    // stop-out mechanism marketRegimeGate addresses, but at the pool level. Pauses a
    // deploy when price_change_pct <= directionMaxNegPriceChangePct AND (flow-confirm
    // off OR buy_share below directionMinBuyShare). buy_share = buy_vol/(buy_vol+sell_vol).
    // FAIL-OPEN (directional/QUALITY gate, NOT rug/safety — follows the marketRegimeGate
    // precedent): missing/non-finite price_change_pct → NEUTRAL → deploy as legacy,
    // NEVER a freeze; missing flow (with flow-confirm on) → cannot confirm bearish →
    // deploy. strictNumeric so Number(null)===0 can't fabricate a flat 0% reading. Only
    // rejects on a positively-MEASURED downtrend. Reject reason: direction_downtrend_at_entry.
    // Default OFF (opt-in) — Draco sets directionGateEnabled=true in VPS user-config to
    // activate live. Reloadable.
    directionGateEnabled:          u.directionGateEnabled          ?? false,
    directionMaxNegPriceChangePct: u.directionMaxNegPriceChangePct ?? -4,   // price_change_pct <= -4% = downtrend at entry
    directionRequireFlowConfirm:   u.directionRequireFlowConfirm   ?? true, // true = only pause if OKX buy/sell flow also bearish
    directionMinBuyShare:          u.directionMinBuyShare          ?? 0.40, // buy_share below this (with flow present) = bearish flow
    // ─── Bluechip income-engine dual-mode (Cassiopeia — Wave 2 / Phase 1) ───
    // SEPARATE, PARALLEL path for deep STABLE pools (SOL-USDC, JLP, JitoSOL, LSTs).
    // Default OFF — turning it on needs Bro + Vega (deploy structure: two-sided
    // wide-range) sign-off. When off, every bluechip fn is inert and the memecoin
    // path is byte-for-byte unchanged. The risk profile is INVERTED vs memecoin:
    // bluechip is rug-immune (no rug/mint/freeze/bot/top10 gates), LOW-vol-is-GOOD
    // (volatility CEILING not floor — the memecoin minVolatility 3.0 NEVER applies),
    // large-cap (own mcap band, not the memecoin 50k-2M), and regime-downtrend EXEMPT
    // (symmetric payoff). What it DOES gate: deep TVL, consistent volume, fee-yield,
    // vol-ceiling, large mcap. FAIL-CLOSED (anti-pattern #2): missing input → reject.
    // Live-verified feasibility (2026-06-20): 23 both-leg bluechip pools at TVL>=200k,
    // ~8 with real volume; SOL-USDC alone = 4 deep pools @ 32-75% APR on full TVL.
    bluechipModeEnabled:    u.bluechipModeEnabled    ?? false,   // MASTER flag — Bro+Vega to enable
    bluechipMinTvl:         u.bluechipMinTvl         ?? 200_000, // deep-liquidity floor (income engine = deep pools)
    bluechipMinVolume:      u.bluechipMinVolume      ?? 50_000,  // consistent-flow floor (deep-but-dead protection)
    bluechipMinFeeTvlRatio: u.bluechipMinFeeTvlRatio ?? 0.03,    // ~11% APR on full TVL @ 24h — income bar (LOWER than memecoin 0.13: bluechip IL is far smaller)
    bluechipMinMcap:        u.bluechipMinMcap        ?? 50_000_000, // large-cap confirmation ($50M+); SOL ~$40B, JLP ~$770M
    bluechipMaxVolatility:  u.bluechipMaxVolatility  ?? 1.5,     // vol CEILING (not floor) — wild reading = not actually stable / de-peg
    // Broad-discovery mcap ceiling raised ONLY when bluechip mode is on: the memecoin
    // broadMcapCeil (50M) would drop SOL-USDC (SOL ~$40B) at the SERVER before the
    // client gate ever sees it. This wider ceiling keeps the broad result a SUPERSET
    // (still client-gated by both memecoin maxMcap AND the bluechip band). Default
    // 1e12 = $1T, comfortably above any real bluechip cap. Inert while flag OFF.
    bluechipBroadMcapCeil:  u.bluechipBroadMcapCeil  ?? 1_000_000_000_000,
    // Opsi-1/B (single-side SOL) deployability guard: a bluechip pool is deployable only
    // if wSOL is its tokenY (QUOTE) leg — the side SOL can be deposited on-chain. Default
    // true → pools with wSOL on the BASE side (SOL-USDC, SOL-mSOL → on-chain 0x1) AND
    // pools with no wSOL leg (JLP-USDC, USDC-USDT) are filtered from the DEPLOYABLE set.
    // Deployable target = LST-SOL (JitoSOL-SOL / mSOL-SOL / JupSOL-SOL: LST=tokenX,
    // wSOL=tokenY). Flip OFF once Vega ships two-sided (Opsi A) deploy that can seed a
    // wSOL-base pool. Reject: bluechip_wsol_not_quote_side.
    requireBluechipWsolLeg: u.requireBluechipWsolLeg ?? true,
    // ── Bluechip deploy-side binStep exemption ceiling (Vega — Opsi B, money-path) ──
    // ROOT BLOCKER (Lyra): bluechip never deployed — SOL-USDC has bin_step=1, well
    // below the memecoin minBinStep (80) → executor binStep gate refused every
    // bluechip deploy ("bin_step 1 is below configured minBinStep 80"). Deep stable
    // pools NEED a small bin step (fine-grained price grid = tight active-range fee
    // capture); the memecoin [80,125/200] floor is structurally wrong for them.
    // FIX: when bluechipModeEnabled AND the pair is a WHITELIST bluechip pair
    // (isBluechipMintPair), the memecoin [minBinStep,maxBinStep] floor/ceiling is
    // EXEMPTED — but a sane absolute bound STILL applies (bin_step must be a positive
    // finite integer in (0, bluechipMaxBinStep]). This is NOT "no check": a garbage
    // bin_step (0/negative/non-finite/absurd) is still REFUSED (fail-closed). The
    // whitelist is NON-NEGOTIABLE — a non-whitelist pair NEVER gets the exemption and
    // stays on the memecoin [80,…] floor. Default 200 covers every real DLMM bin step
    // (1,2,4,5,10,20,25,50,80,100,125,200). Inert while flag OFF.
    bluechipMaxBinStep:     u.bluechipMaxBinStep     ?? 200,
    // Bluechip-ONLY funnel restriction (Cassiopeia — Item C). When ON (with the master
    // bluechipModeEnabled), discoverPools drops every NON-bluechip (memecoin) pool so a
    // paper-soak collects PURE bluechip data — never diluted by memecoin deploys (Lyra:
    // bluechip loses the pre-rank to memecoins → never reaches top-N → never deploys; we
    // RESTRICT the universe rather than re-weight the score). Default FALSE → mixed
    // funnel (memecoin path byte-for-byte unchanged). Set TRUE in the paper-soak instance
    // only; live can later run mixed. Reject reason: non_bluechip_filtered_bluechip_only_mode.
    bluechipOnlyMode:       u.bluechipOnlyMode       ?? false,
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
    // Vega — data-collection size PIN (2026-07-10). Default lowered 0.5 → 0.10.
    // ROOT-CAUSE of the Jul 7-10 deploy deadlock: with floor===ceil===0.5 and a
    // 0.737-SOL wallet, computeDeployAmount clamped to the deployable (~0.48) which
    // then fell BELOW the executor minDeploy floor (max(0.02, deployAmountSol)=0.5),
    // so all 35 deploy attempts were refused. Pinning floor=ceil=0.10 (this default
    // + maxDeployAmount 0.10 via user-config on VPS) makes every deploy a UNIFORM
    // 0.10 SOL bet that clears the floor. 0.10 is far under MAX_LIVE_POSITION_SOL
    // (0.5 hard belt) and the bluechip cap — all money-side caps still bind above it.
    deployAmountSol:       u.deployAmountSol       ?? 0.10,
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
    // Vega FIX#1 (2026-06-16) — OOR DIRECTIONAL exit. Root-cause fix for the
    // win+$0.04 / loss-$1.33 asymmetry. Single-side SOL deploys (bins_above=0)
    // go OOR-UP on ANY up-move; the legacy OOR path hard-closed pump and dump
    // identically. With this ON:
    //   - OOR-UP (active>upper) + in-profit (fee-incl) → ARM TRAILING, do NOT
    //     hard-close on the OOR timer (capture the pump; trailing-drop still exits).
    //   - OOR-DOWN (active<lower) → cut FASTER via outOfRangeWaitMinutesDown
    //     (< normal outOfRangeWaitMinutes); pure depreciation, fees dead.
    //   - OOR-UP NOT in-profit → normal OOR timer (no special handling).
    // FAIL-SAFE (anti-pattern #2): if bin data (active/upper/lower) is missing or
    // non-finite → direction UNKNOWN → fall back to the NORMAL OOR timer (never
    // crash, never skip the close). Downside STAYS capped — SL fires above OOR.
    // Reversibility: oorDirectionalExitEnabled=false → legacy single-`in_range`
    // OOR behavior on BOTH paper + live (no branching at all).
    oorDirectionalExitEnabled: u.oorDirectionalExitEnabled ?? false,
    // OOR-DOWN cut timer (minutes). MUST be <= outOfRangeWaitMinutes; a dump is
    // pure depreciation so we exit sooner. Default 8 (vs 20-30 normal).
    outOfRangeWaitMinutesDown: u.outOfRangeWaitMinutesDown ?? 8,
    // Vega Opsi 1 (2026-06-22) — Patient OOR-UP for bluechip near-peg LST-SOL.
    // ROOT-CAUSE FIX for masalah #2 (instant-close ~40s). A single-side SOL
    // deploy into a wSOL=tokenY pool MUST end at maxBinId=activeBin (a bin above
    // active holds tokenX/LST only → would require depositing the LST = two-sided
    // Opsi A). So a bin-buffer above active is NOT SDK-valid for single-side SOL
    // slot-Y; the correct lever is OOR-HANDLING. On a near-peg pool with a small
    // bin_step the first up-tick → OOR-UP in seconds while net pnl is still ~flat
    // (conversion-edge), so the in-profit ride path misses it and the legacy
    // timer cut it at the worst spot. With this ON, a pos.is_bluechip position
    // that is OOR-UP (and above the SL floor — SL fires above this block) is HELD
    // patiently: SOL is converting into the appreciating LST exactly as intended,
    // NOT a stop signal. SL + max-hold still own the exit (no infinite hold), and
    // it is UP-only so the OOR-DOWN fast-cut is untouched. Memecoin (is_bluechip
    // falsey) is byte-for-byte unchanged. Default OFF — Bro+Vega enable after
    // paper-soak; bluechip mode itself stays PAUSED. Requires
    // oorDirectionalExitEnabled (the directional substrate) to be ON to take effect.
    bluechipPatientOorEnabled: u.bluechipPatientOorEnabled ?? false,
    // ─── Andromeda Track-B PROFIT — Fast OOR-UP harvest (paper + live) ──────
    // Confirmed short-gamma reality: a single-side-SOL position goes OOR-UP the
    // instant price ticks up through the deploy bin → it is then 100% idle SOL
    // (the quote leg), accruing ZERO fees. The generic outOfRangeWaitMinutes
    // (30m) just parks dead capital. This harvests OOR-UP FAST (default 3m ≈ one
    // management cycle of whipsaw tolerance) to lock the ~+3% winners realize
    // here and FREE the capital for redeploy — velocity is the edge. Direction is
    // read via oorDirection() INDEPENDENT of oorDirectionalExitEnabled (own flag);
    // when on it takes precedence over the (data-refuted) "ride the pump" hold.
    // It CLOSES (never holds) so it cannot shield a loss — SL + break-even run
    // ABOVE the OOR block on the fee-inclusive net PnL. FAIL-SAFE: direction
    // UNKNOWN (bin fields missing) → skip → legacy timer owns it. Distinct
    // close-reason token `oor_up_fast_harvest` for separate EV audit (Lyra).
    // Reversibility: oorUpFastExitEnabled=false → legacy OOR behavior unchanged.
    // Recommended live: enabled=true, minutes=3.
    oorUpFastExitEnabled:  u.oorUpFastExitEnabled  ?? false,
    oorUpFastExitMinutes:  u.oorUpFastExitMinutes  ?? 3,
    // ─── Andromeda Track-B PROFIT — Give-back protection (paper + live) ─────
    // Confirmed: peaks cluster ~+4.7–5.4% then round-trip (reptilecoin peaked
    // +5.43% and gave it ALL back to the −0.96% break-even stop); the +18%
    // trailingTriggerPct NEVER arms on this instrument. Give-back is a LOW-trigger
    // trailing harvest that OWNS the sub-trailing zone: once the confirmed peak
    // >= giveBackPeakPct (4%) but BELOW where trailing takes over (trailingTrigger
    // Pct), a decay of >= giveBackDropPct (2%) from that peak closes the position,
    // locking ~+3% instead of round-tripping. COMPLEMENTS trailing TP (does NOT
    // touch trailingTriggerPct/trailingDropPct) — give-back owns [giveBackPeakPct,
    // trailingTriggerPct), trailing owns the rest; if trailing is disabled the
    // ceiling is ∞. HARD-guarded to net PnL > 0 → mutually exclusive with STOP_LOSS
    // (fires only on negative PnL), so SL stays untouched and give-back can only
    // ever HARVEST a profitable position. Runs BEFORE break-even so the gain lands
    // higher (at peak − drop, not the 0% floor). FAIL-SAFE: peak/PnL missing/
    // non-finite/suspicious → skip → break-even/SL/trailing own it. Distinct
    // close-reason token `give_back_protect` for separate EV audit (Lyra).
    // Reversibility: giveBackProtectEnabled=false → no rule. Recommended live:
    // enabled=true, peakPct=4, dropPct=2.
    giveBackProtectEnabled: u.giveBackProtectEnabled ?? false,
    giveBackPeakPct:        u.giveBackPeakPct        ?? 4,
    giveBackDropPct:        u.giveBackDropPct        ?? 2,
    // Andromeda PR-A — max-drawdown-recovery exit (paper-trades.js).
    // ARM when max_drawdown (peak−trough) >= armPct; FIRE when current pnl
    // recovers deltaPct above trough. Distinct from trailing TP, which gates
    // on peak >= trailingTriggerPct. Toggle internalAgents.drawdownRecoveryEnabled.
    drawdownRecoveryArmPct:  u.drawdownRecoveryArmPct  ?? 10,  // require >= X% drawdown before arming
    drawdownRecoveryDeltaPct: u.drawdownRecoveryDeltaPct ?? 5, // close after X% recovery from trough
    // Andromeda X2 + Vega EXIT-3 #3 — Max-hold-time forced exit (paper + live).
    // HIGHEST precedence in both evaluatePaperExit and updatePnlAndCheckExits so
    // SL/TP/Trailing/DD_RECOVERY cannot delay an exit past the holding window.
    // Raised 720→1440 (24h) so a still-IN-RANGE winner (ZINC-type 11h+ tail) is
    // NOT clipped at the old 12h cap. The IN-RANGE GUARD splits the window:
    //   - age >= maxHoldOorMinutes (720m) AND OUT-OF-RANGE → close (max_hold_oor)
    //   - age >= maxHoldMinutes (1440m) → close (max_hold_hard) regardless
    //   - age 720-1440m AND IN-RANGE → keep running (winner tail).
    // maxHoldOorMinutes defaults to maxHoldMinutes/2 (=720m) when unset; clamped
    // to never exceed maxHoldMinutes. Reversibility: maxHoldMinutes=0 → no gate.
    maxHoldMinutes:        u.maxHoldMinutes        ?? 1440,   // 24h hard forced exit (was 720)
    maxHoldOorMinutes:     u.maxHoldOorMinutes     ?? 720,    // 12h forced exit IF out-of-range (in-range allowed past this)
    // ─── Vega EXIT-3 #1 — Break-even stop (paper + live, default OFF) ───────
    // Once a position peaks >= breakEvenArmPct (fee-inclusive), the effective stop
    // ratchets UP from the fixed stopLossPct (-8%) to breakEvenStopPct (0% = flat,
    // or a small positive to lock a sliver of gain). Idempotent (be_armed flag,
    // never disarms). Checked BEFORE the fixed SL so the higher floor wins — a
    // winner that round-trips exits at break-even instead of riding back to -8%.
    // Pure ADD: does NOT remove downside protection (un-armed positions still hit
    // the fixed SL). Reversibility: breakEvenStopEnabled=false → fixed SL only.
    breakEvenStopEnabled:  u.breakEvenStopEnabled  ?? false,
    breakEvenArmPct:       u.breakEvenArmPct       ?? 5,      // peak PnL% that arms the break-even ratchet
    breakEvenStopPct:      u.breakEvenStopPct      ?? 0,      // ratcheted floor once armed (0 = flat; +1 locks a sliver)
    // ─── Vega EXIT-3 #2 — Fee-decay exit (paper + live, default OFF) ────────
    // Community trigger #1 ("exit when fees slow down"). Tracks current fee/TVL
    // rate vs a per-position baseline (first post-warmup reading, else the
    // deploy-time fee/TVL). Exits when current < feeDecayThreshold × baseline
    // (default 0.30 = a 70% collapse in fee velocity) WHILE IN PROFIT — a
    // profit-taking rule, NOT a cut-loss (losers owned by SL/break-even/OOR).
    // Coordinated with VELOCITY_EXIT (price reversal) — fee-decay reads FEE rate,
    // different input, no double-fire. FAIL-SAFE: missing rate / no baseline →
    // skip (never false-exit). Reversibility: feeDecayExitEnabled=false → no rule.
    feeDecayExitEnabled:   u.feeDecayExitEnabled   ?? false,
    feeDecayThreshold:     u.feeDecayThreshold     ?? 0.30,   // exit when current fee rate < 30% of baseline
    feeDecayWarmupMinutes: u.feeDecayWarmupMinutes ?? 30,     // don't capture baseline before this (skip first-tick spike)
    feeDecayMinAgeMinutes: u.feeDecayMinAgeMinutes ?? 60,     // don't fire fee-decay before the position has had time to accrue
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
    // ── Bluechip income-engine wide-range ceiling (Vega — Opsi B, money-path) ──
    // Memecoin keeps the [minBinsBelow, maxBinsBelow] (≈[35,69]) clamp — UNCHANGED.
    // A BLUECHIP pool (both legs whitelisted, bluechipModeEnabled on) may deploy a
    // WIDE single-side-SOL range up to bluechipMaxBinsBelow. WIDER is the whole point:
    // a deep stable pool wants a broad passive range so the active bin stays in-range
    // for days (income engine), not a tight memecoin scalp band. bins_above stays 0
    // (Opsi B — single-side SOL; two-sided/amount_x is Opsi A / Phase 2, NOT this).
    // Reuses the existing isWideRange (>69) createExtendedEmptyPosition SDK path.
    bluechipMaxBinsBelow: numericConfig(u.bluechipMaxBinsBelow) ?? 250,
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
    // Orion step-budget fix (2026-06-13) — raised 8 → 16. The 8-step cap was
    // starving completed deploys: a single ENTER candidate needs the enrichment
    // batch (get_pool_detail + smart_wallets + token_holders + token_narrative —
    // up to ~4 steps if the model doesn't parallelize) + deploy reasoning (1) +
    // deploy_position (1) + one-line ACK after the tool result (1) = ~7 steps
    // worst-case. At 8 the loop exhausted in enrichment BEFORE deploy_position
    // → [SCREENER_STALL] "Orion ENTER but max-steps reached without deploy".
    // 16 ≈ 2.3x realistic worst-case for a top-1 deploy — headroom without bloat.
    // Cost stays flat: deploy_position is NO_RETRY (locks after first attempt) and
    // the loop exits on ACK, so extra steps are consumed ONLY when a cycle actually
    // deploys. No-ENTER cycles still exit in 1–2 steps. Stays < global maxSteps (20).
    // Raising this does NOT bypass any safety: deploy still passes judge ENTER +
    // Cassiopeia gates + executor.js hardcoded caps (maxDeployAmount, gasReserve,
    // maxPositions, fresh-snapshot guard). Vega money-VETO on the deploy path holds.
    screeningMaxSteps: u.screeningMaxSteps ?? 16,
    // Orion cost fix (2026-06-01) — cap how many scored candidates are rendered into the
    // SCREENER goal. Trims the dominant prompt-token driver; reporting still sees all.
    screeningPromptCandidateCap: u.screeningPromptCandidateCap ?? 5,
    // Deprecation refresh (2026-07-10, Orion) — hardcoded defaults realigned from the
    // retired xiaomi v2 family (mimo-v2-omni / mimo-v2-pro, removed from OpenRouter) to
    // the confirmed-live default deepseek/deepseek-v4-flash. These are overridden by
    // user-config.json (already deepseek-v4-flash for all roles), so this is a hygiene
    // fix that only bites if the user-config keys are ever unset — no runtime change.
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash",
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
    // Vega fix #1 — fee-inclusive exit decision metric. When ON (default), all
    // PnL-based exit rules (SL / TP / trailing / partial / velocity / drawdown)
    // decide on the NET economic position (price + fees − IL) instead of the
    // PRICE-ONLY proxy. Root-cause of the 1:2 loss/win asymmetry: SL fired on
    // raw price drops with fees never offsetting (loser realized full), while
    // winners only exited on price moves (accrued fees triggered nothing).
    // FAIL-SAFE (anti-pattern #2): when the fee-inclusive figure is missing/null
    // the logic falls back to the price proxy — never assumes fees are large,
    // never skips the stop loss. Downside stays capped: SL still fires, it just
    // measures the true net position. Paper uses naive 0% IL (optimistic, see
    // paper-trades.js computeFeeInclusivePnl); live uses the real derived PnL
    // (current value + fees − deposit, IL embedded in current value). Flip false
    // → silent revert to price-only decisions on BOTH paper and live.
    feeInclusiveExitEnabled: u.internalAgents?.feeInclusiveExitEnabled ?? true,
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
    // Vega money-path hardening (2026-07-12, Draco drain-forensic follow-up).
    // The active token→SOL dust swap (tools/wallet.js swapToken) previously set
    // NO slippageBps → rode the Jupiter default. Fine on ~0.03 SOL dust today,
    // but a larger OOR-down token bag on a thin pool could eat a bad fill. This
    // cap (a) is sent as slippageBps on the Jupiter order (on-chain ceiling — the
    // tx reverts rather than fills worse), and (b) is a pre-execution guard: if
    // the quoted price impact exceeds the cap we SKIP the swap (fail-closed,
    // anti-pattern #2 — the token stays in the wallet with an alert rather than a
    // silent bad fill). Default 200 bps = 2% (task range 1-3%). User-tunable so
    // Bro can loosen for a genuinely thin exit if ever needed. Also the CEILING
    // applied to the dormant LPAgent relay zap-out (was hard 5000/50%).
    swapMaxSlippageBps: Number(u.swapMaxSlippageBps ?? 200),
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
 * Scales position size with wallet growth (auto-compounding) when enabled.
 *
 * Base formula (always): clamp(deployable × positionSizePct,
 *                               floor=deployAmountSol, ceil=maxDeployAmount)
 * where deployable = max(0, walletSol − gasReserve)  ← gas ALWAYS reserved first.
 *
 * Auto-compound (config.risk.autoCompoundEnabled === true) ADDS two
 * anti-over-leverage bounds on top of the clamp:
 *   1. Concentration cap — result ≤ walletSol × maxConcentrationPct (default
 *      0.60). A single position never eats more than this fraction of the TOTAL
 *      wallet, so a buffer + gas always remain.
 *   2. Absolute hard ceiling — result ≤ autoCompoundHardCeilingSol (default 1.0).
 *      Independent of the configurable maxDeployAmount; the "unbounded wallet"
 *      guard. Only Bro raises it.
 *
 * Compound is SYMMETRIC: wallet grows from profit → deployable grows → position
 * grows (up to whichever bound binds); wallet shrinks from loss → position
 * shrinks (auto de-risk). The position can ONLY grow when realized profit has
 * already grown the wallet — never on leverage.
 *
 * When autoCompoundEnabled === false: legacy behavior — the original
 * clamp(deployable × pct, floor, ceil) with NO concentration/hard-ceiling
 * bounds. With today's locked floor === ceil this returns exactly the fixed
 * amount, identical to pre-auto-compound production. Fully reversible.
 *
 * @param {number} walletSol - current live SOL balance
 * @param {object} cfg - config (test seam; defaults to live config)
 */
export function computeDeployAmount(walletSol, cfg = config) {
  const reserve  = cfg.management.gasReserve      ?? 0.2;
  const pct      = cfg.management.positionSizePct ?? 0.35;
  const floor    = cfg.management.deployAmountSol;
  const ceil     = cfg.risk.maxDeployAmount;
  const autoCompound = cfg.risk.autoCompoundEnabled === true;

  const wallet     = Number.isFinite(walletSol) ? walletSol : 0;
  const deployable = Math.max(0, wallet - reserve);
  const dynamic    = deployable * pct;

  // Flag OFF → legacy clamp only (no concentration/hard-ceiling bounds).
  // With locked floor===ceil this is the fixed amount = pre-compound behavior.
  if (!autoCompound) {
    const legacy = Math.min(ceil, Math.max(floor, dynamic));
    return parseFloat(Math.max(0, legacy).toFixed(2));
  }

  // 1. Base compound clamp: floor ≤ (deployable × pct) ≤ ceil.
  let result = Math.min(ceil, Math.max(floor, dynamic));

  // 2. Concentration cap — fraction of TOTAL wallet (anti over-leverage).
  const concPct = numericConfig(cfg.risk.maxConcentrationPct) ?? 0.60;
  const concentrationCap = wallet * concPct;
  result = Math.min(result, concentrationCap);

  // 3. Absolute hard ceiling (SOL) — independent belt, unbounded-wallet guard.
  const hardCeiling = numericConfig(cfg.risk.autoCompoundHardCeilingSol) ?? 1.0;
  result = Math.min(result, hardCeiling);

  // 4. Gas-reserve hard ceiling — a position can NEVER exceed what is deployable
  // after gas, EVEN when the floor would lift it higher on a tiny wallet. This
  // dominates the floor: gas is sacred, leverage is never created. When the
  // wallet can't fund the floor, the result falls below it (and below dust) —
  // the executor's minDeploy guard (max(0.1, deployAmountSol)) is the suspenders
  // that then refuses the undeployable amount rather than over-committing gas.
  result = Math.min(result, deployable);

  // Never negative.
  return parseFloat(Math.max(0, result).toFixed(2));
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
    if (fresh.minVolatility  != null) s.minVolatility  = fresh.minVolatility;
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
    if (fresh.edgeFilterEnabled  !== undefined) s.edgeFilterEnabled = fresh.edgeFilterEnabled;
    if (fresh.edgeFilterFtvlMin  != null) s.edgeFilterFtvlMin = fresh.edgeFilterFtvlMin;
    if (fresh.edgeFilterFtvlMax  != null) s.edgeFilterFtvlMax = fresh.edgeFilterFtvlMax;
    if (fresh.edgeFilterMinVolatility != null) s.edgeFilterMinVolatility = fresh.edgeFilterMinVolatility;
    if (fresh.enrichHolderCountBeforeGate !== undefined) s.enrichHolderCountBeforeGate = fresh.enrichHolderCountBeforeGate;
    if (fresh.enrichNativeDetailBeforeGate !== undefined) s.enrichNativeDetailBeforeGate = fresh.enrichNativeDetailBeforeGate;
    if (fresh.broadDiscoveryEnabled  !== undefined) s.broadDiscoveryEnabled  = fresh.broadDiscoveryEnabled;
    if (fresh.broadDiscoveryPageSize != null) s.broadDiscoveryPageSize = fresh.broadDiscoveryPageSize;
    if (fresh.broadMcapFloor != null) s.broadMcapFloor = fresh.broadMcapFloor;
    if (fresh.broadMcapCeil  != null) s.broadMcapCeil  = fresh.broadMcapCeil;
    if (fresh.broadMinTvl    != null) s.broadMinTvl    = fresh.broadMinTvl;
    if (fresh.broadSortBy    != null) s.broadSortBy    = fresh.broadSortBy;
    if (fresh.broadDiscoveryCacheTtlMin != null) s.broadDiscoveryCacheTtlMin = fresh.broadDiscoveryCacheTtlMin;
    if (fresh.broadDiscoveryDetailCacheTtlMin != null) s.broadDiscoveryDetailCacheTtlMin = fresh.broadDiscoveryDetailCacheTtlMin;
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
    if (fresh.marketRegimeGateEnabled     !== undefined) s.marketRegimeGateEnabled = fresh.marketRegimeGateEnabled;
    if (fresh.regimeDowntrendThresholdPct != null) s.regimeDowntrendThresholdPct = fresh.regimeDowntrendThresholdPct;
    if (fresh.regimeUptrendThresholdPct   != null) s.regimeUptrendThresholdPct = fresh.regimeUptrendThresholdPct;
    if (fresh.directionGateEnabled          !== undefined) s.directionGateEnabled = fresh.directionGateEnabled;
    if (fresh.directionMaxNegPriceChangePct != null) s.directionMaxNegPriceChangePct = fresh.directionMaxNegPriceChangePct;
    if (fresh.directionRequireFlowConfirm   !== undefined) s.directionRequireFlowConfirm = fresh.directionRequireFlowConfirm;
    if (fresh.directionMinBuyShare          != null) s.directionMinBuyShare = fresh.directionMinBuyShare;
    if (fresh.bluechipModeEnabled    !== undefined) s.bluechipModeEnabled    = fresh.bluechipModeEnabled;
    if (fresh.bluechipMinTvl         != null) s.bluechipMinTvl         = fresh.bluechipMinTvl;
    if (fresh.bluechipMinVolume      != null) s.bluechipMinVolume      = fresh.bluechipMinVolume;
    if (fresh.bluechipMinFeeTvlRatio != null) s.bluechipMinFeeTvlRatio = fresh.bluechipMinFeeTvlRatio;
    if (fresh.bluechipMinMcap        != null) s.bluechipMinMcap        = fresh.bluechipMinMcap;
    if (fresh.bluechipMaxVolatility  != null) s.bluechipMaxVolatility  = fresh.bluechipMaxVolatility;
    if (fresh.bluechipBroadMcapCeil  != null) s.bluechipBroadMcapCeil  = fresh.bluechipBroadMcapCeil;
    if (fresh.requireBluechipWsolLeg !== undefined) s.requireBluechipWsolLeg = fresh.requireBluechipWsolLeg;
    if (fresh.bluechipOnlyMode       !== undefined) s.bluechipOnlyMode       = fresh.bluechipOnlyMode;
    if (fresh.bluechipMaxBinStep     != null) s.bluechipMaxBinStep     = fresh.bluechipMaxBinStep;
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
