// tsmom/btc-dryrun-validate.js — DRY-RUN rehearsal of the executor BRIDGE.
//
// VEGA 🔥 — Phase-B requirement #3. The paper-soak (tsmom-paper-soak.js) validates
// the SIGNAL. This runner validates the BRIDGE: every scheduled run drives the REAL
// executeStep() in DRY_RUN against the live signal, emitting the INTENDED order
// (cold_open / rebalance / mark / halt) WITHOUT placing it. It is the rehearsal that
// proves the signal→order→safety chain behaves before any capital touches it.
//
// It runs ALONGSIDE the paper-soak (separate state, separate cadence is fine). It does
// NOT replace the soak and does NOT write the soak's journal — it exercises the money
// BRIDGE in a no-money mode and logs what it WOULD do.
//
// HARD GUARANTEES (this file can NEVER move money):
//   * It FORCES DRY_RUN. It calls executeStep with dryRunRaw:"true" explicitly and
//     ALSO refuses to run if the ambient DRY_RUN env is the literal "false" (so a
//     mis-set environment can't be silently overridden into a live send by this path).
//   * executeStep in dry-run quotes + computes the intended order and places NOTHING
//     (btc-order.js dry-run branch returns the intended order, no wallet touched).
//   * It records an equity snapshot into the SAME baseline store the live circuit
//     uses — so by the time Phase D funds the burner, the 24h baseline is already
//     warm (the circuit isn't cold-start-blind on day one).
//
// EXACT CLI (Draco — wire a daily systemd timer to THIS, no guessing):
//   node tsmom/btc-dryrun-validate.js run        # fetch latest BTC close, dry-run the bridge, log intended order
//   node tsmom/btc-dryrun-validate.js status      # print last rehearsal result (no fetch, no write)
//   node tsmom/btc-dryrun-validate.js --help
//
// Env (all optional; defaults are safe):
//   BTC_TSMOM_PROBE_EQUITY_USD   rehearsal equity for sizing (default 250; <= MAX 300)
//   BTC_TSMOM_VALIDATE_STATE     rehearsal log state file (default data/btc-dryrun-validate.json)
//   BTC_TSMOM_STATE              executor book (default data/btc-position-v3-btc-long.json)
//   BTC_TSMOM_EQUITY_BASELINE    circuit baseline store (shared with live circuit)
//   TSMOM_SOAK_NO_FETCH=1        use cached BTC-daily.json, skip network (offline/test)
//
// NO money path. NO LLM cost.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchDailyHistoryYahoo, saveHistory, loadHistory } from "./ohlcv-ingest.js";
import { executeStep } from "./btc-executor.js";
import { loadPosition, coldPosition, markToMarket } from "./btc-position.js";
import { resolveCbbtcPrice } from "./btc-price-oracle.js";
import { V3_BTC_LONG_ASSET, V3_BTC_LONG_VERSION } from "./tsmom-variants.js";
import { BTC_TSMOM_MAX_EQUITY_USD } from "./btc-guards.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function validateStateFile() {
  return process.env.BTC_TSMOM_VALIDATE_STATE
    ? path.resolve(process.env.BTC_TSMOM_VALIDATE_STATE)
    : path.resolve(__dirname, "data", "btc-dryrun-validate.json");
}

