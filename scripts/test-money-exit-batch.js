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
  check("config default rebalanceOnOorEnabled === false", () => {
    assert.equal(config.management.rebalanceOnOorEnabled, false);
  });
  // OFF + high organic + OOR past limit → OUT_OF_RANGE (legacy hard close).
  {
    const addr = "RBL11111111111111111111111111111111111111111";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 90,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, MGMT);
    check("flag OFF + organic 90 + OOR 30m → OUT_OF_RANGE (no behavior change)", () => {
      assert.ok(r);
      assert.equal(r.action, "OUT_OF_RANGE");
    });
  }
  // ON + high organic → REBALANCE_OOR signal (needs_design). Confirms gate works.
  {
    const addr = "RBL22222222222222222222222222222222222222222";
    writeState({ [addr]: trackedFixture(addr, {
      organic_score: 90,
      partial_tp_done: true,
      out_of_range_since: new Date(Date.now() - 30 * 60000).toISOString(),
    }) });
    const r = updatePnlAndCheckExits(addr, { pnl_pct: 1, in_range: false }, { ...MGMT, rebalanceOnOorEnabled: true });
    check("flag ON + organic 90 → REBALANCE_OOR (needs_design, opt-in only)", () => {
      assert.ok(r);
      assert.equal(r.action, "REBALANCE_OOR");
      assert.equal(r.needs_design, true);
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

  console.log(`\nALL ${assertions} assertions PASS`);
} finally {
  cleanup();
}
