// scripts/test-btc-guards.js — fail-closed assertions for the BTC TSMOM money
// safety layer. Mirrors the DLMM 22-43 assertion pattern. NO network, NO wallet,
// NO money. Run: node scripts/test-btc-guards.js

import path from "path";
import os from "os";
import fs from "fs";

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${msg}`); }
}
function throws(fn, msg) {
  try { fn(); fail++; console.error(`  ✗ ${msg} (did NOT throw)`); }
  catch { pass++; }
}

const G = await import("../tsmom/btc-guards.js");

// ── hard-locked constants present + correct (Bro-confirmed package) ────────────
ok(G.BTC_TSMOM_MAX_LEVERAGE === 1.0, "leverage cap = 1.0 (leverage OFF)");
ok(G.BTC_TSMOM_DAILY_LOSS_HALT === 0.08, "daily loss halt = 8%");
ok(G.BTC_TSMOM_MAX_SLIPPAGE === 0.005, "slippage cap = 0.5%");
ok(G.BTC_TSMOM_MAX_EQUITY_USD <= 300 && G.BTC_TSMOM_MAX_EQUITY_USD >= 200, "probe equity cap in $200-300");
ok(G.CBBTC_MINT === "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", "cbBTC mint correct");
ok(G.CBBTC_DECIMALS === 8, "cbBTC decimals = 8");
ok(G.USDC_MINT === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC mint correct");

// ── DRY_RUN gate: only literal 'true'/'false' accepted, else THROW ─────────────
ok(G.assertDryRunGate("true") === true, "DRY_RUN 'true' => dry-run");
ok(G.assertDryRunGate("false") === false, "DRY_RUN 'false' => live");
throws(() => G.assertDryRunGate(undefined), "DRY_RUN unset throws");
throws(() => G.assertDryRunGate(""), "DRY_RUN empty throws");
throws(() => G.assertDryRunGate("TRUE"), "DRY_RUN 'TRUE' (wrong case) throws");
throws(() => G.assertDryRunGate("1"), "DRY_RUN '1' throws");
throws(() => G.assertDryRunGate("yes"), "DRY_RUN 'yes' throws");

// ── leverage clamp: vol-scaler weight (up to 2.0) clamped to 1.0 ───────────────
ok(G.clampLeverage(1.7).weight === 1.0 && G.clampLeverage(1.7).clamped, "weight 1.7 clamped to 1.0");
ok(G.clampLeverage(2.0).weight === 1.0, "weight 2.0 (max vol-scaler) clamped to 1.0");
ok(G.clampLeverage(0.6).weight === 0.6 && !G.clampLeverage(0.6).clamped, "weight 0.6 passes unchanged");
ok(G.clampLeverage(0).weight === 0, "weight 0 (flat) passes");
ok(G.clampLeverage(null).weight === 0 && G.clampLeverage(null).clamped, "non-finite weight => flat (fail-closed)");
ok(G.clampLeverage(NaN).weight === 0, "NaN weight => flat");
ok(G.clampLeverage("0.5").weight === 0.5, "numeric-string weight coerced");

// ── notional sizing: hard-capped by probe equity ──────────────────────────────
ok(G.targetNotionalUsd(1.0, 250).notionalUsd === 250, "weight 1.0 * $250 equity => $250");
ok(G.targetNotionalUsd(0.5, 250).notionalUsd === 125, "weight 0.5 * $250 => $125");
ok(G.targetNotionalUsd(1.0, 999999, 300).capped && G.targetNotionalUsd(1.0, 999999, 300).notionalUsd === 300, "huge equity capped at $300");
ok(G.targetNotionalUsd(null, 250).notionalUsd === 0, "non-finite weight => $0 notional");
ok(G.targetNotionalUsd(1.0, null).notionalUsd === 0, "non-finite equity => $0 notional");
ok(G.targetNotionalUsd(1.0, -5).notionalUsd === 0, "negative equity => $0 (fail-closed)");

// ── slippage refusal ───────────────────────────────────────────────────────────
ok(G.assertSlippage(100, 99.8).ok, "0.2% slippage within 0.5% cap => ok");
ok(!G.assertSlippage(100, 99).ok, "1% slippage exceeds 0.5% cap => refuse");
ok(G.assertSlippage(100, 100.5).ok, "positive slippage (got more) => ok");
ok(!G.assertSlippage(0, 99).ok && G.assertSlippage(0, 99).reason === "slippage_unknown_fail_closed", "zero expected => fail-closed refuse");
ok(!G.assertSlippage(null, 99).ok, "null expected => fail-closed refuse");
ok(!G.assertSlippage(100, null).ok, "null quoted => fail-closed refuse");

// ── daily-loss circuit ─────────────────────────────────────────────────────────
ok(!G.checkDailyLossCircuit(250, 240).halt, "down 4% => no halt");
ok(G.checkDailyLossCircuit(250, 230).halt, "down 8% => HALT");
ok(G.checkDailyLossCircuit(250, 200).halt, "down 20% => HALT");
ok(!G.checkDailyLossCircuit(250, 260).halt, "up 4% => no halt");
ok(G.checkDailyLossCircuit(null, 240).halt && G.checkDailyLossCircuit(null, 240).reason.includes("fail_closed"), "unknown baseline => HALT (fail-closed)");
ok(G.checkDailyLossCircuit(0, 240).halt, "zero baseline => HALT (fail-closed)");

// ── kill switch ────────────────────────────────────────────────────────────────
ok(G.checkKillSwitch("1").halted, "env BTC_TSMOM_KILL=1 => halted");
ok(G.checkKillSwitch("true").halted, "env BTC_TSMOM_KILL=true => halted");
ok(!G.checkKillSwitch("0", path.join(os.tmpdir(), "no-such-halt-file")).halted, "no flag, no file => not halted");
const haltFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "btc-kill-")), "BTC_TSMOM_HALT");
fs.writeFileSync(haltFile, "halt");
ok(G.checkKillSwitch("0", haltFile).halted, "kill file present => halted");

// ── preTradeGate orchestration ─────────────────────────────────────────────────
throws(() => G.preTradeGate({ dryRunRaw: undefined, windowStartEquity: 250, currentEquity: 250, rawWeight: 1 }), "preTradeGate throws on bad DRY_RUN");
const gDry = G.preTradeGate({ dryRunRaw: "true", windowStartEquity: 250, currentEquity: 250, rawWeight: 1.7 });
ok(gDry.allow && gDry.isDryRun && gDry.weight === 1.0 && gDry.weightClamped, "dry-run gate allows, clamps weight to 1.0");
ok(gDry.notionalUsd === 250, "dry-run gate sizes $250 notional");
const gHalt = G.preTradeGate({ dryRunRaw: "false", windowStartEquity: 250, currentEquity: 220, rawWeight: 1 });
ok(!gHalt.allow && gHalt.stage === "circuit", "circuit halt blocks live gate");

console.log(`\nbtc-guards: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
