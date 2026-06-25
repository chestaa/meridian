// scripts/test-btc-position.js — assertions for BTC TSMOM on-chain position state.
// Isolated temp state file; chain read injected — NO network, NO money.
// Run: node scripts/test-btc-position.js

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }
function approx(a, b, e = 1e-4) { return a != null && b != null && Math.abs(a - b) <= e; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-pos-"));
process.env.BTC_TSMOM_STATE = path.join(tmp, "pos.json");

const P = await import("../tsmom/btc-position.js");
const { CBBTC_MINT, USDC_MINT } = await import("../tsmom/btc-guards.js");

// ── cold + persistence round-trip ──────────────────────────────────────────────
ok(P.loadPosition() === null, "no state file => null (cold)");
const cold = P.coldPosition();
ok(cold.cbbtc_units === 0 && cold.entry_basis_usd === 0 && cold.fills.length === 0, "cold position is flat");
P.savePosition(cold);
ok(P.loadPosition() !== null && P.loadPosition().version === "v3-btc-long", "save/load round-trip");

// ── readChainPosition: chain is truth, fail-closed on read error ───────────────
const failRead = async () => ({ error: true, error_message: "helius blip", sol: null, tokens: [] });
const r1 = await P.readChainPosition(failRead);
ok(!r1.ok && r1.cbbtc_units === null, "balance read failure => ok:false, units null (fail-closed)");

const goodRead = async () => ({
  error: false, usdc: 250,
  tokens: [{ mint: CBBTC_MINT, balance: 0.004, symbol: "cbBTC" }, { mint: USDC_MINT, balance: 250, symbol: "USDC" }],
});
const r2 = await P.readChainPosition(goodRead);
ok(r2.ok && r2.cbbtc_units === 0.004 && r2.usdc_units === 250, "good read => cbBTC + USDC from chain");

const flatRead = async () => ({ error: false, usdc: 300, tokens: [{ mint: USDC_MINT, balance: 300 }] });
const r3 = await P.readChainPosition(flatRead);
ok(r3.ok && r3.cbbtc_units === 0, "no cbBTC entry => genuinely flat (0, not error)");

const noUsdcRead = async () => ({ error: false, usdc: null, tokens: [] });
const r4 = await P.readChainPosition(noUsdcRead);
ok(!r4.ok && r4.reason === "usdc_balance_unknown", "absent USDC field => fail-closed");

// ── applyFill: buy updates units + weighted-avg basis ──────────────────────────
let st = P.coldPosition();
st.usdc_units = 300;
st = P.applyFill(st, { side: "buy", in_mint: USDC_MINT, out_mint: CBBTC_MINT, in_amt: 100, out_amt: 0.001667, price_usd: 60000 });
ok(approx(st.cbbtc_units, 0.001667), "buy: cbBTC units increase");
ok(approx(st.entry_basis_usd, 100 / 0.001667), "buy: basis = USDC spent / units");
ok(approx(st.usdc_units, 200), "buy: USDC decreases by spend");
ok(st.fills.length === 1 && st.fills[0].side === "buy", "buy: fill recorded");

// second buy at a different price => weighted avg basis
st = P.applyFill(st, { side: "buy", in_mint: USDC_MINT, out_mint: CBBTC_MINT, in_amt: 100, out_amt: 0.002, price_usd: 50000 });
const expBasis = (100 + 100) / (0.001667 + 0.002);
ok(approx(st.entry_basis_usd, expBasis, 1), "second buy: weighted-avg basis");

// ── applyFill: sell reduces units, resets basis when flat ──────────────────────
let st2 = P.coldPosition();
st2.cbbtc_units = 0.003; st2.entry_basis_usd = 55000; st2.usdc_units = 0;
st2 = P.applyFill(st2, { side: "sell", in_mint: CBBTC_MINT, out_mint: USDC_MINT, in_amt: 0.003, out_amt: 180, price_usd: 60000 });
ok(st2.cbbtc_units === 0, "sell-all => flat units");
ok(st2.entry_basis_usd === 0, "sell-all => basis reset to 0");
ok(approx(st2.usdc_units, 180), "sell: USDC increases by proceeds");

// ── applyFill: fail-closed on bad amounts / unknown side ───────────────────────
let threw = false;
try { P.applyFill(P.coldPosition(), { side: "buy", in_amt: 0, out_amt: 1 }); } catch { threw = true; }
ok(threw, "applyFill throws on zero in_amt");
threw = false;
try { P.applyFill(P.coldPosition(), { side: "wat", in_amt: 1, out_amt: 1 }); } catch { threw = true; }
ok(threw, "applyFill throws on unknown side");

// ── markToMarket ───────────────────────────────────────────────────────────────
const mtm = P.markToMarket({ cbbtc_units: 0.005, entry_basis_usd: 50000 }, 60000);
ok(approx(mtm.unrealizedUsd, 0.005 * (60000 - 50000)), "mtm: unrealized USD correct");
ok(approx(mtm.unrealizedPct, 0.2), "mtm: +20% unrealized");
const mtmBad = P.markToMarket({ cbbtc_units: 0.005, entry_basis_usd: 50000 }, null);
ok(mtmBad.markUsd === null && mtmBad.unrealizedUsd === null, "mtm: non-finite price => null (fail-closed)");

console.log(`\nbtc-position: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
