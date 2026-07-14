// scripts/test-vega-deterministic.js
// Test for agents/vega.js (PR 3 — deterministic deploy after Orion ENTER)
//
// Pure unit test. No real LLM, no real RPC, no on-chain calls. Uses the
// __setExecuteToolForTests seam exported by agents/vega.js (mirror of the
// pattern in agents/orion.js __setClientForTests).
//
// Coverage (>= 8 assertions; actual ~30 assertions):
//   - computeBinsBelow formula matches CLAUDE.md L127 for low/mid/high vol
//   - computeBinsBelow rejects volatility <= 0 / null / NaN
//   - vegaDeterministicDeployEnabled toggles via config.internalAgents flag
//   - deployFromOrionVerdict returns null when flag is OFF
//   - deployFromOrionVerdict returns null on SKIP verdict
//   - deployFromOrionVerdict returns null when candidate volatility unusable
//   - deployFromOrionVerdict invokes deploy_position with the expected shape
//   - amount_y is capped at config.risk.maxDeployAmount
//   - bins_above is always 0 (single-side SOL invariant)
//   - amount_x is always 0 (single-side SOL invariant)
//   - live confidence floor skips low-confidence ENTERs (live mode only)
//   - blocked-by-safety + tool error results propagate as deployed=false

process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

const { config } = await import("../config.js");
const {
  deployFromOrionVerdict,
  computeBinsBelow,
  vegaDeterministicDeployEnabled,
  __setExecuteToolForTests,
  __setGetWalletBalancesForTests,
} = await import("../agents/vega.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}  ${detail}`);
    process.exitCode = 1;
  }
}

// ── Stubs ──────────────────────────────────────────────────────────────────
let invocationCount = 0;
let lastInvocation = null;
let stubResult = null;

function installExecutorStub(result) {
  stubResult = result;
  __setExecuteToolForTests(async (name, args) => {
    invocationCount += 1;
    lastInvocation = { name, args };
    return stubResult;
  });
}

function resetCallTracking() {
  invocationCount = 0;
  lastInvocation = null;
}

// Stub the wallet balance fetch so tests that don't pass walletSol still work.
__setGetWalletBalancesForTests(async () => ({ sol: 5 }));

// ─── 1) Pure formula tests ─────────────────────────────────────────────────
console.log("\n[1] computeBinsBelow formula");

const strat = { minBinsBelow: 35, maxBinsBelow: 69 };
// 35 + (v/5) * 34 clamped to [35, 69]
//   v=0.5 → 35 + 0.1*34 = 38.4 → 38
//   v=2.5 → 35 + 0.5*34 = 52
//   v=5.0 → 35 + 1.0*34 = 69
//   v=10  → clamp to 69
check("low vol (0.5) → 38", computeBinsBelow(0.5, strat) === 38);
check("mid vol (2.5) → 52", computeBinsBelow(2.5, strat) === 52);
check("high vol (5.0) → 69 (max)", computeBinsBelow(5.0, strat) === 69);
check("over-max vol (10) → clamped 69", computeBinsBelow(10, strat) === 69);
check("zero vol → null", computeBinsBelow(0, strat) === null);
check("negative vol → null", computeBinsBelow(-1, strat) === null);
check("null vol → null", computeBinsBelow(null, strat) === null);
check("NaN vol → null", computeBinsBelow(NaN, strat) === null);

// ─── 2) Flag toggle ────────────────────────────────────────────────────────
console.log("\n[2] feature flag");

const origFlag = config.internalAgents.vegaDeterministicDeploy;
config.internalAgents.vegaDeterministicDeploy = false;
check("disabled when flag off", vegaDeterministicDeployEnabled(config) === false);
config.internalAgents.vegaDeterministicDeploy = true;
check("enabled when flag on", vegaDeterministicDeployEnabled(config) === true);

