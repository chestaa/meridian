// tsmom/btc-executor.js — the signal→order bridge for v3-btc-long live execution.
//
// VEGA 🔥 — this is where the strategy SIGNAL becomes a (potential) order. It is a
// THIN ORCHESTRATOR. It does NOT reimplement any signal logic — it WRAPS the
// existing decideSoak() from tsmom-paper-soak.js (the SAME pure decision the paper
// soak uses), then translates the decision's vol-scaled weight into a clamped,
// hard-capped USDC notional and routes it through the safety stack:
//
//   decideSoak() ─► (act only on cold_open / rebalance) ─► clamp weight to 1.0
//     ─► preTradeGate (DRY_RUN gate + kill switch + daily-loss circuit + sizing)
//     ─► reconcile (book vs chain, fail-closed)
//     ─► placeBtcOrder (slippage cap + confirm-then-verify + NO retry)
//     ─► applyFill into the position book (live only)
//
// FAIL-CLOSED at every hop. DRY_RUN returns the intended plan (and never touches a
// wallet or sends a tx). The live path is unreachable without DRY_RUN=false AND a
// funded burner (enforced downstream by wallet-loader + btc-order's burner assert).
//
// CRITICAL INVARIANTS (Bro-locked):
//   * Signal logic is decideSoak's — we never recompute sign/weight here.
//   * Only cold_open / rebalance trigger an order intent; mark/noop/insufficient
//     do NOTHING (no order, no money).
//   * Target notional = clamp(weight,1.0) * equity, hard-capped at MAX_EQUITY_USD.
//   * Leverage is OFF (clamp 1.0); short is impossible (v3-btc-long is long/flat).

import { log } from "../logger.js";
import {
  assertDryRunGate,
  preTradeGate,
  CBBTC_MINT,
  USDC_MINT,
  BTC_TSMOM_MAX_EQUITY_USD,
} from "./btc-guards.js";
import { decideSoak } from "./tsmom-paper-soak.js";
import { reconcile } from "./btc-reconcile.js";
import { placeBtcOrder } from "./btc-order.js";
import { loadPosition, savePosition, applyFill, coldPosition } from "./btc-position.js";
import { V3_BTC_LONG_PARAMS } from "./tsmom-variants.js";
import { recordEquitySnapshot, resolveBaselineEquity } from "./btc-equity-baseline.js";
import { resolveCbbtcPrice } from "./btc-price-oracle.js";

// Actions from decideSoak that represent an actual position change. Everything
// else (mark / noop / insufficient / error) is a NO-ORDER outcome.
const ACTIONABLE = new Set(["cold_open", "rebalance"]);

/**
 * Translate a decideSoak decision + current equity into a target order intent.
 * Pure: no I/O. Returns {targetWeight, notionalUsd, side, ...gate} — or a non-order
 * result for non-actionable decisions / refused gates.
 *
 * side semantics for v3-btc-long (long/flat, leverage OFF):
 *   targetWeight > 0  => want cbBTC exposure  => "buy"  (USDC -> cbBTC)
 *   targetWeight == 0 => want flat (cash)      => "sell" if currently holding, else "none"
 *
 * NOTE: this targets a SINGLE-FILL approximation of the desired notional. It does
 * not net partial rebalances — a probe-scale ($200-300) position is opened or fully
 * exited; a finer rebalance ladder is a deliberate later iteration, not Phase A.
 */
