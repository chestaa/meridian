// tsmom/btc-position.js — on-chain position state for v3-btc-long live execution.
//
// VEGA 🔥 — the source of truth for "what cbBTC do we hold and at what basis?".
// Chain truth (the actual cbBTC token balance) is AUTHORITATIVE; our recorded
// entry basis is bookkeeping layered on top. The two must reconcile (btc-reconcile.js)
// before any order — a drift means we don't actually know our exposure, and an
// unknown exposure is a no-trade (fail-closed).
//
// STATE SHAPE (single JSON file, idempotent like the paper-soak state):
//   {
//     version, asset: "BTC", venue: "cbBTC-spot-jupiter", cash: "USDC",
//     created_at, last_update_at,
//     cbbtc_units,        // BOOK quantity we believe we hold (chain is truth)
//     entry_basis_usd,    // weighted-avg USD cost basis of the held cbBTC
//     usdc_units,         // BOOK cash leg
//     last_chain_read: { cbbtc_units, usdc_units, at } | null,
//     fills: [ { at, side, in_mint, out_mint, in_amt, out_amt, price_usd, signature } ]
//   }
//
// NO MONEY MOVES HERE. This module reads chain balances and maintains book state.
// The actual swap is btc-order.js; the bridge is btc-executor.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CBBTC_MINT, USDC_MINT } from "./btc-guards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "v3-btc-long";

export function btcStateFile() {
  return process.env.BTC_TSMOM_STATE
    ? path.resolve(process.env.BTC_TSMOM_STATE)
    : path.resolve(__dirname, "data", "btc-position-v3-btc-long.json");
}

export function coldPosition() {
  return {
    version: VERSION,
    asset: "BTC",
    venue: "cbBTC-spot-jupiter",
    cash: "USDC",
    created_at: new Date().toISOString(),
    last_update_at: null,
    cbbtc_units: 0,
    entry_basis_usd: 0, // weighted-avg per-unit USD cost of the held cbBTC; 0 when flat
    usdc_units: 0,
    last_chain_read: null,
    fills: [],
  };
}

export function loadPosition() {
  const f = btcStateFile();
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null; // corrupt => treat as cold; never crash the money path on bad state
  }
}

export function savePosition(state) {
  const f = btcStateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
  return f;
}

/**
 * Read the ACTUAL on-chain cbBTC + USDC balances. CHAIN IS TRUTH. Uses the existing
 * Helius-backed getWalletBalances (which is itself fail-closed: a read failure
 * returns sol:null + error:true, never sentinel 0). We propagate that: a failed read
 * returns { ok:false } so callers fail-closed (no trade on an unknown balance).
 *
 * @param {function} [getBalances] injectable for tests
 * @returns {Promise<{ok:boolean, cbbtc_units:number|null, usdc_units:number|null, reason?:string}>}
 */
export async function readChainPosition(getBalances) {
  const fn = getBalances || (await import("../tools/wallet.js")).getWalletBalances;
  const bal = await fn();
  if (!bal || bal.error === true) {
    return { ok: false, cbbtc_units: null, usdc_units: null, reason: bal?.error_message || "balance_read_failed" };
  }
  // tokens[] is the canonical SPL list; find cbBTC by mint. USDC is on bal.usdc.
  const tokens = Array.isArray(bal.tokens) ? bal.tokens : [];
  const cbEntry = tokens.find((t) => t.mint === CBBTC_MINT);
  // A read that returns no cbBTC entry means 0 held (a 200 with full token list and
  // no cbBTC = genuinely flat). USDC: prefer the explicit field, else the token list.
  const cbbtc_units = cbEntry ? Number(cbEntry.balance) || 0 : 0;
  // NOTE: Number(null)===0 — must reject null/undefined BEFORE coercing, else an
  // absent USDC field would fabricate a 0 balance (fail-OPEN). Fail-closed.
  let usdc_units =
    bal.usdc === null || bal.usdc === undefined || bal.usdc === ""
      ? null
      : Number.isFinite(Number(bal.usdc))
      ? Number(bal.usdc)
      : null;
  if (usdc_units === null) {
    const uEntry = tokens.find((t) => t.mint === USDC_MINT);
    usdc_units = uEntry ? Number(uEntry.balance) || 0 : null;
  }
  // USDC null = unknown (the field was absent) => fail-closed read.
  if (usdc_units === null) {
    return { ok: false, cbbtc_units, usdc_units: null, reason: "usdc_balance_unknown" };
  }
  return { ok: true, cbbtc_units, usdc_units };
}