// Common fixtures
const enterVerdict = {
  pool_address: "PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa",
  decision: "enter",
  confidence: 80,
  reason: "good fee/tvl",
};
const goodCandidate = {
  pool: {
    pool: "PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa",
    name: "AAA-SOL",
    bin_step: 100,
    fee_active_tvl_ratio: 0.08,
    volume_window: 12000,
    tvl: 50000,
    volatility: 2.5,
    organic_score: 75,
    mcap: 800000,
    token_age_hours: 24,
    base: { mint: "BaseMintA1111111111111111111111111111111" },
  },
  sw: { in_pool: [{ name: "kol1" }] },
  n: { narrative: "trending" },
  ti: { audit: { top_holders_pct: 40, bot_holders_pct: 12 }, global_fees_sol: 80 },
  mem: null,
};

// ─── 3) flag OFF → null ────────────────────────────────────────────────────
console.log("\n[3] flag-off short-circuit");
config.internalAgents.vegaDeterministicDeploy = false;
installExecutorStub({ success: true });
resetCallTracking();
const flagOff = await deployFromOrionVerdict(enterVerdict, goodCandidate, { walletSol: 5 });
check("flag OFF → returns null", flagOff === null);
check("flag OFF → executeTool not invoked", invocationCount === 0);

// ─── 4) SKIP verdict → null ────────────────────────────────────────────────
console.log("\n[4] SKIP verdict short-circuit");
config.internalAgents.vegaDeterministicDeploy = true;
resetCallTracking();
const skipRes = await deployFromOrionVerdict(
  { ...enterVerdict, decision: "skip", confidence: 10, reason: "bots" },
  goodCandidate,
  { walletSol: 5 },
);
check("SKIP verdict → returns null", skipRes === null);
check("SKIP verdict → executeTool not invoked", invocationCount === 0);

// ─── 5) Unusable volatility → null ─────────────────────────────────────────
console.log("\n[5] unusable volatility");
resetCallTracking();
const v0 = await deployFromOrionVerdict(
  enterVerdict,
  { ...goodCandidate, pool: { ...goodCandidate.pool, volatility: 0 } },
  { walletSol: 5 },
);
check("volatility=0 → returns null", v0 === null);
const vNull = await deployFromOrionVerdict(
  enterVerdict,
  { ...goodCandidate, pool: { ...goodCandidate.pool, volatility: null } },
  { walletSol: 5 },
);
check("volatility=null → returns null", vNull === null);
check("unusable vol → executeTool not invoked", invocationCount === 0);

// ─── 6) Successful dispatch shape ──────────────────────────────────────────
console.log("\n[6] dispatch shape (stubbed executeTool)");

installExecutorStub({
  success: true,
  pool: "PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa",
  pool_name: "AAA-SOL",
  position: "PositionAddr",
  txs: ["TxSig111aaaaaaaaaaaaaaa"],
  amount_y: 0.1,
  strategy: "bid_ask",
});
resetCallTracking();

const dispatchRes = await deployFromOrionVerdict(enterVerdict, goodCandidate, { walletSol: 5 });
check("dispatch: deployed=true", dispatchRes?.deployed === true);
check("dispatch: txSignature propagated", dispatchRes?.txSignature === "TxSig111aaaaaaaaaaaaaaa");
check("dispatch: invocationCount === 1", invocationCount === 1);
check("dispatch: tool name is deploy_position", lastInvocation?.name === "deploy_position");
check("dispatch: pool_address matches", lastInvocation?.args?.pool_address === enterVerdict.pool_address);
check("dispatch: amount_x === 0 (single-side SOL)", lastInvocation?.args?.amount_x === 0);
check("dispatch: bins_above === 0 (single-side SOL)", lastInvocation?.args?.bins_above === 0);
check("dispatch: strategy === bid_ask", lastInvocation?.args?.strategy === "bid_ask");
check("dispatch: bins_below from formula (vol=2.5 → 52)", lastInvocation?.args?.bins_below === 52);
check("dispatch: volatility === 2.5", lastInvocation?.args?.volatility === 2.5);
check("dispatch: base_mint propagated", lastInvocation?.args?.base_mint === "BaseMintA1111111111111111111111111111111");
check("dispatch: candidate_snapshot present", lastInvocation?.args?.candidate_snapshot != null);
check("dispatch: amount_y is positive number",
  typeof lastInvocation?.args?.amount_y === "number" && lastInvocation.args.amount_y > 0);
