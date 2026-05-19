// scripts/test-manager-deterministic.js
// Test for agents/manager.js (PR 4 — deterministic manager).
//
// Pure unit test. No real LLM, no real RPC, no on-chain calls. Uses the
// __setExecuteToolForTests seam (mirror of agents/vega.js pattern).
//
// Coverage:
//   - Stop-loss triggered (rule 1) → close_position called with correct args
//   - Take-profit triggered (rule 2) → close_position called
//   - Pumped-far-above-range (rule 3) → close_position called
//   - OOR > timeout (rule 4) → close_position called
//   - Low-yield (rule 5) → close_position called
//   - Confirmed trailing-TP exit (from exitMap) → close_position with exit reason
//   - Position with INSTRUCTION → DEFERRED, NOT closed
//   - Healthy position → STAY, NOT closed
//   - Position with claimable fees (no exit) → claim_fees called
//   - Suspect PnL guard → does NOT trigger SL/TP
//   - Multiple positions, mixed signals → correctly dispatched
//   - Flag OFF → runDeterministicManagement returns null
//   - Empty positions list → no errors, no tool calls
//   - executeTool throws → contained, error captured in errors[]
//   - executeTool returns blocked → captured in errors[]

process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

const { config } = await import("../config.js");
const {
  runDeterministicManagement,
  managerDeterministicEnabled,
  buildActionMap,
  getDeterministicCloseRule,
  __setExecuteToolForTests,
} = await import("../agents/manager.js");

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

// ── Tool-call recording stub ──────────────────────────────────────────────
const calls = [];
let stubBehavior = "ok"; // "ok" | "blocked" | "error" | "throw" | "successFalse"

function installStub() {
  __setExecuteToolForTests(async (name, args) => {
    calls.push({ name, args });
    if (stubBehavior === "blocked") return { blocked: true, reason: "circuit_breaker: test" };
    if (stubBehavior === "error") return { error: "RPC timeout" };
    if (stubBehavior === "successFalse") return { success: false, reason: "on-chain failure" };
    if (stubBehavior === "throw") throw new Error("rpc network down");
    // OK path — minimal close_position / claim_fees success shape
    if (name === "close_position") {
      return { success: true, position: args.position_address, pool_name: "TEST-POOL", pnl_pct: 0, pnl_usd: 0 };
    }
    if (name === "claim_fees") {
      return { success: true, fees_claimed_usd: 5.5 };
    }
    return { success: true };
  });
}

function resetCalls() {
  calls.length = 0;
}

installStub();

// ── Common position fixtures ──────────────────────────────────────────────
function makePosition(overrides = {}) {
  return {
    position: "Pos11111111111111111111111111111111111111",
    pool: "Pool111111111111111111111111111111111111111",
    pair: "TEST-SOL",
    pnl_pct: 0,
    pnl_pct_suspicious: false,
    in_range: true,
    total_value_usd: 50,
    unclaimed_fees_usd: 0,
    fee_per_tvl_24h: 20,
    active_bin: 100,
    lower_bin: 60,
    upper_bin: 140,
    minutes_out_of_range: 0,
    age_minutes: 30,
    instruction: null,
    ...overrides,
  };
}

const mgmt = {
  stopLossPct: -10,
  takeProfitPct: 100,
  outOfRangeBinsToClose: 10,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 7,
  minClaimAmount: 5,
};

// ─── 0) Flag toggle ────────────────────────────────────────────────────────
console.log("\n[0] feature flag");
const origFlag = config.internalAgents.managerDeterministic;
config.internalAgents.managerDeterministic = false;
check("disabled when flag off", managerDeterministicEnabled(config) === false);
config.internalAgents.managerDeterministic = true;
check("enabled when flag on", managerDeterministicEnabled(config) === true);

// ─── 1) Flag OFF → null ────────────────────────────────────────────────────
console.log("\n[1] flag-off short-circuit");
config.internalAgents.managerDeterministic = false;
resetCalls();
const offRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15 })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("flag OFF → returns null", offRes === null);
check("flag OFF → executeTool not invoked", calls.length === 0);

// Re-enable for the rest of the suite
config.internalAgents.managerDeterministic = true;

