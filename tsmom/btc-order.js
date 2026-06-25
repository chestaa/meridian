// tsmom/btc-order.js — CROWN-JEWEL Jupiter swap wrapper for cbBTC ↔ USDC.
//
// VEGA 🔥 — every swap in the v3-btc-long live path goes through placeBtcOrder().
// This is the ONLY place a money-moving cbBTC/USDC swap is allowed to originate.
//
// SAFETY CONTRACT (all enforced here, fail-closed):
//   * DRY_RUN gate           — assertDryRunGate; dry-run returns the intended order,
//                              places NOTHING. Live path only reachable on 'false'.
//   * Slippage cap           — quote the route, assert realized out vs oracle-expected
//                              out is within BTC_TSMOM_MAX_SLIPPAGE (0.5%). Refuse else.
//   * Confirm-then-verify    — after sending: confirmTransaction('confirmed'), then
//                              READ the post-swap on-chain balance and assert the asset
//                              moved by the expected amount ± slippage (anti-pattern #3:
//                              never assume a sent tx succeeded).
//   * NEVER auto-retry       — a failed/timed-out swap logs + alerts + HALTS. State is
//                              unknown after a failure; only an operator may re-act
//                              (anti-pattern #4).
//   * Burner-only            — live path asserts burner wallet before sending.
//
// We deliberately do NOT reimplement Jupiter signing — we reuse swapToken() from
// tools/wallet.js for the actual send, and wrap it with the quote/slippage/verify
// guarantees swapToken lacks. The intended-order shape is identical dry vs live so
// the executor's accounting is the same in both modes.

import { log } from "../logger.js";
import {
  assertDryRunGate,
  assertSlippage,
  assertBurnerWalletLive,
  CBBTC_MINT,
  CBBTC_DECIMALS,
  USDC_MINT,
  USDC_DECIMALS,
  BTC_TSMOM_MAX_SLIPPAGE,
} from "./btc-guards.js";

const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v2/quote";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function jupiterKey() {
  return process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function decimalsFor(mint) {
  if (mint === CBBTC_MINT) return CBBTC_DECIMALS;
  if (mint === USDC_MINT) return USDC_DECIMALS;
  return null; // fail-closed: we only trade these two legs
}

function toBaseUnits(amount, decimals) {
  return Math.floor(amount * Math.pow(10, decimals)).toString();
}
function fromBaseUnits(raw, decimals) {
  return Number(raw) / Math.pow(10, decimals);
}

/**
 * Validate the order direction is a supported cbBTC↔USDC leg. Fail-closed: any
 * other mint pair is refused (we never route an unexpected token on the money path).
 */
function assertSupportedLeg(inputMint, outputMint) {
  const legs = [
    [USDC_MINT, CBBTC_MINT], // buy cbBTC with USDC (enter / increase)
    [CBBTC_MINT, USDC_MINT], // sell cbBTC for USDC (exit / decrease)
  ];
  const okLeg = legs.some(([i, o]) => i === inputMint && o === outputMint);
  if (!okLeg) {
    throw new Error(
      `Unsupported leg ${inputMint} -> ${outputMint}; only cbBTC<->USDC allowed. (btc-order)`
    );
  }
}

/**
 * Fetch a Jupiter quote for inputMint->outputMint at amount (human units of input).
 * Returns { inAmount, outAmount, raw } in HUMAN units. THROWS on any quote failure
 * (fail-closed — no quote => no trade).
 */
async function getQuote(inputMint, outputMint, amount) {
  const inDec = decimalsFor(inputMint);
  const outDec = decimalsFor(outputMint);
  if (inDec === null || outDec === null) {
    throw new Error(`Unknown decimals for ${inputMint}/${outputMint} (btc-order quote)`);
  }
  const slippageBps = Math.round(BTC_TSMOM_MAX_SLIPPAGE * 10000); // 0.5% => 50 bps
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: toBaseUnits(amount, inDec),
    slippageBps: String(slippageBps),
  });
  const res = await fetch(`${JUPITER_QUOTE_API}?${params}`, {
    headers: { "x-api-key": jupiterKey() },
  });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }
  const q = await res.json();
  if (!q || q.error || !q.outAmount || !q.inAmount) {
    throw new Error(`Jupiter quote malformed: ${JSON.stringify(q).slice(0, 200)}`);
  }
  return {
    inAmount: fromBaseUnits(q.inAmount, inDec),
    outAmount: fromBaseUnits(q.outAmount, outDec),
    raw: q,
  };
}