/**
 * Record a fill into the position book and update cbBTC units + weighted-avg basis.
 * Pure-ish: mutates+returns a NEW state object (does not write). The caller persists.
 *
 * side: "buy"  => USDC->cbBTC, cbbtc_units increases, basis updates (weighted avg).
 *       "sell" => cbBTC->USDC, cbbtc_units decreases, basis preserved until flat.
 *
 * @param {object} state
 * @param {object} fill { side, in_amt, out_amt, price_usd, signature, at }
 */
export function applyFill(state, fill) {
  const s = JSON.parse(JSON.stringify(state || coldPosition()));
  const at = fill.at || new Date().toISOString();
  const inAmt = Number(fill.in_amt);
  const outAmt = Number(fill.out_amt);
  const priceUsd = Number(fill.price_usd);

  if (!Number.isFinite(inAmt) || !Number.isFinite(outAmt) || inAmt <= 0 || outAmt <= 0) {
    throw new Error(`applyFill: non-finite/non-positive amounts (in=${fill.in_amt} out=${fill.out_amt})`);
  }

  if (fill.side === "buy") {
    // bought outAmt cbBTC for inAmt USDC. New weighted-avg basis.
    const newUnits = +(s.cbbtc_units + outAmt).toFixed(10);
    const oldCost = s.cbbtc_units * s.entry_basis_usd;
    const addCost = inAmt; // USDC spent
    s.entry_basis_usd = newUnits > 0 ? +((oldCost + addCost) / newUnits).toFixed(6) : 0;
    s.cbbtc_units = newUnits;
    s.usdc_units = +(s.usdc_units - inAmt).toFixed(6);
  } else if (fill.side === "sell") {
    // sold inAmt cbBTC for outAmt USDC. Basis per-unit unchanged until flat.
    const newUnits = +(s.cbbtc_units - inAmt).toFixed(10);
    s.cbbtc_units = newUnits > 1e-9 ? newUnits : 0;
    if (s.cbbtc_units === 0) s.entry_basis_usd = 0; // flat => reset basis
    s.usdc_units = +(s.usdc_units + outAmt).toFixed(6);
  } else {
    throw new Error(`applyFill: unknown side "${fill.side}"`);
  }

  s.fills.push({
    at,
    side: fill.side,
    in_mint: fill.in_mint || null,
    out_mint: fill.out_mint || null,
    in_amt: inAmt,
    out_amt: outAmt,
    price_usd: Number.isFinite(priceUsd) ? priceUsd : null,
    signature: fill.signature || null,
  });
  s.last_update_at = at;
  return s;
}

/**
 * Unrealized PnL of the held cbBTC at a current price. Returns {units, basisUsd,
 * markUsd, unrealizedUsd, unrealizedPct}. Fail-closed: non-finite price => nulls.
 */
export function markToMarket(state, currentPriceUsd) {
  const units = Number(state?.cbbtc_units) || 0;
  const basis = Number(state?.entry_basis_usd) || 0;
  const px = Number(currentPriceUsd);
  if (!Number.isFinite(px) || px <= 0) {
    return { units, basisUsd: basis, markUsd: null, unrealizedUsd: null, unrealizedPct: null };
  }
  const costValue = units * basis;
  const markValue = units * px;
  const unrealizedUsd = +(markValue - costValue).toFixed(6);
  const unrealizedPct = costValue > 0 ? +((markValue / costValue - 1)).toFixed(6) : 0;
  return { units, basisUsd: basis, markUsd: +markValue.toFixed(6), unrealizedUsd, unrealizedPct };
}
