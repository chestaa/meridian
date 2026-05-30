// scripts/test-rebalance-oor.js
// Vega Item 9 — Rebalance-on-OOR re-center validation.
//
// Proves, with NO live wallet / NO RPC / NO real TX:
//   A. state.js gate (updatePnlAndCheckExits):
//      1. OOR + organic 85 + flag ON + under cap → REBALANCE_OOR
//      2. OOR + organic 70             → OUT_OF_RANGE (below min organic)
//      3. rebalance_count = maxRebalances → OUT_OF_RANGE (cap hit)
//      4. flag OFF                     → OUT_OF_RANGE (legacy, no change)
//   B. agents/rebalance.js orchestrator (executeTool mocked):
//      5. happy path → close + re-deploy SAME capital, rebalance_count++, never
//         exceeds maxDeployAmount
//      6. fees < friction → SKIP re-center, hard close (closed_friction)
//      7. re-deploy error AFTER close → fail-safe (closed_fallback, no retry)
//      8. close error BEFORE re-deploy → no re-deploy (closed_error, anti-retry)
//      9. hardcap: tracked capital > maxDeployAmount → re-deploy clamped to cap
//   C. dlmm.estimateRebalanceFrictionSol is positive + scales with capital.
//
// Driven against the REAL state.js + REAL orchestrator. executeTool is mocked
// via agents/rebalance.js#__setForTests so we observe the exact close/deploy
// dispatch sequence without touching the chain.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
if (!fs.existsSync(path.join(ROOT, "state.js"))) {
  console.error("ERROR: run this test from the Meridian repo root (cwd has no state.js).");
  process.exit(1);
}

const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.rbl-bak");
let hadState = false;
if (fs.existsSync(STATE_FILE)) {
  fs.copyFileSync(STATE_FILE, STATE_BACKUP);
  hadState = true;
}
function writeState(positions) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions, recentEvents: [], lastUpdated: null }, null, 2));
}
function readPos(addr) {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  return s.positions[addr];
}
function cleanup() {
  if (hadState) fs.copyFileSync(STATE_BACKUP, STATE_FILE);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(STATE_BACKUP)) fs.unlinkSync(STATE_BACKUP);
}

const { updatePnlAndCheckExits } = await import("../state.js");
const { config } = await import("../config.js");
const { estimateRebalanceFrictionSol } = await import("../tools/dlmm.js");
const rebalanceMod = await import("../agents/rebalance.js");
const { rebalanceOnOor, computeBinsBelow, estimateAccumulatedFeesSol } = rebalanceMod;

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

const MGMT = {
  stopLossPct: -50,
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  partialTpEnabled: true,
  partialTpTriggerPct: 15,
  partialTpPct: 50,
  velocityExitEnabled: true,
  velocityDropPct: 15,
  rebalanceOnOorEnabled: true,
  rebalanceOnOorMinOrganic: 80,
  maxRebalances: 3,
  outOfRangeWaitMinutes: 20,
  deployAmountSol: 0.5,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
};
const STRATEGY = { minBinsBelow: 35, maxBinsBelow: 69, defaultBinsBelow: 50 };

function trackedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "RBL-SOL",
    base_mint: "BASExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    closed: false,
    out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    peak_pnl_pct: 0,
    trailing_active: false,
    partial_tp_done: true, // isolate from partial path
    organic_score: 90,
    rebalance_count: 0,
    amount_sol: 0.03,
    volatility: 5,
    bin_step: 100,
    strategy: "spot",
    total_fees_claimed_usd: 0,
    notes: [],
    deployed_at: new Date(Date.now() - 90 * 60000).toISOString(),
    confirmed_trailing_exit_until: null,
    confirmed_trailing_exit_reason: null,
    pending_peak_pnl_pct: null,
    ...overrides,
  };
}