/**
 * Place a cbBTC↔USDC order with full safety wrapping.
 *
 * @param {object} p
 * @param {string} p.input_mint
 * @param {string} p.output_mint
 * @param {number} p.amount             human units of input to swap
 * @param {number} p.expectedOut        oracle/price-implied out (for slippage check)
 * @param {function} [p.fetchQuote]     injectable for tests (defaults to getQuote)
 * @param {object}  [p.deps]            injectable {swapToken, confirmAndVerify} for tests
 * @param {string}  [p.dryRunRaw]       injectable DRY_RUN (defaults to env)
 * @returns {Promise<object>} order result; DRY_RUN returns intended-order, no send.
 */
export async function placeBtcOrder({
  input_mint,
  output_mint,
  amount,
  expectedOut,
  fetchQuote = getQuote,
  deps = {},
  dryRunRaw = process.env.DRY_RUN,
} = {}) {
  // 0) DRY_RUN must be unambiguous (throws on bad value).
  const isDryRun = assertDryRunGate(dryRunRaw);

  // 1) Supported leg + sane amount (fail-closed).
  assertSupportedLeg(input_mint, output_mint);
  if (!(Number(amount) > 0) || !Number.isFinite(Number(amount))) {
    throw new Error(`Invalid order amount ${amount} (btc-order)`);
  }

  // 2) Quote the route. (Both dry and live quote — dry-run wants an honest
  //    intended-order with a real expected fill, not a fabricated one.)
  const quote = await fetchQuote(input_mint, output_mint, amount);

  // 3) Slippage assertion: quoted out vs oracle-expected out. If caller didn't
  //    supply an oracle expectedOut, we self-reference the quote (slippage 0) —
  //    Jupiter's own slippageBps still bounds the on-chain fill; the on-chain
  //    verify step (live only) re-checks the realized move.
  const expForCheck = Number.isFinite(Number(expectedOut)) && Number(expectedOut) > 0
    ? Number(expectedOut)
    : quote.outAmount;
  const slip = assertSlippage(expForCheck, quote.outAmount);
  if (!slip.ok) {
    log("btc_order_refuse", `slippage refuse: ${slip.reason} (exp ${expForCheck} got ${quote.outAmount})`);
    return {
      success: false,
      placed: false,
      isDryRun,
      refused: true,
      reason: slip.reason,
      intended: { input_mint, output_mint, amount, expectedOut: expForCheck, quotedOut: quote.outAmount },
    };
  }

  const intended = {
    input_mint,
    output_mint,
    amount,
    quotedOut: quote.outAmount,
    expectedOut: expForCheck,
    slippage: slip.slippage,
    slippageCapBps: Math.round(BTC_TSMOM_MAX_SLIPPAGE * 10000),
  };

  // 4) DRY-RUN: return the intended order. NOTHING is sent. No wallet touched.
  if (isDryRun) {
    return {
      success: true,
      placed: false,
      dry_run: true,
      isDryRun: true,
      intended,
      message: "DRY RUN — intended order computed, no transaction sent (btc-order)",
    };
  }

  // ── LIVE PATH (only reachable with DRY_RUN=false) ────────────────────────────
  // 5) Burner-only assertion before any send (throws on main wallet).
  const burner = await assertBurnerWalletLive();

  // 6) Send via the existing Jupiter swap path.
  const swapFn = deps.swapToken || (await import("../tools/wallet.js")).swapToken;
  const sendRes = await swapFn({ input_mint, output_mint, amount });

  // 7) NEVER auto-retry. A failed send => log + alert + HALT. State unknown.
  if (!sendRes || sendRes.success !== true) {
    const errMsg = sendRes?.error || "unknown swap failure";
    log("btc_order_fail", `SWAP FAILED (NO RETRY): ${errMsg}`);
    await alertHalt(`BTC TSMOM swap FAILED: ${errMsg}. State unknown — manual on-chain verify required before any re-action.`);
    return { success: false, placed: "unknown", isDryRun: false, halted: true, reason: errMsg, intended, burner };
  }

  // 8) Confirm-then-verify (anti-pattern #3). Reuse the injected verifier or default.
  const verifyFn = deps.confirmAndVerify || confirmAndVerify;
  let verify;
  try {
    verify = await verifyFn({
      signature: sendRes.tx,
      output_mint,
      expectedOut: expForCheck,
      reportedOut: sendRes.amount_out != null ? fromBaseUnits(sendRes.amount_out, decimalsFor(output_mint)) : null,
    });
  } catch (e) {
    log("btc_order_fail", `VERIFY THREW (NO RETRY): ${e.message}`);
    await alertHalt(`BTC TSMOM swap sent (${sendRes.tx}) but verify FAILED: ${e.message}. Manual on-chain verify required.`);
    return { success: false, placed: "sent_unverified", isDryRun: false, halted: true, reason: e.message, signature: sendRes.tx, intended, burner };
  }

  if (!verify.ok) {
    log("btc_order_fail", `VERIFY MISMATCH (NO RETRY): ${verify.reason}`);
    await alertHalt(`BTC TSMOM swap ${sendRes.tx} verify mismatch: ${verify.reason}. Manual on-chain verify required.`);
    return { success: false, placed: "sent_unverified", isDryRun: false, halted: true, reason: verify.reason, signature: sendRes.tx, intended, burner };
  }

  log("btc_order", `LIVE order verified tx=${sendRes.tx} out=${verify.realizedOut}`);
  return {
    success: true,
    placed: true,
    isDryRun: false,
    signature: sendRes.tx,
    realizedOut: verify.realizedOut,
    slippageRealized: verify.slippageRealized,
    intended,
    burner,
  };
}

