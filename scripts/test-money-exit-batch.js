// scripts/test-money-exit-batch.js
// Vega money/exit/sizing batch — thorough money-logic coverage.
//
// Covers:
//   Item 2A — trailing arms at +18% not +40% (config + behavior)
//   Item 2B — partial TP: peak +15% → 50% scaled out, account stays open,
//             partial_tp_done set, fires ONCE only (idempotent)
//   Item 6  — velocity exit: profit + 1h price -16% + net_buyers<0 → exit
//   Item 7  — dynamic sizing: conf 75→0.1, 85→0.2, 95→0.2(capped), NEVER >maxDeployAmount
//   Item 9  — rebalance flag OFF → legacy hard close (no behavior change)
//
// Money-path guards asserted: partial TP idempotency, dynamic-sizing hard cap,
// velocity precedence, rebalance OFF.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// state.js uses a CWD-relative "./state.json". Align this test to the SAME
// path so writeState() and updatePnlAndCheckExits() read/write the same file.
// MUST be run from the repo root.
const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.test-bak");
if (!fs.existsSync(path.join(ROOT, "state.js"))) {
  console.error("ERROR: run this test from the Meridian repo root (cwd has no state.js).");
  process.exit(1);
}

// ── Backup real state.json so live-path tests can install fixtures ──
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

const { updatePnlAndCheckExits, markPartialTpDone } = await import("../state.js");
const { evaluatePaperExit } = await import("../paper-trades.js");
const { config, computeDeployAmount, computeDynamicDeployAmount } = await import("../config.js");
const { estimateAccumulatedFeesSol } = await import("../agents/rebalance.js");
const { estimateRebalanceFrictionSol } = await import("../tools/dlmm.js");

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
  rebalanceOnOorEnabled: false,
  rebalanceOnOorMinOrganic: 80,
  outOfRangeWaitMinutes: 20,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
};

function trackedFixture(addr, overrides = {}) {
  return {
    position: addr,
    pool: "POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    pool_name: "TEST-SOL",
    closed: false,
    out_of_range_since: null,
    peak_pnl_pct: 0,
    trailing_active: false,
    partial_tp_done: false,
    partial_tp_at: null,
    organic_score: 50,
    notes: [],
    deployed_at: new Date(Date.now() - 90 * 60000).toISOString(),
    confirmed_trailing_exit_until: null,
    confirmed_trailing_exit_reason: null,
    pending_peak_pnl_pct: null,
    ...overrides,
  };
}