// ─── 2) Empty positions list ───────────────────────────────────────────────
console.log("\n[2] empty positions list");
resetCalls();
const emptyRes = await runDeterministicManagement({
  positions: [],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("empty → result object returned (not null)", emptyRes !== null);
check("empty → processed === 0", emptyRes?.processed === 0);
check("empty → closed/claimed/errors all empty", emptyRes?.closed.length === 0 && emptyRes?.claimed.length === 0 && emptyRes?.errors.length === 0);
check("empty → executeTool not invoked", calls.length === 0);

// ─── 3) Stop loss (rule 1) ─────────────────────────────────────────────────
console.log("\n[3] stop loss → close_position");
resetCalls();
const slRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15, position: "PosSL11111111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("SL → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("SL → position_address matches", calls[0]?.args?.position_address === "PosSL11111111111111111111111111111111111");
check("SL → reason = 'stop loss'", calls[0]?.args?.reason === "stop loss");
check("SL → closed list has 1 entry", slRes.closed.length === 1);
check("SL → closed entry rule === 1", slRes.closed[0]?.rule === 1);

// ─── 4) Take profit (rule 2) ───────────────────────────────────────────────
console.log("\n[4] take profit → close_position");
resetCalls();
const tpRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: 150, position: "PosTP11111111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("TP → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("TP → reason = 'take profit'", calls[0]?.args?.reason === "take profit");
check("TP → closed rule === 2", tpRes.closed[0]?.rule === 2);

// ─── 5) Pumped far above range (rule 3) ────────────────────────────────────
console.log("\n[5] pumped far above range → close_position");
resetCalls();
const pumpedRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 5,
    active_bin: 200, // upper=140 + outOfRangeBinsToClose=10 → 150; 200 > 150
    position: "PosPump111111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("pumped → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("pumped → rule === 3", pumpedRes.closed[0]?.rule === 3);
check("pumped → reason = 'pumped far above range'", calls[0]?.args?.reason === "pumped far above range");

// ─── 6) OOR > timeout (rule 4) ─────────────────────────────────────────────
console.log("\n[6] OOR > timeout → close_position");
resetCalls();
const oorRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 0,
    active_bin: 145, // upper=140 → out but not "pumped"; OOR mins kick in
    minutes_out_of_range: 35, // > outOfRangeWaitMinutes=30
    position: "PosOOR111111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("OOR → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("OOR → rule === 4", oorRes.closed[0]?.rule === 4);
check("OOR → reason = 'OOR'", calls[0]?.args?.reason === "OOR");

// ─── 7) Low yield (rule 5) ─────────────────────────────────────────────────
console.log("\n[7] low yield → close_position");
resetCalls();
const lyRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 0,
    fee_per_tvl_24h: 3, // < minFeePerTvl24h=7
    age_minutes: 90, // >= 60
    position: "PosLY1111111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("low yield → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("low yield → rule === 5", lyRes.closed[0]?.rule === 5);

// ─── 8) Confirmed trailing TP from exitMap ─────────────────────────────────
console.log("\n[8] confirmed trailing-TP from exitMap → close_position");
resetCalls();
const exitMap = new Map();
exitMap.set("PosTrail1111111111111111111111111111111", "Trailing TP: peak 50% → current 38% (dropped 12% >= 10%)");
const trailRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 38, // healthy by rule standards
    position: "PosTrail1111111111111111111111111111111",
  })],
  exitMap,
  mgmtConfig: mgmt,
});
check("exit signal → close_position invoked", calls.length === 1 && calls[0].name === "close_position");
check("exit signal → closed entry rule === 'exit'", trailRes.closed[0]?.rule === "exit");
check("exit signal → reason includes 'Trailing TP'", String(calls[0]?.args?.reason).includes("Trailing TP"));

// ─── 9) INSTRUCTION → DEFERRED (no tool call) ──────────────────────────────
console.log("\n[9] INSTRUCTION position → deferred, no close");
resetCalls();
const instrRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: -15, // would otherwise hit SL
    instruction: "hold until +20%",
    position: "PosInstr111111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("INSTRUCTION → executeTool NOT invoked", calls.length === 0);
check("INSTRUCTION → deferred list has 1 entry", instrRes.deferred.length === 1);
check("INSTRUCTION → no closes", instrRes.closed.length === 0);

// ─── 10) Healthy position → STAY, no tool call ─────────────────────────────
console.log("\n[10] healthy position → STAY");
resetCalls();
const healthyRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 5,
    in_range: true,
    fee_per_tvl_24h: 20,
    age_minutes: 30,
    unclaimed_fees_usd: 0,
    position: "PosHealth1111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("healthy → executeTool NOT invoked", calls.length === 0);
check("healthy → stay list has 1 entry", healthyRes.stay.length === 1);
check("healthy → no closes", healthyRes.closed.length === 0);