function loadValidateState() {
  const f = validateStateFile();
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function saveValidateState(s) {
  const f = validateStateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  return f;
}

// Rehearsal equity for sizing. Clamp to the probe cap so a mis-set env can't size
// beyond the hard ceiling even in rehearsal. FAIL-SAFE: non-finite => 0 (the gate
// then sizes to 0 and the rehearsal simply shows a no-notional plan).
function probeEquityUsd() {
  const raw = Number(process.env.BTC_TSMOM_PROBE_EQUITY_USD);
  const eq = Number.isFinite(raw) && raw > 0 ? raw : 250;
  return Math.min(eq, BTC_TSMOM_MAX_EQUITY_USD);
}

/**
 * Run one dry-run rehearsal of the executor bridge. FORCES dry-run. Returns a summary.
 * @param {object} [opts]
 * @param {boolean} [opts.fetch=true]  refresh BTC daily history first
 */
export async function runValidate({ fetch = true } = {}) {
  // HARD GUARD: never run this rehearsal if the ambient env says LIVE. This file is a
  // rehearsal — if someone set DRY_RUN=false in the environment, that's a live config;
  // refuse rather than masking it (we pass dryRunRaw:"true" below, but refusing here
  // is defense-in-depth so this path can never be the thing that placed a live order).
  if (process.env.DRY_RUN === "false") {
    return { action: "refused", reason: "ambient_DRY_RUN_false_refusing_rehearsal_on_live_env" };
  }

  // 1) Refresh BTC daily history (same source/cadence as the soak).
  if (fetch && process.env.TSMOM_SOAK_NO_FETCH !== "1") {
    const res = await fetchDailyHistoryYahoo(V3_BTC_LONG_ASSET);
    if (res.ok) saveHistory(res);
    // else: fall through to cached data (honest — flagged below if missing).
  }
  const history = loadHistory(V3_BTC_LONG_ASSET);
  if (!history || !Array.isArray(history.rows) || !history.rows.length) {
    return { action: "error", reason: `no BTC history — run: node tsmom/ohlcv-ingest.js BTC` };
  }

  // 2) Independent price (for an honest intended-fill in the rehearsal log).
  const price = await resolveCbbtcPrice();
  const priceUsd = price.ok ? price.price : null;

  // 3) Equity for sizing. Rehearsal uses the configured probe equity. (No funded
  //    wallet in dry-run — this is a notional sizing rehearsal, clearly labeled.)
  const equityUsd = probeEquityUsd();

  // 4) Drive the REAL bridge in DRY_RUN. executeStep records an equity snapshot into
  //    the baseline store (warming the circuit) and computes the intended order with
  //    NO placement. We pass the resolved independent price as the explicit override
  //    so the rehearsal's expectedOut matches what live would use.
  const step = await executeStep({
    rows: history.rows,
    currentEquityUsd: equityUsd,
    cbbtcPriceUsd: priceUsd != null ? priceUsd : undefined,
    recordSnapshot: true,
    dryRunRaw: "true", // FORCE dry-run — never reads ambient env here
  });

  // 5) Mark the current book for context (rehearsal only).
  const book = loadPosition() || coldPosition();
  const mtm = priceUsd != null ? markToMarket(book, priceUsd) : null;

  const nowIso = new Date().toISOString();
  const summary = {
    at: nowIso,
    config_version: V3_BTC_LONG_VERSION,
    asset: V3_BTC_LONG_ASSET,
    action: step.action,
    would_order: step.intended?.intended ? true : false,
    would_halt_live: step.wouldHaltLive === true,
    live_halt_reason: step.wouldHaltLive ? `${step.gateStage}/${step.gateReason}` : null,
    intended: step.intended?.intended || null, // {input_mint, output_mint, amount, quotedOut, expectedOut, slippage}
    price_source: price.source,
    price_usd: priceUsd,
    price_available: priceUsd != null,
    equity_usd: equityUsd,
    plan: step.plan ? { side: step.plan.side, amount: step.plan.amount, targetWeight: step.plan.targetWeight, targetNotional: step.plan.targetNotional, reason: step.plan.reason } : null,
    book_units: book.cbbtc_units,
    mtm,
  };

  // 6) Append to the rehearsal log (rolling tail).
  const state = loadValidateState() || { version: V3_BTC_LONG_VERSION, created_at: nowIso, runs: [] };
  state.runs.push(summary);
  if (state.runs.length > 200) state.runs = state.runs.slice(state.runs.length - 200);
  state.last_run = summary;
  saveValidateState(state);

  log("btc_dryrun_validate",
    `rehearsal ${step.action}: ${summary.would_order ? `WOULD ${summary.plan?.side} ${summary.plan?.amount} ($${summary.plan?.targetNotional})` : "no order"} ` +
    `@ ${priceUsd != null ? `$${priceUsd} (${price.source})` : "PRICE UNAVAILABLE"}`);

  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function printStatus(state) {
  if (!state || !state.last_run) {
    console.log("[btc-dryrun-validate] no rehearsal yet. Run `node tsmom/btc-dryrun-validate.js run`.");
    return;
  }
  const r = state.last_run;
  console.log(`# BTC TSMOM dry-run bridge rehearsal — ${state.version}`);
  console.log(`State file : ${validateStateFile()}`);
  console.log(`Last run   : ${r.at}`);
  console.log(`Action     : ${r.action}`);
  console.log(`Price      : ${r.price_available ? `$${r.price_usd} (${r.price_source})` : "UNAVAILABLE (live would refuse)"}`);
  console.log(`Equity     : $${r.equity_usd} (rehearsal probe equity)`);
  if (r.would_halt_live) console.log(`LIVE GATE  : ⚠ WOULD HALT — ${r.live_halt_reason} (e.g. cold/young 24h baseline, or a real drawdown)`);
  if (r.would_order && r.plan) {
    console.log(`WOULD ORDER: ${r.plan.side} amount ${r.plan.amount} (weight ${r.plan.targetWeight}, notional $${r.plan.targetNotional})`);
    if (r.intended) console.log(`  expectedOut ${r.intended.expectedOut}  quotedOut ${r.intended.quotedOut}  slippage ${r.intended.slippage}`);
  } else {
    console.log(`WOULD ORDER: none (${r.plan?.reason || r.action})`);
  }
  console.log(`Book units : ${r.book_units} cbBTC`);
  console.log(`Total rehearsals logged: ${state.runs.length}`);
}

async function main() {
  const cmd = (process.argv[2] || "run").toLowerCase();
  if (cmd === "--help" || cmd === "help" || cmd === "-h") {
    console.log(`BTC TSMOM dry-run BRIDGE rehearsal — ${V3_BTC_LONG_VERSION}

Validates the executor BRIDGE (signal->order->safety) in DRY_RUN, alongside the
paper-soak which validates the SIGNAL. Places NOTHING. Moves NO money.

Usage:
  node tsmom/btc-dryrun-validate.js run       fetch latest BTC close, dry-run the bridge, log intended order
  node tsmom/btc-dryrun-validate.js status    print last rehearsal (no fetch, no write)
  node tsmom/btc-dryrun-validate.js --help

Env:
  BTC_TSMOM_PROBE_EQUITY_USD   rehearsal sizing equity (default 250, clamped <= ${BTC_TSMOM_MAX_EQUITY_USD})
  BTC_TSMOM_VALIDATE_STATE     rehearsal log path (default tsmom/data/btc-dryrun-validate.json)
  BTC_TSMOM_EQUITY_BASELINE    24h circuit baseline store (shared with live circuit; warmed here)
  TSMOM_SOAK_NO_FETCH=1        use cached BTC-daily.json, skip network (offline/test)`);
    return;
  }
  if (cmd === "status") {
    printStatus(loadValidateState());
    return;
  }
  if (cmd === "run") {
    const r = await runValidate({ fetch: true });
    console.log(`# BTC TSMOM dry-run bridge rehearsal — ${V3_BTC_LONG_VERSION}`);
    console.log(`Action: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
    if (r.would_order && r.plan) {
      console.log(`WOULD ORDER: ${r.plan.side} ${r.plan.amount} (notional $${r.plan.targetNotional}) @ ${r.price_available ? `$${r.price_usd} (${r.price_source})` : "PRICE UNAVAILABLE"}`);
    } else {
      console.log(`WOULD ORDER: none`);
    }
    if (r.would_halt_live) console.log(`LIVE GATE  : WOULD HALT — ${r.live_halt_reason}`);
    console.log(`(No money moved. DRY-RUN rehearsal only. Run \`status\` for detail.)`);
    return;
  }
  console.error(`unknown command "${cmd}". Try: run | status | --help`);
  process.exit(1);
}

if (process.argv[1]?.endsWith("btc-dryrun-validate.js")) {
  main().catch((e) => {
    console.error("[btc-dryrun-validate] fatal:", e.message);
    process.exit(1);
  });
}
