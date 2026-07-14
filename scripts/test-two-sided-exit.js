// scripts/test-two-sided-exit.js
// Andromeda 🌌 Track-A — TWO-SIDED paper exit logic (PAPER-ONLY, inverted payoff).
//
// A two-sided paper position holds a SOL-Y leg (nominal SOL, lower bins) AND a
// token-X leg (appreciating asset, upper bins). This FLIPS the single-side
// payoff:
//   - price UP → token-X leg APPRECIATES → capture it (upside skew, the OPPOSITE
//     of single-side fast-OOR-up which harvested IDLE SOL). Close reason
//     two_sided_upside_capture.
//   - price DOWN → BOTH legs bleed → cut like a single-side SL. Close reason
//     two_sided_down_cut.
//
// Proven here (assert-based, pure — no LLM/RPC/on-chain):
//   1. computeTwoSidedPaperPnl two-asset math: up → +, down → −, fail-closed.
//   2. UPSIDE CAPTURE fires as the token leg climbs (profit target + OOR-UP).
//   3. DOWN-CUT fires when both legs bleed (PnL floor + OOR-DOWN timer).
//   4. SINGLE-SIDE exits are UNCHANGED when a trade is not two_sided (the branch
//      is never entered; no TWO_SIDED_* action ever appears on a single-side trade).
//   5. FAIL-SAFE: uncomputable two-asset PnL → NO exit (hold, never fabricate).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
if (!fs.existsSync(path.join(ROOT, "paper-trades.js"))) {
  console.error("ERROR: run this test from the Meridian repo root (cwd has no paper-trades.js).");
  process.exit(1);
}

const { computeTwoSidedPaperPnl, evaluateTwoSidedPaperExit, evaluatePaperExit } =
  await import("../paper-trades.js");