// ─── 11) Claim fees → claim_fees invoked ───────────────────────────────────
console.log("\n[11] claimable fees → claim_fees");
resetCalls();
const claimRes = await runDeterministicManagement({
  positions: [makePosition({
    pnl_pct: 5,
    in_range: true,
    fee_per_tvl_24h: 20,
    unclaimed_fees_usd: 10, // >= minClaimAmount=5
    position: "PosClaim1111111111111111111111111111111",
  })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("claim → claim_fees invoked", calls.length === 1 && calls[0].name === "claim_fees");
check("claim → position_address matches", calls[0]?.args?.position_address === "PosClaim1111111111111111111111111111111");
check("claim → no close called", !calls.some(c => c.name === "close_position"));
check("claim → claimed list has 1 entry", claimRes.claimed.length === 1);

// ─── 12) Suspect PnL guard — PnL <= -90 with value → no SL ────────────────
console.log("\n[12] suspect PnL guard");
resetCalls();
// pnlSuspect requires a getTracked() returning amount_sol. The manager imports
// getTrackedPosition from state.js at module-load — we can't easily stub that
// without intrusion. Instead, check the pure-function path: pass an inline
// tracked-lookup that simulates the registered position.
const suspectRule = getDeterministicCloseRule(
  makePosition({ pnl_pct: -95, total_value_usd: 50 }),
  mgmt,
  () => ({ amount_sol: 0.1 }), // tracked position with deploy amount
);
check("suspect PnL → no rule fired (skipped)", suspectRule === null);

// Non-suspect: same PnL but no tracked deploy_amount → SL fires
const nonSuspectRule = getDeterministicCloseRule(
  makePosition({ pnl_pct: -95, total_value_usd: 50 }),
  mgmt,
  () => null,
);
check("non-tracked + -95% PnL → SL rule fires", nonSuspectRule?.rule === 1);

// ─── 13) Multiple positions, mixed signals ─────────────────────────────────
console.log("\n[13] multiple positions, mixed");
resetCalls();
const mixed = [
  makePosition({ pnl_pct: -15, position: "PosM1111111111111111111111111111111111111", pair: "M1-SOL" }),
  makePosition({ pnl_pct: 5, unclaimed_fees_usd: 10, position: "PosM2222222222222222222222222222222222222", pair: "M2-SOL" }),
  makePosition({ pnl_pct: 5, fee_per_tvl_24h: 20, position: "PosM3333333333333333333333333333333333333", pair: "M3-SOL" }),
];
const mixedRes = await runDeterministicManagement({
  positions: mixed,
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("mixed → exactly 2 tool calls (close + claim)", calls.length === 2);
check("mixed → 1 close_position", calls.filter(c => c.name === "close_position").length === 1);
check("mixed → 1 claim_fees", calls.filter(c => c.name === "claim_fees").length === 1);
check("mixed → closed=1, claimed=1, stay=1", mixedRes.closed.length === 1 && mixedRes.claimed.length === 1 && mixedRes.stay.length === 1);

// ─── 14) executeTool returns blocked → captured in errors ──────────────────
console.log("\n[14] executeTool blocked → error captured");
stubBehavior = "blocked";
resetCalls();
const blockedRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15, position: "PosBlk1111111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("blocked → tool called once", calls.length === 1);
check("blocked → no closes recorded", blockedRes.closed.length === 0);
check("blocked → error captured", blockedRes.errors.length === 1);
check("blocked → error includes 'blocked'", String(blockedRes.errors[0]?.error || "").includes("blocked"));

// ─── 15) executeTool returns error → captured ──────────────────────────────
console.log("\n[15] executeTool error → captured");
stubBehavior = "error";
resetCalls();
const errRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15, position: "PosErr1111111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("tool error → error captured", errRes.errors.length === 1 && errRes.errors[0]?.error === "RPC timeout");

// ─── 16) executeTool throws → captured ─────────────────────────────────────
console.log("\n[16] executeTool throws → captured");
stubBehavior = "throw";
resetCalls();
const throwRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15, position: "PosThrow11111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("tool throw → error captured", throwRes.errors.length === 1);
check("tool throw → error message present", String(throwRes.errors[0]?.error || "").includes("rpc network down"));

// ─── 17) executeTool success=false → captured ──────────────────────────────
console.log("\n[17] executeTool success=false → captured");
stubBehavior = "successFalse";
resetCalls();
const sfRes = await runDeterministicManagement({
  positions: [makePosition({ pnl_pct: -15, position: "PosSF111111111111111111111111111111111111" })],
  exitMap: new Map(),
  mgmtConfig: mgmt,
});
check("success=false → no close recorded", sfRes.closed.length === 0);
check("success=false → error captured", sfRes.errors.length === 1);

// Restore OK behavior
stubBehavior = "ok";

// ─── 18) buildActionMap pure-function sanity ───────────────────────────────
console.log("\n[18] buildActionMap pure function");
const ampMap = buildActionMap(
  [
    makePosition({ pnl_pct: -15, position: "ActMap1" }),
    makePosition({ pnl_pct: 5, position: "ActMap2", unclaimed_fees_usd: 10 }),
    makePosition({ pnl_pct: 5, position: "ActMap3" }),
    makePosition({ pnl_pct: 5, position: "ActMap4", instruction: "wait" }),
  ],
  new Map(),
  mgmt,
);
check("buildActionMap returns Map", ampMap instanceof Map);
check("ActMap1 → CLOSE", ampMap.get("ActMap1")?.action === "CLOSE");
check("ActMap2 → CLAIM", ampMap.get("ActMap2")?.action === "CLAIM");
check("ActMap3 → STAY", ampMap.get("ActMap3")?.action === "STAY");
check("ActMap4 (instruction) → DEFERRED", ampMap.get("ActMap4")?.action === "DEFERRED");

// ─── Cleanup ───────────────────────────────────────────────────────────────
__setExecuteToolForTests(null);
config.internalAgents.managerDeterministic = origFlag;

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n──────────────────────`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.error("MANAGER TEST FAILED");
  process.exit(1);
}
console.log("MANAGER TEST OK");