export function planFromDecision(decision, { currentEquityUsd, currentCbbtcUnits = 0, cbbtcPriceUsd } = {}) {
  if (!decision || !ACTIONABLE.has(decision.action)) {
    return { order: false, action: decision?.action || "none", reason: "non_actionable_decision" };
  }
  const sig = decision.sig;
  if (!sig) {
    return { order: false, action: decision.action, reason: "decision_missing_sig_fail_closed" };
  }

  // The gate clamps weight to 1.0 and sizes notional capped by probe equity. This
  // is a PURE sizing call — the real DRY_RUN/live decision lives in executeStep, so
  // we pass dryRunRaw:"true" here to avoid coupling pure planning to the env. The
  // circuit is also re-checked in executeStep with the real 24h baseline.
  const gate = preTradeGate({
    dryRunRaw: "true",
    windowStartEquity: currentEquityUsd,
    currentEquity: currentEquityUsd,
    rawWeight: sig.weight,
  });
  if (!gate.allow) {
    return { order: false, action: decision.action, reason: gate.reason, stage: gate.stage, gate };
  }

  const targetWeight = gate.weight;     // clamped to <= 1.0
  const targetNotional = gate.notionalUsd; // <= MAX_EQUITY_USD

  // Decide side from target vs current holdings.
  let side, amount, in_mint, out_mint;
  if (targetWeight > 0) {
    // Want exposure. For a probe we BUY the target notional in USDC (single fill).
    // If already holding ~the target we'd skip — but at probe scale we treat
    // cold_open/rebalance-to-long as a (re)entry of targetNotional USDC.
    side = "buy";
    in_mint = USDC_MINT;
    out_mint = CBBTC_MINT;
    amount = +targetNotional.toFixed(6); // USDC units to spend
  } else {
    // Target flat. Exit any held cbBTC; nothing to do if already flat.
    if (!(currentCbbtcUnits > 0)) {
      return { order: false, action: decision.action, reason: "already_flat", targetWeight: 0, targetNotional: 0, gate };
    }
    side = "sell";
    in_mint = CBBTC_MINT;
    out_mint = USDC_MINT;
    amount = +Number(currentCbbtcUnits).toFixed(8); // cbBTC units to sell (full exit)
  }

  // Expected out for the slippage check, from a price (if provided). buy: USDC/price
  // => cbBTC units; sell: cbBTC*price => USDC. null price => let btc-order self-
  // reference the quote (Jupiter slippageBps still bounds the fill).
  let expectedOut = null;
  if (Number.isFinite(Number(cbbtcPriceUsd)) && Number(cbbtcPriceUsd) > 0) {
    expectedOut = side === "buy" ? amount / Number(cbbtcPriceUsd) : amount * Number(cbbtcPriceUsd);
  }

  return {
    order: true,
    action: decision.action,
    side,
    in_mint,
    out_mint,
    amount,
    expectedOut,
    targetWeight,
    targetNotional,
    gate,
  };
}

/**
 * Run one execution step: decide (wrap decideSoak) → plan → reconcile → order →
 * book. Returns a summary. DRY_RUN: computes the full plan and the intended order
 * but places NOTHING and writes NO book fill. Live: reconciles first (halt on drift),
 * then places + verifies + books.
 *
 * @param {object} ctx
 * @param {Array}  ctx.rows                BTC daily bars (from the soak's history)
 * @param {number} ctx.currentEquityUsd    equity for sizing (USDC + cbBTC mark)
 * @param {number} [ctx.windowStartEquity] 24h-ago equity for the circuit. If OMITTED,
 *                                         resolved from the PERSISTED equity-baseline
 *                                         store (fail-closed to HALT if missing/stale).
 *                                         Pass an explicit number only for tests.
 * @param {number} [ctx.cbbtcPriceUsd]     current cbBTC price (for slippage expectation)
 * @param {object} [ctx.deps]              injected {reconcileFn, placeOrderFn, getBalances,
 *                                         resolveBaselineFn, recordSnapshotFn} for tests
 * @param {boolean} [ctx.recordSnapshot=true] record currentEquity into the baseline store
 * @param {string} [ctx.dryRunRaw]         injected DRY_RUN
 */