let assertions = 0;
let failures = 0;
function check(label, fn) {
  try {
    fn();
    assertions += 1;
    console.log(`  PASS ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${label}\n        ${e.message}`);
  }
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

// ── Two-sided exit config (paper-scoped). Passed as mgmtConfigOverride. ───────
const BASE_MGMT = {
  stopLossPct: -8,
  twoSidedUpsideCaptureTargetPct: 8,
  twoSidedUpsideCaptureOorMinutes: 0,
  twoSidedDownCutPct: -8,
  twoSidedOorDownCutMinutes: 8,
  twoSidedOorBandPct: 25,
  // single-side keys present so the legacy path is exercised realistically.
  takeProfitPct: 100,
  trailingTakeProfit: true,
  trailingTriggerPct: 18,
  trailingDropPct: 6,
  giveBackProtectEnabled: false,
  oorUpFastExitEnabled: false,
  outOfRangeWaitMinutes: 30,
};

// entry_price 0.002 SOL/token; Y-leg 0.5 SOL; X-leg 100 token (= 0.2 SOL at
// entry); sim swap cost 0.002 SOL. entry_basis = 0.5 + 0.2 + 0.002 = 0.702 SOL.
function twoSidedTrade(overrides = {}) {
  return {
    status: "open",
    pool_name: "TWOSIDE-SOL",
    entry_price: 0.002,
    peak_pnl_pct: 0,
    out_of_range_since: null,
    notes: [],
    fees_claimed_sol: 0,
    two_sided: true,
    two_sided_paper: {
      two_sided: true,
      paper_only: true,
      active_price_sol_per_token: 0.002,
      y_leg: { sol_amount: 0.5, bins_below: 35 },
      x_leg: { token_x_amount: 100, bins_above: 35 },
      entry_swap: { est_swap_cost_sol: 0.002 },
      notional: { y_leg_sol: 0.5, x_leg_sol: 0.2, total_notional_sol: 0.7 },
    },
    ...overrides,
  };
}
const snap = (price) => ({ price });

try {
  console.log("test-two-sided-exit.js — Andromeda Track-A two-sided paper exits\n");

  // ═══════════════════════════════════════════════════════════════════
  // 1. TWO-ASSET PnL MATH (computeTwoSidedPaperPnl)
  // ═══════════════════════════════════════════════════════════════════
  console.log("Two-asset mark-to-market");

  // price flat → pnl 0 (basis includes swap cost, so flat is slightly negative
  // once the entry drag is counted). At entry price exactly:
  // current_value = 0.5 + 0.2 = 0.7; basis = 0.702; pnl_sol = -0.002 → -0.28%.
  {
    const r = computeTwoSidedPaperPnl(twoSidedTrade(), 0.002);
    check("flat price → tiny negative (entry swap drag)", () => {
      assert.equal(r.uncomputable, false);
      assert.equal(r.pnl_pct, -0.28);
      assert.equal(r.entry_basis_sol, 0.702);
    });
  }

  // price +20% (0.0024): x_leg_now = 0.24; value = 0.74; pnl_sol = 0.038 → +5.41%.
  {
    const r = computeTwoSidedPaperPnl(twoSidedTrade(), 0.0024);
    check("price +20% → token-X leg APPRECIATES → +5.41% (upside captured)", () => {
      assert.equal(r.uncomputable, false);
      assert.ok(r.pnl_pct > 0, `expected positive, got ${r.pnl_pct}`);
      assert.equal(r.pnl_pct, 5.41);
      assert.equal(r.x_leg_now_sol, 0.24);
    });
  }

  // price -20% (0.0016): x_leg_now = 0.16; value = 0.66; pnl_sol = -0.042 → -5.98%.
  {
    const r = computeTwoSidedPaperPnl(twoSidedTrade(), 0.0016);
    check("price -20% → token-X leg BLEEDS → -5.98% (both legs bleed on down)", () => {
      assert.equal(r.uncomputable, false);
      assert.ok(r.pnl_pct < 0, `expected negative, got ${r.pnl_pct}`);
      assert.equal(r.pnl_pct, -5.98);
    });
  }

  // fees add to the token-leg gain.
  {
    const r = computeTwoSidedPaperPnl(twoSidedTrade({ fees_claimed_sol: 0.01 }), 0.0024);
    check("fees increase net PnL (value += fees)", () => {
      assert.ok(r.pnl_pct > 5.41, `expected > 5.41 with fees, got ${r.pnl_pct}`);
    });
  }

  // fail-closed: missing token-X leg → uncomputable (never a fabricated 0).
  {
    const t = twoSidedTrade();
    t.two_sided_paper.x_leg = {};
    const r = computeTwoSidedPaperPnl(t, 0.0024);
    check("missing token-X leg → uncomputable (null, NOT 0)", () => {
      assert.equal(r.uncomputable, true);
      assert.equal(r.pnl_pct, null);
    });
  }

  // fail-closed: null price → uncomputable.
  check("null current price → uncomputable", () => {
    const r = computeTwoSidedPaperPnl(twoSidedTrade(), null);
    assert.equal(r.uncomputable, true);
    assert.equal(r.pnl_pct, null);
  });

  // fail-closed: implausible ratio (unit mismatch guard) → uncomputable.
  check("implausible price ratio (0.002 → 0.03, 15x) → uncomputable", () => {
    const r = computeTwoSidedPaperPnl(twoSidedTrade(), 0.03);
    assert.equal(r.uncomputable, true);
    assert.match(r.reason, /implausible_price_ratio/);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. UPSIDE CAPTURE — bank the appreciating token-X leg
  // ═══════════════════════════════════════════════════════════════════
  console.log("\nUpside capture (token-X leg working → bank it)");

  // (target) price +40% (0.0028) → pnl 11.11% >= target 8% → capture.
  {
    const r = evaluateTwoSidedPaperExit(twoSidedTrade(), snap(0.0028), BASE_MGMT);
    check("PnL >= target → TWO_SIDED_UPSIDE_CAPTURE", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_UPSIDE_CAPTURE");
      assert.match(r.reason, /^two_sided_upside_capture:/);
      assert.ok(r.pnl_pct >= 8);
    });
  }

  // (target isolation) target lowered to 5, price +20% (pnl 5.41), in-band (not
  // OOR) → target fires WITHOUT any OOR-up path.
  {
    const t = twoSidedTrade();
    const r = evaluateTwoSidedPaperExit(t, snap(0.0024), { ...BASE_MGMT, twoSidedUpsideCaptureTargetPct: 5 });
    check("in-band +20% hits lowered target 5% → capture (not via OOR)", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_UPSIDE_CAPTURE");
      assert.match(r.reason, /target/);
    });
  }

  // (OOR-UP path) target unreachable (999), price +40% is OOR-UP + in profit,
  // OOR timer met → capture via the OOR-UP branch (the token leg worked out the
  // top of the range). This is the INVERSION of single-side idle-SOL harvest.
  {
    const t = twoSidedTrade({ out_of_range_since: minutesAgo(5) });
    const r = evaluateTwoSidedPaperExit(t, snap(0.0028), {
      ...BASE_MGMT, twoSidedUpsideCaptureTargetPct: 999, twoSidedUpsideCaptureOorMinutes: 0,
    });
    check("OOR-UP in profit → TWO_SIDED_UPSIDE_CAPTURE via OOR branch", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_UPSIDE_CAPTURE");
      assert.match(r.reason, /OOR-UP/);
    });
  }

  // (let it run) modest +10% (pnl ~2.7%), below target, in-band → NO exit (hold
  // the winner's token leg to let it run).
  {
    const r = evaluateTwoSidedPaperExit(twoSidedTrade(), snap(0.0022), BASE_MGMT);
    check("modest gain below target, in-band → hold (null, let it run)", () =>
      assert.equal(r, null));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. DOWN-CUT — both legs bleeding
  // ═══════════════════════════════════════════════════════════════════
  console.log("\nDown-cut (both legs bleeding → cut)");

  // (floor) price -30% (0.0014) → pnl -8.83% <= -8% floor → down-cut.
  {
    const r = evaluateTwoSidedPaperExit(twoSidedTrade(), snap(0.0014), BASE_MGMT);
    check("net PnL <= down-cut floor → TWO_SIDED_DOWN_CUT", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_DOWN_CUT");
      assert.match(r.reason, /^two_sided_down_cut:/);
      assert.ok(r.pnl_pct <= -8);
    });
  }

  // (OOR-DOWN timer) floor unreachable (-99), price -30% is OOR-DOWN, timer met
  // (10m >= 8m) → down-cut via OOR-DOWN branch.
  {
    const t = twoSidedTrade({ out_of_range_since: minutesAgo(10) });
    const r = evaluateTwoSidedPaperExit(t, snap(0.0014), {
      ...BASE_MGMT, twoSidedDownCutPct: -99, twoSidedOorDownCutMinutes: 8,
    });
    check("OOR-DOWN sustained >= timer → TWO_SIDED_DOWN_CUT via OOR branch", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_DOWN_CUT");
      assert.match(r.reason, /OOR-DOWN/);
    });
  }

  // (OOR-DOWN under timer) floor unreachable, OOR-DOWN only 3m < 8m → hold (null).
  {
    const t = twoSidedTrade({ out_of_range_since: minutesAgo(3) });
    const r = evaluateTwoSidedPaperExit(t, snap(0.0014), {
      ...BASE_MGMT, twoSidedDownCutPct: -99, twoSidedOorDownCutMinutes: 8,
    });
    check("OOR-DOWN under timer + above floor → hold (null)", () => assert.equal(r, null));
  }

  // (down-cut precedence) at a deep dump the FLOOR fires even though price is also
  // OOR-DOWN — safety cut cannot be dodged.
  {
    const r = evaluateTwoSidedPaperExit(twoSidedTrade({ out_of_range_since: minutesAgo(1) }), snap(0.0013), BASE_MGMT);
    check("deep dump → down-cut fires (floor, precedence over OOR timer)", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_DOWN_CUT");
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. SINGLE-SIDE UNCHANGED — the two-sided branch is never entered
  // ═══════════════════════════════════════════════════════════════════
  console.log("\nSingle-side trades untouched by two-sided logic");

  // A single-side trade (two_sided !== true) routed through evaluatePaperExit
  // must NEVER produce a TWO_SIDED_* action. Healthy in-range → null (legacy).
  {
    const single = {
      status: "open", pool_name: "SINGLE-SOL", entry_price: 100,
      peak_pnl_pct: 2, out_of_range_since: null, notes: [],
    };
    const r = evaluatePaperExit(single, { price: 103, fee_inclusive_pnl_pct: 2, price_proxy_pnl_pct: 2 }, BASE_MGMT);
    check("single-side healthy in-range → null (legacy path, no two-sided action)", () =>
      assert.equal(r, null));
  }

  // Single-side stop-loss still fires via the legacy path (no two-sided interference).
  {
    const single = {
      status: "open", pool_name: "SINGLE-SOL", entry_price: 100,
      peak_pnl_pct: 0, out_of_range_since: null, notes: [],
    };
    const r = evaluatePaperExit(single, { price: 90, fee_inclusive_pnl_pct: -10, price_proxy_pnl_pct: -10 }, BASE_MGMT);
    check("single-side -10% → STOP_LOSS (legacy), NOT a two-sided action", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "STOP_LOSS");
    });
  }

  // Guard: calling the two-sided evaluator directly on a single-side trade → null.
  {
    const single = { status: "open", entry_price: 100, two_sided: false };
    const r = evaluateTwoSidedPaperExit(single, snap(140), BASE_MGMT);
    check("evaluateTwoSidedPaperExit on non-two-sided trade → null (guard)", () =>
      assert.equal(r, null));
  }

  // A two-sided trade routed through evaluatePaperExit reaches the two-sided path
  // (dispatch works end-to-end).
  {
    const r = evaluatePaperExit(twoSidedTrade(), snap(0.0028), BASE_MGMT);
    check("evaluatePaperExit dispatches two_sided trade → TWO_SIDED_UPSIDE_CAPTURE", () => {
      assert.ok(r, "expected an exit");
      assert.equal(r.action, "TWO_SIDED_UPSIDE_CAPTURE");
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. FAIL-SAFE — uncomputable two-asset PnL → hold (never fabricate)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\nFail-safe holds");

  // Missing token-X leg → two-asset PnL uncomputable → NO exit even at a price
  // that WOULD be a deep dump (never fabricate a cut on missing data).
  {
    const t = twoSidedTrade();
    t.two_sided_paper.x_leg = {};
    const r = evaluateTwoSidedPaperExit(t, snap(0.0013), BASE_MGMT);
    check("uncomputable PnL (missing leg) at dump price → hold (null, no cut)", () =>
      assert.equal(r, null));
  }

  // Missing snapshot price → hold.
  {
    const r = evaluateTwoSidedPaperExit(twoSidedTrade(), { price: null }, BASE_MGMT);
    check("missing snapshot price → hold (null)", () => assert.equal(r, null));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : "SOME FAILED"} — ${assertions} assertions, ${failures} failure(s)`);
} catch (e) {
  console.error("UNEXPECTED ERROR:", e);
  failures += 1;
}

console.log(failures === 0 ? "\nTWO-SIDED EXIT TEST OK" : "\nTWO-SIDED EXIT TEST FAILED");
process.exit(failures === 0 ? 0 : 1);