check("dispatch: amount_y <= maxDeployAmount",
  lastInvocation?.args?.amount_y <= config.risk.maxDeployAmount);

// ─── 7) maxDeployAmount hard cap ───────────────────────────────────────────
console.log("\n[7] maxDeployAmount hard cap");

const origMaxDeploy = config.risk.maxDeployAmount;
config.risk.maxDeployAmount = 0.05;
resetCallTracking();
const capRes = await deployFromOrionVerdict(
  enterVerdict,
  goodCandidate,
  { walletSol: 10, deployAmountOverride: 0.5 }, // request more than cap
);
check("cap: deployed=true", capRes?.deployed === true);
check("cap: amount_y squashed to 0.05", lastInvocation?.args?.amount_y === 0.05);
config.risk.maxDeployAmount = origMaxDeploy;

// ─── 8) Live confidence floor ──────────────────────────────────────────────
console.log("\n[8] live confidence floor");

const origDryRun = config.dryRun;
const origLiveOverrides = config.liveOverrides;
config.dryRun = false;
config.liveOverrides = { orionMinConfidence: 70 };

installExecutorStub({ success: true, txs: ["LiveTxAAA"] });
resetCallTracking();
const lowConf = await deployFromOrionVerdict(
  { ...enterVerdict, confidence: 50 },
  goodCandidate,
  { walletSol: 5 },
);
check("low confidence (50% < 70%) → null", lowConf === null);
check("low confidence → executeTool not invoked", invocationCount === 0);

const highConf = await deployFromOrionVerdict(
  { ...enterVerdict, confidence: 80 },
  goodCandidate,
  { walletSol: 5 },
);
check("high confidence (80% >= 70%) → deployed", highConf?.deployed === true);
check("high confidence → executeTool invoked once", invocationCount === 1);

// Restore env
config.dryRun = origDryRun;
config.liveOverrides = origLiveOverrides;

// ─── 9) Blocked safety check propagates ────────────────────────────────────
console.log("\n[9] blocked-by-safety propagates");

// NOTE: use the REAL assertCircuitOK reason format here. The old stub used the
// phantom string "circuit_breaker: daily loss reached" which matches NO production
// code path — it leaked into a log forensic (2026-07-14) and was mistaken for a
// real wallet-delta guard. The authoritative block reason is realized-loss based.
installExecutorStub({ blocked: true, reason: "Circuit breaker tripped: Daily SOL loss cap hit (0.1100 SOL ≥ 0.1 SOL)." });
resetCallTracking();
const blocked = await deployFromOrionVerdict(enterVerdict, goodCandidate, { walletSol: 5 });
check("blocked → deployed=false", blocked?.deployed === false);
check("blocked → error includes reason", String(blocked?.error || "").includes("Circuit breaker tripped"));

// ─── 10) Tool error propagates ─────────────────────────────────────────────
console.log("\n[10] tool error propagates");

installExecutorStub({ error: "RPC timeout" });
resetCallTracking();
const errRes = await deployFromOrionVerdict(enterVerdict, goodCandidate, { walletSol: 5 });
check("tool error → deployed=false", errRes?.deployed === false);
check("tool error → error message propagated", errRes?.error === "RPC timeout");

// ─── 11) executeTool throws → caught, deployed=false ───────────────────────
console.log("\n[11] executeTool throws is contained");

__setExecuteToolForTests(async () => { throw new Error("rpc network down"); });
resetCallTracking();
const thrown = await deployFromOrionVerdict(enterVerdict, goodCandidate, { walletSol: 5 });
check("thrown error → deployed=false", thrown?.deployed === false);
check("thrown error → error message present", String(thrown?.error || "").includes("rpc network down"));

// ─── Cleanup ───────────────────────────────────────────────────────────────
__setExecuteToolForTests(null);
__setGetWalletBalancesForTests(null);
config.internalAgents.vegaDeterministicDeploy = origFlag;

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n──────────────────────`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.error("VEGA TEST FAILED");
  process.exit(1);
}
console.log("VEGA TEST OK");