try {
  console.log("test-rebalance-oor.js — Vega Item 9 re-center validation\n");

  // ════════════════════════════════════════════════════════════════════════
  // A. state.js gate
  // ════════════════════════════════════════════════════════════════════════
  console.log("A. state.js REBALANCE_OOR gate");

  // 1. OOR + organic 85 + flag ON + under cap → REBALANCE_OOR
  {
    const addr = "RBLA1111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 85, rebalance_count: 0 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, MGMT);
    check("OOR + organic 85 + flag ON + count 0/3 → REBALANCE_OOR", () => {
      assert.ok(r);
      assert.equal(r.action, "REBALANCE_OOR");
      assert.equal(r.rebalance_count, 0);
      assert.equal(r.max_rebalances, 3);
    });
  }

  // 2. OOR + organic 70 → OUT_OF_RANGE (below rebalanceMinOrganic)
  {
    const addr = "RBLA2222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 70 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, MGMT);
    check("OOR + organic 70 (< 80) → OUT_OF_RANGE (hard close)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }

  // 3. rebalance_count = maxRebalances → OUT_OF_RANGE (cap hit)
  {
    const addr = "RBLA3333333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, rebalance_count: 3 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, MGMT);
    check("rebalance_count 3 == max 3 → OUT_OF_RANGE (cap hit)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }
  // 3b. count just under cap still rebalances
  {
    const addr = "RBLA3b33333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, rebalance_count: 2 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, MGMT);
    check("rebalance_count 2 < max 3 → REBALANCE_OOR (still under cap)", () => {
      assert.ok(r);
      assert.equal(r.action, "REBALANCE_OOR");
    });
  }

  // 4. flag OFF → OUT_OF_RANGE (legacy, no behavior change)
  {
    const addr = "RBLA4444444444444444444444444444444444444444";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: false });
    check("flag OFF + organic 90 → OUT_OF_RANGE (no behavior change)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // B. orchestrator (executeTool mocked)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\nB. agents/rebalance.js orchestrator (mocked executeTool)");

  // Helper: build a mock executeTool with scriptable per-tool behavior + a
  // recorded call log so we can assert the dispatch sequence + args.
  function makeMockExecuteTool(behaviors = {}) {
    const calls = [];
    const fn = async (name, args) => {
      calls.push({ name, args });
      if (typeof behaviors[name] === "function") return behaviors[name](args, calls);
      // sane defaults
      if (name === "get_active_bin") return { active_bin: 4242 };
      if (name === "get_pool_detail") return { volatility: 5, bin_step: 100 };
      if (name === "close_position") return { success: true, sol_received: 0.029, base_mint: "BASExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" };
      if (name === "deploy_position") return { success: true, position: "NEWPOSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" };
      return { success: true };
    };
    return { fn, calls };
  }

  // 5. happy path → close then re-deploy SAME capital, count++, <= hardcap
  {
    const addr = "RBLB5555555555555555555555555555555555555555";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, rebalance_count: 1, amount_sol: 0.03 }) });
    const { fn, calls } = makeMockExecuteTool();
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 0.01 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m organic 90" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();

    check("happy: outcome === rebalanced, redeployed true", () => {
      assert.equal(rb.outcome, "rebalanced");
      assert.equal(rb.redeployed, true);
    });
    check("happy: dispatch order = get_active_bin → ... → close → deploy", () => {
      const names = calls.map((c) => c.name);
      const closeIdx = names.indexOf("close_position");
      const deployIdx = names.indexOf("deploy_position");
      assert.ok(closeIdx >= 0 && deployIdx >= 0);
      assert.ok(closeIdx < deployIdx, "close must precede deploy");
    });
    check("happy: re-deploy uses SAME/less capital (<= tracked 0.03)", () => {
      const dep = calls.find((c) => c.name === "deploy_position");
      assert.ok(dep);
      assert.ok(dep.args.amount_y <= 0.03, `amount_y ${dep.args.amount_y} must be <= tracked 0.03`);
      assert.ok(dep.args.amount_y > 0);
    });
    check("happy: re-deploy single-side SOL (amount_x=0, bins_above=0)", () => {
      const dep = calls.find((c) => c.name === "deploy_position");
      assert.equal(dep.args.amount_x, 0);
      assert.equal(dep.args.bins_above, 0);
      assert.equal(dep.args.active_bin, 4242);
    });
    check("happy: re-deploy NEVER exceeds maxDeployAmount", () => {
      const dep = calls.find((c) => c.name === "deploy_position");
      assert.ok(dep.args.amount_y <= config.risk.maxDeployAmount);
    });
    check("happy: rebalance_count incremented 1 → 2 in state", () => {
      assert.equal(readPos(addr).rebalance_count, 2);
      assert.equal(readPos(addr).out_of_range_since, null);
    });
  }

  // 6. fees < friction → SKIP re-center, hard close (NO deploy)
  {
    const addr = "RBLB6666666666666666666666666666666666666666";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, amount_sol: 0.03, total_fees_claimed_usd: 0 }) });
    const { fn, calls } = makeMockExecuteTool();
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 0.0000001 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m organic 90" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();
    check("friction: outcome === closed_friction (fees too low)", () => {
      assert.equal(rb.outcome, "closed_friction");
      assert.equal(rb.redeployed, false);
    });
    check("friction: closed but NEVER re-deployed", () => {
      const names = calls.map((c) => c.name);
      assert.ok(names.includes("close_position"));
      assert.ok(!names.includes("deploy_position"), "must NOT deploy when fees < friction");
    });
  }

  // 7. re-deploy ERROR after close → fail-safe (closed_fallback, no retry)
  {
    const addr = "RBLB7777777777777777777777777777777777777777";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, amount_sol: 0.03 }) });
    const { fn, calls } = makeMockExecuteTool({
      deploy_position: async () => ({ success: false, error: "RPC blockhash expired" }),
    });
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 0.02 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m organic 90" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();
    check("deploy-fail: outcome === closed_fallback (capital safe as SOL)", () => {
      assert.equal(rb.outcome, "closed_fallback");
      assert.equal(rb.redeployed, false);
    });
    check("deploy-fail: exactly ONE deploy attempt (NO retry — anti-pattern #4)", () => {
      const deploys = calls.filter((c) => c.name === "deploy_position");
      assert.equal(deploys.length, 1);
    });
    check("deploy-fail: rebalance_count NOT incremented (no confirmed re-center)", () => {
      assert.equal(readPos(addr).rebalance_count, 0);
    });
  }

  // 8. close ERROR before re-deploy → no re-deploy at all (anti-retry)
  {
    const addr = "RBLB8888888888888888888888888888888888888888";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, amount_sol: 0.03 }) });
    const { fn, calls } = makeMockExecuteTool({
      close_position: async () => ({ success: false, error: "close tx failed" }),
    });
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 0.02 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m organic 90" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();
    check("close-fail: outcome === closed_error, redeployed false", () => {
      assert.equal(rb.outcome, "closed_error");
      assert.equal(rb.redeployed, false);
    });
    check("close-fail: NEVER deploys on top of a failed close (state unknown)", () => {
      const names = calls.map((c) => c.name);
      assert.ok(!names.includes("deploy_position"), "must NOT deploy after close failure");
    });
  }
  // 8b. close THROWS → closed_error, no deploy
  {
    const addr = "RBLB8b88888888888888888888888888888888888888";
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, amount_sol: 0.03 }) });
    const { fn, calls } = makeMockExecuteTool({
      close_position: async () => { throw new Error("network down"); },
    });
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 0.02 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();
    check("close-throw: outcome closed_error, no deploy, no count++", () => {
      assert.equal(rb.outcome, "closed_error");
      assert.ok(!calls.map((c) => c.name).includes("deploy_position"));
      assert.equal(readPos(addr).rebalance_count, 0);
    });
  }

  // 9. hardcap: tracked capital > maxDeployAmount → re-deploy clamped
  {
    const addr = "RBLB9999999999999999999999999999999999999999";
    const huge = config.risk.maxDeployAmount + 1000;
    writeState({ [addr]: trackedFixture(addr, { organic_score: 90, amount_sol: huge }) });
    const { fn, calls } = makeMockExecuteTool({
      // sol_received also huge → must STILL be clamped by hardcap
      close_position: async () => ({ success: true, sol_received: huge, base_mint: "BASE" }),
    });
    rebalanceMod.__setForTests({ executeTool: fn });
    const rb = await rebalanceOnOor({
      position: { position: addr, pool: "POOLrblxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pair: "RBL-SOL", unclaimed_fees_sol: 9999 },
      exit: { action: "REBALANCE_OOR", reason: "OOR 30m" },
      mgmtConfig: MGMT,
      strategyConfig: STRATEGY,
      solUsd: 150,
    });
    rebalanceMod.__resetTests();
    check("hardcap: re-deploy amount clamped to <= maxDeployAmount", () => {
      const dep = calls.find((c) => c.name === "deploy_position");
      assert.ok(dep, "deploy must be attempted");
      assert.ok(dep.args.amount_y <= config.risk.maxDeployAmount,
        `amount_y ${dep.args.amount_y} must be <= maxDeployAmount ${config.risk.maxDeployAmount}`);
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // C. helpers
  // ════════════════════════════════════════════════════════════════════════
  console.log("\nC. friction + bins helpers");
  check("estimateRebalanceFrictionSol positive + scales with capital", () => {
    const f1 = estimateRebalanceFrictionSol({ amountSol: 0.03 });
    const f2 = estimateRebalanceFrictionSol({ amountSol: 0.5 });
    assert.ok(f1 > 0);
    assert.ok(f2 > f1, "larger capital → more slippage friction");
  });
  check("estimateRebalanceFrictionSol NaN input → safe non-zero floor", () => {
    const f = estimateRebalanceFrictionSol({ amountSol: NaN });
    assert.ok(f > 0, "NaN capital must never read as free-to-rebalance");
  });
  check("computeBinsBelow clamps to [min,max] and uses default for v<=0", () => {
    assert.equal(computeBinsBelow(5, STRATEGY), 69); // v=5 → max
    assert.equal(computeBinsBelow(0, STRATEGY), 50); // v<=0 → default
    const mid = computeBinsBelow(2.5, STRATEGY);
    assert.ok(mid >= 35 && mid <= 69);
  });
  check("estimateAccumulatedFeesSol folds unclaimed SOL + claimed USD", () => {
    const sol = estimateAccumulatedFeesSol(
      { unclaimed_fees_sol: 0.01 },
      { total_fees_claimed_usd: 15 },
      150, // 15 USD / 150 = 0.1 SOL
    );
    assert.ok(Math.abs(sol - 0.11) < 1e-6, `expected ~0.11, got ${sol}`);
  });

  console.log(`\n${assertions} assertions PASSED`);
} catch (err) {
  console.error("\nFAIL:", err.message);
  console.error(err.stack);
  cleanup();
  process.exit(1);
} finally {
  rebalanceMod.__resetTests?.();
}
cleanup();
console.log("cleanup done.");