export async function executeStep({
  rows,
  currentEquityUsd,
  windowStartEquity,
  cbbtcPriceUsd,
  soakState = undefined,
  deps = {},
  recordSnapshot = true,
  dryRunRaw = process.env.DRY_RUN,
} = {}) {
  // 0) DRY_RUN must be unambiguous (throws on bad value before anything else).
  const isDryRun = assertDryRunGate(dryRunRaw);

  // 0a) Record an equity snapshot for the rolling 24h baseline (idempotent-ish: one
  //     append per run). Done BEFORE the circuit check so the store always advances,
  //     even on a HALT run. Refused silently on non-finite equity (no bogus snapshot).
  if (recordSnapshot) {
    const recordFn = deps.recordSnapshotFn || recordEquitySnapshot;
    try { recordFn(currentEquityUsd); } catch { /* never crash the money path on a snapshot write */ }
  }

  // 0b) Resolve an INDEPENDENT cbBTC price for the slippage check (gap #3). If the
  //     caller passed an explicit cbbtcPriceUsd (tests / operator), honor it; else
  //     resolve from the oracle (Jupiter price v3 → cached BTC close → null). A null
  //     here is fail-closed on the LIVE path below (refuse rather than self-reference
  //     the swap quote). DRY-RUN proceeds but flags price_unavailable in the plan.
  let priceUsd = cbbtcPriceUsd;
  let priceInfo = null;
  if (priceUsd == null) {
    const priceFn = deps.resolvePriceFn || resolveCbbtcPrice;
    priceInfo = await priceFn();
    priceUsd = priceInfo.ok ? priceInfo.price : null;
  }

  // 1) WRAP decideSoak — the SAME pure decision the paper soak uses. We never
  //    recompute signal logic here.
  const state = soakState !== undefined ? soakState : null; // executor reads its own book; soak state is the signal cadence's
  const decision = decideSoak(rows, state, V3_BTC_LONG_PARAMS);

  // 2) Load book + derive current cbBTC units for side decision.
  const book = loadPosition() || coldPosition();
  const currentCbbtcUnits = Number(book.cbbtc_units) || 0;

  // 3) Plan (clamp + size + side). preTradeGate inside uses env DRY_RUN; pass-through
  //    circuit here uses the supplied 24h baseline.
  const plan = planFromDecision(decision, {
    currentEquityUsd,
    currentCbbtcUnits,
    cbbtcPriceUsd: priceUsd,
  });

  // Re-evaluate the circuit with the REAL 24h baseline. planFromDecision's gate used
  // current=window (0% dd) only for SIZING; the true breaker needs the 24h-ago equity.
  // When windowStartEquity is not explicitly supplied (production), resolve it from
  // the PERSISTED baseline store. FAIL-CLOSED: a missing/stale baseline returns null,
  // which checkDailyLossCircuit treats as "equity_unknown_fail_closed_halt" → HALT.
  // We do NOT fall back to currentEquity (that was the bug — a 0% dd that can't trip).
  let baselineEquity;
  let baselineInfo = null;
  if (windowStartEquity != null) {
    baselineEquity = windowStartEquity; // explicit (tests / operator override)
  } else {
    const resolveFn = deps.resolveBaselineFn || resolveBaselineEquity;
    baselineInfo = resolveFn();
    baselineEquity = baselineInfo.equityUsd; // null => circuit fail-closed HALT
  }
  const circuitGate = preTradeGate({
    dryRunRaw,
    windowStartEquity: baselineEquity,
    currentEquity: currentEquityUsd,
    rawWeight: decision?.sig?.weight,
  });
  if (!circuitGate.allow) {
    log("btc_exec", `NO ORDER — gate halt at ${circuitGate.stage}: ${circuitGate.reason}` +
      (baselineInfo ? ` (baseline age ${baselineInfo.age_hours}h, ${baselineInfo.reason || "ok"})` : ""));
    return { ordered: false, isDryRun, action: decision.action, reason: circuitGate.reason, stage: circuitGate.stage, baseline: baselineInfo, decision: brief(decision), plan };
  }

  if (!plan.order) {
    log("btc_exec", `NO ORDER — ${decision.action}: ${plan.reason}`);
    return { ordered: false, isDryRun, action: decision.action, reason: plan.reason, decision: brief(decision), plan };
  }

  // 4) DRY-RUN: still compute the intended order (honest plan), place NOTHING.
  const placeOrderFn = deps.placeOrderFn || placeBtcOrder;
  if (isDryRun) {
    const intended = await placeOrderFn({
      input_mint: plan.in_mint, output_mint: plan.out_mint, amount: plan.amount,
      expectedOut: plan.expectedOut, dryRunRaw: "true",
    });
    const priceAvail = priceUsd != null;
    log("btc_exec", `DRY-RUN plan: ${plan.side} ${plan.amount} (${plan.action}, weight ${plan.targetWeight}, notional $${plan.targetNotional})` +
      (priceAvail ? ` @ indep price $${priceUsd} (${priceInfo?.source || "explicit"})` : ` ⚠ price_unavailable (LIVE would REFUSE)`));
    return { ordered: false, isDryRun: true, action: decision.action, plan, intended, price: priceInfo, priceAvailable: priceAvail, decision: brief(decision) };
  }

  // ── LIVE PATH (DRY_RUN=false only) ───────────────────────────────────────────
  // 4b) INDEPENDENT-PRICE GUARD (gap #3, fail-closed): never trade the LIVE money
  //     path without an independent slippage anchor. A null oracle would force
  //     btc-order to self-reference its own quote (slippage 0 by construction) — that
  //     is a slippage check that can't catch a bad route. Refuse instead.
  if (priceUsd == null) {
    log("btc_exec", `NO ORDER — independent price unavailable (${priceInfo?.reason || "no_price"}); refusing LIVE trade (fail-closed)`);
    return { ordered: false, isDryRun: false, action: decision.action, reason: "independent_price_unavailable_fail_closed", halted: true, price: priceInfo, plan };
  }

  // 5) Reconcile book vs chain FIRST. Drift => halt, no order.
  const reconcileFn = deps.reconcileFn || reconcile;
  const rec = await reconcileFn({ book, getBalances: deps.getBalances, alert: true });
  if (!rec.ok) {
    log("btc_exec", `NO ORDER — reconcile halt: ${rec.reason}`);
    return { ordered: false, isDryRun: false, action: decision.action, reason: `reconcile_${rec.reason}`, halted: true, reconcile: rec, plan };
  }

  // 6) Place the order (slippage + confirm-then-verify + NO retry downstream).
  const order = await placeOrderFn({
    input_mint: plan.in_mint, output_mint: plan.out_mint, amount: plan.amount,
    expectedOut: plan.expectedOut, dryRunRaw: "false",
  });

  if (!order || order.success !== true || order.placed !== true) {
    log("btc_exec", `ORDER NOT PLACED — ${order?.reason || "unknown"} (no book write)`);
    return { ordered: false, isDryRun: false, action: decision.action, reason: order?.reason || "order_not_placed", halted: order?.halted || false, order, plan };
  }

  // 7) Book the fill (live, verified only).
  let newBook;
  try {
    newBook = applyFill(book, {
      side: plan.side,
      in_mint: plan.in_mint,
      out_mint: plan.out_mint,
      in_amt: plan.amount,
      out_amt: order.realizedOut,
      price_usd: priceUsd != null ? Number(priceUsd) : null,
      signature: order.signature,
    });
    savePosition(newBook);
  } catch (e) {
    // Order is on-chain but we failed to book it. DO NOT retry/undo — surface for
    // manual reconcile (next executeStep will reconcile and halt on the drift).
    log("btc_exec", `BOOKED-FILL WRITE FAILED after on-chain order ${order.signature}: ${e.message}`);
    return { ordered: true, booked: false, isDryRun: false, action: decision.action, reason: `book_write_failed:${e.message}`, order, plan };
  }

  log("btc_exec", `ORDER PLACED + BOOKED ${plan.side} ${plan.amount} tx=${order.signature}`);
  return { ordered: true, booked: true, isDryRun: false, action: decision.action, order, plan, book: newBook };
}

// Compact a decision for logging (drop the heavy sig internals).
function brief(d) {
  if (!d) return null;
  return { action: d.action, latestDate: d.latestDate, weight: d.sig?.weight, signal: d.sig?.signal, reason: d.reason };
}