try {
  console.log("test-money-exit-batch.js — Vega money/exit/sizing batch\n");

  // ─────────────────────────────────────────────────────────────
  // Item 2A — Config: trailing arms at +18% not +40%
  // ─────────────────────────────────────────────────────────────
  console.log("Item 2A — trailing trigger lowered");
  check("config default trailingTriggerPct === 18", () => {
    assert.equal(config.management.trailingTriggerPct, 18);
  });
  check("config default trailingDropPct === 6", () => {
    assert.equal(config.management.trailingDropPct, 6);
  });

  // Live behavior: peak 20% arms trailing (was impossible at 40%).
  // partial_tp_done=true to isolate trailing from the partial-TP path (which
  // would otherwise fire first at +20% — tested separately under Item 2B).
  {
    const addr = "PARM1111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 20, partial_tp_done: true }) });
    // First call: arms trailing (peak 20 >= 18), current 20 → no drop yet.
    const r1 = updatePnlAndCheckExits(addr, { pnl_pct: 20, in_range: true }, MGMT);
    check("peak 20% arms trailing at trigger 18 (no immediate exit)", () => {
      assert.equal(r1, null);
      assert.equal(readPos(addr).trailing_active, true);
    });
    // Now drop 6% from peak → trailing TP fires.
    const r2 = updatePnlAndCheckExits(addr, { pnl_pct: 14, in_range: true }, MGMT);
    check("drop 6% from peak → TRAILING_TP fires (needs_confirmation)", () => {
      assert.ok(r2);
      assert.equal(r2.action, "TRAILING_TP");
    });
  }
  // At a peak of 17% (below 18 trigger) trailing must NOT arm.
  // (17 >= 15 partial trigger, so set partial_tp_done to isolate trailing.)
  {
    const addr = "PARM2222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 17, partial_tp_done: true }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 5, in_range: true }, MGMT);
    check("peak 17% (< 18) → trailing NOT armed, no exit", () => {
      assert.equal(r, null);
      assert.equal(readPos(addr).trailing_active, false);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Item 2B — Partial TP (LIVE path via state.js + markPartialTpDone)
  // ─────────────────────────────────────────────────────────────
  console.log("\nItem 2B — partial TP scale-out (live)");
  {
    const addr = "PTP11111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 16 }) });
    // peak 16 >= 15 trigger, not done → PARTIAL_TP
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 16, in_range: true }, MGMT);
    check("peak +16% → PARTIAL_TP action, partial_pct=50", () => {
      assert.ok(r);
      assert.equal(r.action, "PARTIAL_TP");
      assert.equal(r.partial_pct, 50);
    });
    // Caller marks done (simulating confirmed partial TX).
    const flipped = markPartialTpDone(addr);
    check("markPartialTpDone flips false→true (returns true)", () => {
      assert.equal(flipped, true);
      assert.equal(readPos(addr).partial_tp_done, true);
      assert.ok(readPos(addr).partial_tp_at);
    });
    // Idempotency: second mark refuses (returns false).
    const flippedAgain = markPartialTpDone(addr);
    check("markPartialTpDone refuses second fire (returns false)", () => {
      assert.equal(flippedAgain, false);
    });
    // After done, updatePnlAndCheckExits NEVER returns PARTIAL_TP again — even
    // at a higher peak. Account stays open (no close action).
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 30, partial_tp_done: true }) });
    const r2 = updatePnlAndCheckExits(addr, { pnl_pct: 28, in_range: true }, MGMT);
    check("partial_tp_done=true → PARTIAL_TP never fires again (fires ONCE)", () => {
      assert.ok(r2 === null || r2.action !== "PARTIAL_TP");
      // (trailing may arm at 30 but no second partial)
    });
  }
  // Stop loss pre-empts partial TP (crash = full close, never scale out).
  {
    const addr = "PTP22222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 16 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: -55, in_range: true }, { ...MGMT, stopLossPct: -50 });
    check("stop loss pre-empts partial TP (full close on crash)", () => {
      assert.ok(r);
      assert.equal(r.action, "STOP_LOSS");
    });
  }
  // partialTpEnabled=false → no partial path (silent revert).
  {
    const addr = "PTP33333333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 16 }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 16, in_range: true }, { ...MGMT, partialTpEnabled: false });
    check("partialTpEnabled=false → no PARTIAL_TP (reversible)", () => {
      assert.ok(r === null || r.action !== "PARTIAL_TP");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Item 2B — Partial TP (PAPER mirror)
  // ─────────────────────────────────────────────────────────────
  console.log("\nItem 2B — partial TP scale-out (paper)");
  {
    const trade = {
      status: "open",
      opened_at: new Date(Date.now() - 30 * 60000).toISOString(),
      pool_name: "PT-SOL",
      pool_address: "POOLpaper",
      amount_sol: 0.2,
      original_amount_sol: 0.2,
      entry_price: 1.0,
      peak_pnl_pct: 0,
      partial_tp_done: false,
      min_pnl_pct: 0,
      max_drawdown_pct: 0,
      notes: [],
    };
    // peak +16% → partial fires, no exit returned, amount halved, done flag set.
    const r = evaluatePaperExit(trade, { price_proxy_pnl_pct: 16, price: 1.16, price_change_1h_pct: 5, net_buyers_1h: 20 }, MGMT);
    check("paper peak +16% → partial fires (no exit), amount 0.2→0.1, done", () => {
      assert.equal(r, null); // partial is NOT a close
      assert.equal(trade.partial_tp_done, true);
      assert.equal(trade.amount_sol, 0.1);
      assert.equal(trade.original_amount_sol, 0.2);
    });
    // Second refresh at even higher peak → does NOT partial again (fires once).
    const before = trade.amount_sol;
    const r2 = evaluatePaperExit(trade, { price_proxy_pnl_pct: 25, price: 1.25, price_change_1h_pct: 5, net_buyers_1h: 20 }, MGMT);
    check("paper partial fires ONCE — amount unchanged on second pass", () => {
      assert.equal(trade.amount_sol, before);
      assert.ok(r2 === null || r2.action !== "PARTIAL_TP");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Item 6 — Velocity-drop exit
  // ─────────────────────────────────────────────────────────────
  console.log("\nItem 6 — velocity-drop exit");
  // LIVE: profit + 1h -16% + net_buyers -5 → VELOCITY_EXIT
  {
    const addr = "VEL11111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5, partial_tp_done: true }) });
    const r = updatePnlAndCheckExits(addr, {
      pnl_pct: 4, in_range: true, price_change_1h_pct: -16, net_buyers_1h: -5,
    }, MGMT);
    check("live: profit + 1h -16% + net_buyers<0 → VELOCITY_EXIT", () => {
      assert.ok(r);
      assert.equal(r.action, "VELOCITY_EXIT");
    });
  }
  // LIVE: not in profit → velocity does NOT fire (SL owns downside).
  {
    const addr = "VEL22222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5, partial_tp_done: true }) });
    const r = updatePnlAndCheckExits(addr, {
      pnl_pct: -3, in_range: true, price_change_1h_pct: -16, net_buyers_1h: -5,
    }, MGMT);
    check("live: NOT in profit → no velocity exit", () => {
      assert.ok(r === null || r.action !== "VELOCITY_EXIT");
    });
  }
  // LIVE: net_buyers positive → no velocity (need sellers winning).
  {
    const addr = "VEL33333333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5, partial_tp_done: true }) });
    const r = updatePnlAndCheckExits(addr, {
      pnl_pct: 4, in_range: true, price_change_1h_pct: -16, net_buyers_1h: 3,
    }, MGMT);
    check("live: net_buyers>0 → no velocity exit", () => {
      assert.ok(r === null || r.action !== "VELOCITY_EXIT");
    });
  }
  // LIVE: velocityExitEnabled=false → reversible off.
  {
    const addr = "VEL44444444444444444444444444444444444444444";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 5, partial_tp_done: true }) });
    const r = updatePnlAndCheckExits(addr, {
      pnl_pct: 4, in_range: true, price_change_1h_pct: -16, net_buyers_1h: -5,
    }, { ...MGMT, velocityExitEnabled: false });
    check("live: velocityExitEnabled=false → no velocity exit (reversible)", () => {
      assert.ok(r === null || r.action !== "VELOCITY_EXIT");
    });
  }
  // PAPER mirror: profit + 1h -16% + net_buyers<0 → VELOCITY_EXIT
  {
    const trade = {
      status: "open",
      opened_at: new Date(Date.now() - 30 * 60000).toISOString(),
      pool_name: "VP-SOL", pool_address: "POOLvp", amount_sol: 0.2,
      entry_price: 1.0, peak_pnl_pct: 5, partial_tp_done: true,
      min_pnl_pct: 0, max_drawdown_pct: 0, notes: [],
    };
    const r = evaluatePaperExit(trade, {
      price_proxy_pnl_pct: 4, price: 1.04, price_change_1h_pct: -16, net_buyers_1h: -5,
    }, MGMT);
    check("paper: profit + 1h -16% + net_buyers<0 → VELOCITY_EXIT", () => {
      assert.ok(r);
      assert.equal(r.action, "VELOCITY_EXIT");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Item 7 — Dynamic sizing by Orion confidence (HARD CAP proof)
  // ─────────────────────────────────────────────────────────────
  console.log("\nItem 7 — dynamic sizing (cap proof)");
  // Live maxDeployAmount is 0.20 (user-config). base computeDeployAmount floor
  // is deployAmountSol=0.20. So base ≈ 0.20. Use an explicit base of 0.2 to
  // exercise the tiers deterministically against the live ceiling.
  const MAX = config.risk.maxDeployAmount;
  check(`live maxDeployAmount is ${MAX}`, () => {
    assert.ok(Number.isFinite(MAX) && MAX > 0);
  });
  // Use base = 0.2 (matches live floor). Tiers: 0.5x / 1x / 1.5x.
  const BASE = 0.2;
  check("conf 75 → 0.5x base = 0.1", () => {
    assert.equal(computeDynamicDeployAmount(BASE, 75), 0.1);
  });
  check("conf 85 → 1x base = 0.2", () => {
    assert.equal(computeDynamicDeployAmount(BASE, 85), 0.2);
  });
  check("conf 95 → 1.5x base = 0.3 BUT capped at maxDeployAmount (0.2)", () => {
    const sized = computeDynamicDeployAmount(BASE, 95);
    assert.equal(sized, Math.min(0.3, MAX)); // 0.2 when MAX=0.2
    assert.ok(sized <= MAX, "must never exceed maxDeployAmount");
  });
  // EXHAUSTIVE cap proof: across full confidence + base range, NEVER > MAX.
  check("EXHAUSTIVE: computeDynamicDeployAmount never exceeds maxDeployAmount", () => {
    for (let conf = 0; conf <= 100; conf += 1) {
      for (const base of [0.01, 0.1, 0.2, 0.5, 1, 5, 50, 1000]) {
        const sized = computeDynamicDeployAmount(base, conf);
        assert.ok(sized <= MAX + 1e-9, `conf=${conf} base=${base} sized=${sized} > MAX=${MAX}`);
      }
    }
  });
  // dynamicSizingEnabled=false → fixed base (still capped).
  check("dynamicSizingEnabled=false → fixed base, still capped", () => {
    const cfg = { risk: { maxDeployAmount: MAX, dynamicSizingEnabled: false, sizingTiers: config.risk.sizingTiers } };
    const sized = computeDynamicDeployAmount(0.5, 95, cfg);
    assert.equal(sized, Math.min(0.5, MAX));
    assert.ok(sized <= MAX);
  });
  // Confidence below lowest tier → mult 1.0 (conservative base), capped.
  check("conf 50 (below tiers) → base mult 1.0, capped", () => {
    const sized = computeDynamicDeployAmount(BASE, 50);
    assert.ok(sized <= MAX);
    assert.equal(sized, Math.min(BASE, MAX));
  });

  // ─────────────────────────────────────────────────────────────
  // Item 9 — Rebalance-on-OOR flag OFF → legacy hard close
  // ─────────────────────────────────────────────────────────────
  console.log("\nItem 9 — rebalance-on-OOR flag");
  // Vega FIX #2 — flag flipped ON (live default). Re-centering on OOR for
  // high-organic tokens keeps fee accrual instead of realizing a loss every
  // time price moves. Friction guard (agents/rebalance.js) + maxRebalances cap
  // bound the cost; gate below proves the OFF behavior still reverts cleanly.
  check("config default rebalanceOnOorEnabled === true (FIX #2)", () => {
    assert.equal(config.management.rebalanceOnOorEnabled, true);
  });
  // Explicit OFF override + high organic + OOR past limit → OUT_OF_RANGE (proves
  // the legacy hard-close path is still reachable / fully reversible).
  {
    const addr = "RBL11111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 90,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: false });
    check("explicit flag OFF + organic 90 + OOR 30m → OUT_OF_RANGE (reversible)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }
  // ON + high organic + under cap → REBALANCE_OOR signal (re-center wired).
  {
    const addr = "RBL22222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 90,
      rebalance_count: 0,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: true, maxRebalances: 3 });
    check("flag ON + organic 90 + count 0/3 → REBALANCE_OOR (opt-in, under cap)", () => {
      assert.ok(r);
      assert.equal(r.action, "REBALANCE_OOR");
      assert.equal(r.rebalance_count, 0);
      assert.equal(r.max_rebalances, 3);
    });
  }
  // ON + high organic + cap HIT → OUT_OF_RANGE (anti-churn fallback).
  {
    const addr = "RBL22b2222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 90,
      rebalance_count: 3,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: true, maxRebalances: 3 });
    check("flag ON + organic 90 + count 3 == max → OUT_OF_RANGE (cap hit)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }
  // ON + LOW organic → still OUT_OF_RANGE (rebalance only for high-organic).
  {
    const addr = "RBL33333333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 50,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: true });
    check("flag ON + organic 50 (< 80) → OUT_OF_RANGE (high-organic only)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Vega FIX #1 — fee-inclusive exit DECISION metric (paper + live)
  // Root-cause of the 1:2 loss/win asymmetry: exit logic decided on
  // PRICE-ONLY pnl, so losers realized full price drops while winners'
  // accrued fees triggered nothing. Decisions now read the NET economic
  // position (price + fees − IL), with price fallback when fee data missing.
  // ─────────────────────────────────────────────────────────────
  console.log("\nFIX #1 — fee-inclusive exit decision (paper)");

  // (a) WINNER: fee accrual lifts net above trailing trigger so exit fires at
  //     a real gain, where price-only would NOT have armed trailing at all.
  //     price proxy +2% (below 18 trigger) but fees +20% → fee-inclusive +22%
  //     arms trailing; then a 6% net drop → TRAILING_TP at a meaningful gain.
  {
    const peak = { price_proxy_pnl_pct: 2, fee_inclusive_pnl_pct: 22 };
    const drop = { price_proxy_pnl_pct: 2, fee_inclusive_pnl_pct: 16, price: 102, entry: 100 };
    const trade = {
      status: "open", opened_at: new Date(Date.now() - 60 * 60000).toISOString(),
      entry_price: 100, peak_pnl_pct: 0, partial_tp_done: true, notes: [],
    };
    // Arm on the +22% net peak (price-only +2% would never arm at trigger 18).
    const r1 = evaluatePaperExit(trade, { ...peak, price: 102 }, MGMT);
    check("(a) winner: fees push net +22% → arms (no premature exit), peak tracks net", () => {
      assert.equal(r1, null);
      assert.equal(trade.peak_pnl_pct, 22); // peak is fee-inclusive, NOT price 2
    });
    const r2 = evaluatePaperExit(trade, drop, MGMT);
    check("(a) winner: 6% net drop from +22% peak → TRAILING_TP at real gain", () => {
      assert.ok(r2);
      assert.equal(r2.action, "TRAILING_TP");
    });
  }
  // (b) LOSER: SL fires on the NET economic position, downside STILL capped.
  //     Price -12% but fees +4% → fee-inclusive -8% (above SL -50 in MGMT;
  //     use a tight SL to prove SL still protects on the net metric).
  {
    const tightSL = { ...MGMT, stopLossPct: -10 };
    const trade = {
      status: "open", opened_at: new Date(Date.now() - 60 * 60000).toISOString(),
      entry_price: 100, peak_pnl_pct: 0, partial_tp_done: true, notes: [],
    };
    // net -8% (price -12 + fee +4): SL -10 NOT hit yet — fees correctly offset.
    const r1 = evaluatePaperExit(trade, { price_proxy_pnl_pct: -12, fee_inclusive_pnl_pct: -8, price: 88 }, tightSL);
    check("(b) loser: net -8% (fees offset price -12%) → SL -10 NOT premature", () => {
      assert.equal(r1, null);
    });
    // net -11% → SL -10 FIRES. Downside capped on the true economic position.
    const r2 = evaluatePaperExit(trade, { price_proxy_pnl_pct: -16, fee_inclusive_pnl_pct: -11, price: 84 }, tightSL);
    check("(b) loser: net -11% → STOP_LOSS fires (downside capped, net metric)", () => {
      assert.ok(r2);
      assert.equal(r2.action, "STOP_LOSS");
    });
  }

  // (c) FAIL-SAFE: fee data missing (fee_inclusive null) → price fallback, no
  //     crash, SL still fires on the price proxy.
  {
    const tightSL = { ...MGMT, stopLossPct: -10 };
    const trade = {
      status: "open", opened_at: new Date(Date.now() - 60 * 60000).toISOString(),
      entry_price: 100, peak_pnl_pct: 0, partial_tp_done: true, notes: [],
    };
    const r = evaluatePaperExit(trade, { price_proxy_pnl_pct: -15, fee_inclusive_pnl_pct: null, price: 85 }, tightSL);
    check("(c) fail-safe: fee-inclusive null → price proxy -15% → STOP_LOSS (no crash)", () => {
      assert.ok(r);
      assert.equal(r.action, "STOP_LOSS");
    });
  }

  console.log("\nFIX #1 — fee-inclusive exit decision (live state.js)");
  // (e) LIVE mirror parallel to paper: state.js prefers pnl_pct_fee_inclusive.
  // Peak tracking lives in index.js (queuePeakConfirmation, fed by decisionPnlPct
  // → the SAME fee-inclusive metric). Here the peak has already been captured at
  // the fee-inclusive +22% (price-only +2% would never have reached trigger 18).
  // updatePnlAndCheckExits then arms trailing on that net peak and, on a 6% net
  // drop, fires TRAILING_TP at a real gain. This is the winner the OLD price-only
  // path closed at MAX_HOLD/OOR for a sliver.
  {
    const addr = "FIE11111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, { peak_pnl_pct: 22, partial_tp_done: true }) });
    const r1 = updatePnlAndCheckExits(addr, { pnl_pct: 2, pnl_pct_fee_inclusive: 22, in_range: true }, MGMT);
    check("(e) live winner: net peak +22% arms trailing (price-only +2% would not)", () => {
      assert.equal(r1, null);
      assert.equal(readPos(addr).trailing_active, true);
    });
    // 6% net drop from +22% peak (fee-inclusive 16) → TRAILING_TP at real gain.
    const r2 = updatePnlAndCheckExits(addr, { pnl_pct: 0, pnl_pct_fee_inclusive: 16, in_range: true }, MGMT);
    check("(e) live winner: 6% net drop → TRAILING_TP at +16% net (not a sliver)", () => {
      assert.ok(r2);
      assert.equal(r2.action, "TRAILING_TP");
    });
  }
  // Live loser: SL on net position, downside capped.
  {
    const addr = "FIE22222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, { partial_tp_done: true }) });
    const tightSL = { ...MGMT, stopLossPct: -10 };
    const r1 = updatePnlAndCheckExits(addr, { pnl_pct: -12, pnl_pct_fee_inclusive: -8, in_range: true }, tightSL);
    check("(e) live loser: net -8% (price -12 + fee) → SL -10 NOT premature", () => {
      assert.equal(r1, null);
    });
    const r2 = updatePnlAndCheckExits(addr, { pnl_pct: -16, pnl_pct_fee_inclusive: -11, in_range: true }, tightSL);
    check("(e) live loser: net -11% → STOP_LOSS fires (downside capped)", () => {
      assert.ok(r2);
      assert.equal(r2.action, "STOP_LOSS");
    });
  }
  // Live fail-safe: pnl_pct_fee_inclusive missing → reported pnl_pct used.
  {
    const addr = "FIE33333333333333333333333333333333333333333";
    writeState({ [addr]: trackedFixture(addr, { partial_tp_done: true }) });
    const tightSL = { ...MGMT, stopLossPct: -10 };
    const r = updatePnlAndCheckExits(addr, { pnl_pct: -15, in_range: true }, tightSL);
    check("(e) live fail-safe: no fee-inclusive field → reported pnl_pct -15% → STOP_LOSS", () => {
      assert.ok(r);
      assert.equal(r.action, "STOP_LOSS");
    });
  }

  // ─────────────────────────────────────────────────────────────
  // FIX #2 — rebalance-on-OOR friction guard (d)
  // ─────────────────────────────────────────────────────────────
  console.log("\nFIX #2 — rebalance-on-OOR friction guard");
  // (d) friction = gas(3tx) + slippage(amount*1%). Re-center only worth it when
  //     accrued fees >= friction; else hard close. Prove both branches.
  {
    const friction = estimateRebalanceFrictionSol({ amountSol: 0.18 });
    check("(d) friction > 0 and scales with capital (3 tx gas + 1% slippage)", () => {
      assert.ok(Number.isFinite(friction));
      assert.ok(friction > 0);
      // 3 * 0.00015 + 0.18 * 0.01 = 0.00045 + 0.0018 = 0.00225
      assert.ok(Math.abs(friction - 0.00225) < 1e-9);
    });
    // fees ABOVE friction → guard satisfied (re-center is economically sound).
    const feesHigh = estimateAccumulatedFeesSol({ unclaimed_fees_sol: 0.01 }, {}, 150);
    check("(d) fees 0.01 SOL > friction → re-center worth it (guard passes)", () => {
      assert.ok(feesHigh >= friction);
    });
    // fees BELOW friction → guard fails → hard close (no churn bleed).
    const feesLow = estimateAccumulatedFeesSol({ unclaimed_fees_sol: 0.0001 }, {}, 150);
    check("(d) fees 0.0001 SOL < friction → NOT worth re-center (hard close)", () => {
      assert.ok(feesLow < friction);
    });
    // fail-safe: null fee inputs → 0 → fails guard → hard close (safe default).
    const feesNull = estimateAccumulatedFeesSol({}, {}, 150);
    check("(d) fail-safe: missing fee data → 0 SOL → fails guard (safe hard close)", () => {
      assert.equal(feesNull, 0);
      assert.ok(feesNull < friction);
    });
  }

  console.log(`\nALL ${assertions} assertions PASS`);
} finally {
  cleanup();
}