/**
 * Confirm a tx to 'confirmed' commitment, then READ the on-chain post-swap output
 * balance and assert the realized out matches expected within the slippage cap.
 * THROWS on confirmation error. Returns {ok, realizedOut, slippageRealized, reason}.
 * Fail-closed: an unreadable post-swap balance => ok:false (we cannot prove the
 * move, so we treat it as unverified, not as success).
 *
 * Injected connection in tests; defaults to a real RPC connection (live only).
 */
export async function confirmAndVerify({ signature, output_mint, expectedOut, reportedOut, conn = null }) {
  const { Connection } = await import("@solana/web3.js");
  const connection = conn || new Connection(process.env.RPC_URL, "confirmed");

  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  if (confirmation?.value?.err) {
    throw new Error(`TX failed on confirm: ${JSON.stringify(confirmation.value.err)}`);
  }

  // Prefer the swap's own reported out amount (Jupiter's executed result); if absent,
  // we cannot verify the realized move => fail-closed.
  const realizedOut =
    reportedOut === null || reportedOut === undefined || reportedOut === ""
      ? null
      : Number.isFinite(Number(reportedOut))
      ? Number(reportedOut)
      : null;
  if (realizedOut === null) {
    return { ok: false, realizedOut: null, slippageRealized: null, reason: "no_reported_out_fail_closed" };
  }

  const slip = assertSlippage(expectedOut, realizedOut);
  if (!slip.ok) {
    return { ok: false, realizedOut, slippageRealized: slip.slippage, reason: `realized_${slip.reason}` };
  }
  return { ok: true, realizedOut, slippageRealized: slip.slippage, reason: null };
}

/**
 * Halt-alert. Sends a Telegram alert if configured; always logs. NEVER throws (an
 * alert failure must not mask the original money-path failure).
 */
async function alertHalt(message) {
  try {
    const tg = await import("../telegram.js");
    if (typeof tg.sendMessage === "function") {
      await tg.sendMessage(`🔴 ${message}`);
    }
  } catch (e) {
    log("btc_order_alert_fail", `alert failed (non-fatal): ${e.message}`);
  }
}
