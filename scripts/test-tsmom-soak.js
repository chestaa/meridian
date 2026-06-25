// scripts/test-tsmom-soak.js — deterministic tests for the v3-btc-long variant
// and the forward paper-soak runner. NO network (TSMOM_SOAK_NO_FETCH), isolated
// temp state + journal files. Run: node scripts/test-tsmom-soak.js
//
// Covers: variant pre-registered params (long-only, BTC-only, mechanically v2);
// no-peek decision; cold open; rebalance cadence; mark-to-market between
// rebalances; idempotency (re-run same bar = no double-log); journal proxy
// honesty (never is_realized money); long/flat logic (no short ever emitted).

import fs from "fs";
import os from "os";
import path from "path";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}
function approx(a, b, eps = 1e-6) {
  return a != null && b != null && Math.abs(a - b) <= eps;
}

// ── isolate state + journal into a fresh temp dir BEFORE importing modules ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsmom-soak-"));
const dataDirPath = path.join(tmp, "data");
fs.mkdirSync(dataDirPath, { recursive: true });
process.env.TSMOM_DATA_DIR = dataDirPath;
process.env.TSMOM_SOAK_STATE = path.join(tmp, "soak.json");
process.env.JOURNAL_FILE = path.join(tmp, "journal.jsonl");
process.env.TSMOM_SOAK_NO_FETCH = "1"; // never touch the network in tests

const variants = await import("../tsmom/tsmom-variants.js");
const soak = await import("../tsmom/tsmom-paper-soak.js");
const { signalAt } = await import("../tsmom/tsmom-signal.js");
const { readEntries, effectiveEntries } = await import("../journal.js");

const { V3_BTC_LONG_PARAMS, V3_BTC_LONG_ASSET, V3_BTC_LONG_VERSION, getVariant, TSMOM_VARIANTS } = variants;

// ── synthetic BTC history builder ───────────────────────────────────────
// Writes a BTC-daily.json into the isolated data dir. `closes` is the full
// close series; the LAST row is treated by the runner as the live/partial day,
// so the latest CLOSED bar is the second-to-last. Dates are sequential from a base.
function writeBtcHistory(closes) {
  const rows = closes.map((c, i) => {
    const ts = Date.UTC(2024, 0, 1) + i * 86400000;
    return { date: new Date(ts).toISOString().slice(0, 10), ts, open: null, high: null, low: null, close: c, volume: null };
  });
  const payload = {
    asset: "BTC", source: "yahoo-finance", fetched_at: new Date().toISOString(),
    requested_days: null, row_count: rows.length,
    first_date: rows[0]?.date ?? null, last_date: rows[rows.length - 1]?.date ?? null,
    gaps: [], warnings: [], rows,
  };
  fs.writeFileSync(path.join(dataDirPath, "BTC-daily.json"), JSON.stringify(payload));
  return rows;
}

function resetState() {
  if (fs.existsSync(process.env.TSMOM_SOAK_STATE)) fs.unlinkSync(process.env.TSMOM_SOAK_STATE);
  if (fs.existsSync(process.env.JOURNAL_FILE)) fs.unlinkSync(process.env.JOURNAL_FILE);
}

// Build a long uptrend series long enough to satisfy 252d lookback + 60d vol.
// Need > lookback+1 closed bars. We make a gently rising series with small noise
// so realized vol is finite and the trailing-252d return is clearly positive.
function uptrendCloses(n, start = 100, drift = 0.004, noiseAmp = 0.01) {
  const out = [start];
  for (let i = 1; i < n; i++) {
    const noise = noiseAmp * Math.sin(i * 1.7); // deterministic, bounded
    out.push(+(out[i - 1] * (1 + drift + noise)).toFixed(6));
  }
  return out;
}
function downtrendCloses(n, start = 100, drift = -0.004, noiseAmp = 0.01) {
  const out = [start];
  for (let i = 1; i < n; i++) {
    const noise = noiseAmp * Math.sin(i * 1.7);
    out.push(+(out[i - 1] * (1 + drift + noise)).toFixed(6));
  }
  return out;
}

// ── 1) VARIANT: pre-registered params ────────────────────────────────────
{
  ok(V3_BTC_LONG_ASSET === "BTC", "variant asset is BTC-only");
  ok(V3_BTC_LONG_VERSION === "v3-btc-long", "variant version string");
  ok(V3_BTC_LONG_PARAMS.allowShort === false, "variant is long/flat (allowShort=false)");
  ok(V3_BTC_LONG_PARAMS.lookbackDays === 252, "lookback mechanically identical to v2 (252)");
  ok(V3_BTC_LONG_PARAMS.rebalanceDays === 21, "rebalance mechanically identical to v2 (21)");
  ok(V3_BTC_LONG_PARAMS.volWindowDays === 60, "vol window identical (60)");
  ok(approx(V3_BTC_LONG_PARAMS.targetAnnualVol, 0.40), "target vol identical (0.40)");
  ok(approx(V3_BTC_LONG_PARAMS.maxLeverage, 2.0), "max leverage identical (2.0)");
  ok(Object.isFrozen(V3_BTC_LONG_PARAMS), "params object is frozen (no silent drift)");

  // registry / resolver
  const v = getVariant("v3-btc-long");
  ok(v.params === V3_BTC_LONG_PARAMS, "getVariant returns the frozen params");
  ok(v.asset === "BTC", "getVariant returns BTC scope");
  let threw = false;
  try { getVariant("v999-nope"); } catch { threw = true; }
  ok(threw, "getVariant throws loudly on unknown version (no silent fallback)");
  ok(Object.isFrozen(TSMOM_VARIANTS), "variant registry is frozen");
}

// ── 2) LONG-ONLY LOGIC: short never emitted, even in a downtrend ──────────
{
  // In a clear downtrend the v1 spec would go SHORT (signal -1). v3 must go FLAT.
  const closes = downtrendCloses(320);
  const dates = closes.map((_, i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const idx = closes.length - 2; // latest closed bar
  const sig = signalAt(closes, dates, idx, V3_BTC_LONG_PARAMS);
  ok(sig != null, "signal computable on long downtrend series");
  ok(sig.signal === 0, "downtrend => FLAT (signal 0), NEVER short under v3");
  ok(sig.weight === 0, "flat => zero weight (cash)");

  // The SAME series under allowShort:true (v1/v2 spec) WOULD short — proves v3
  // changed the behavior, not the data.
  const sigShort = signalAt(closes, dates, idx, { ...V3_BTC_LONG_PARAMS, allowShort: true });
  ok(sigShort.signal === -1, "control: same data with allowShort=true goes SHORT");
}

// ── 3) NO-PEEK: signal at idx uses only closes[..idx] ─────────────────────
{
  const closes = uptrendCloses(320);
  const dates = closes.map((_, i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const idx = 300;
  const sigA = signalAt(closes, dates, idx, V3_BTC_LONG_PARAMS);
  // Mutate FUTURE closes (after idx) wildly — signal at idx must be unchanged.
  const closesB = closes.slice();
  for (let i = idx + 1; i < closesB.length; i++) closesB[i] = closesB[i] * 1000;
  const sigB = signalAt(closesB, dates, idx, V3_BTC_LONG_PARAMS);
  ok(sigA.signal === sigB.signal && approx(sigA.weight, sigB.weight), "no-peek: future closes do NOT affect signal at idx");
}

// ── 4) decideSoak + runSoak: cold open in an uptrend ──────────────────────
{
  resetState();
  writeBtcHistory(uptrendCloses(300));
  const r = await soak.runSoak({ fetch: false, log: true });
  ok(r.action === "cold_open", "first run on fresh state => cold_open");
  ok(r.sig.signal === 1, "uptrend cold open is LONG");
  const st = soak.loadSoakState();
  ok(st.open_position != null, "state has an open position after cold_open");
  ok(st.open_position.signal === 1, "open position recorded LONG");
  ok(st.closed_periods === 0, "no closed periods yet at cold open");
  ok(readEntries().length === 0, "cold open writes NO journal entry (nothing closed yet)");
}

// ── 5) IDEMPOTENCY: re-run same bar = no change, no double-log ─────────────
{
  // state from test 4 is still on disk; same history => same latest closed bar.
  const before = soak.loadSoakState();
  const r2 = await soak.runSoak({ fetch: false, log: true });
  ok(r2.action === "noop" || r2.action === "mark", `re-run same bar is non-mutating (got ${r2.action})`);
  const after = soak.loadSoakState();
  ok(after.closed_periods === before.closed_periods, "idempotent: closed_periods unchanged on re-run");
  ok(after.open_position.entry_date === before.open_position.entry_date, "idempotent: open position unchanged");
  ok(readEntries().length === 0, "idempotent: no journal entry added on re-run");
}

// ── 6) MARK-TO-MARKET between rebalances ──────────────────────────────────
{
  // Append a few NEW closed bars but FEWER than rebalanceDays (21) since entry.
  resetState();
  const base = uptrendCloses(300);
  writeBtcHistory(base);
  await soak.runSoak({ fetch: false, log: true }); // cold open at bar 298 (closed)
  const opened = soak.loadSoakState().open_position.entry_date;

  // add 5 more bars (still < 21 elapsed) — latest closed bar advances by 5
  const grown = base.concat(uptrendCloses(6, base[base.length - 1] * 1.001).slice(1));
  writeBtcHistory(grown);
  const r = await soak.runSoak({ fetch: false, log: true });
  ok(r.action === "mark", `<21 days elapsed => mark-to-market (got ${r.action})`);
  ok(r.mtm && r.mtm.period_return != null, "mark produces an unrealized strat return");
  ok(soak.loadSoakState().closed_periods === 0, "mark does NOT log a closed period");
  ok(readEntries().length === 0, "mark writes no journal entry");
  ok(soak.loadSoakState().open_position.entry_date === opened, "mark keeps the same open position");
}

// ── 7) REBALANCE: >=21 elapsed closes the period + logs ONE proxy entry ────
{
  resetState();
  const base = uptrendCloses(300);
  writeBtcHistory(base);
  await soak.runSoak({ fetch: false, log: true }); // cold open

  // add 25 more bars (> 21 rebalanceDays elapsed)
  const grown = base.concat(uptrendCloses(26, base[base.length - 1] * 1.001).slice(1));
  writeBtcHistory(grown);
  const r = await soak.runSoak({ fetch: false, log: true });
  ok(r.action === "rebalance", `>=21 days elapsed => rebalance (got ${r.action})`);
  ok(r.closedPeriod && r.closedPeriod.period_return != null, "rebalance produces a closed-period return");
  ok(r.journalEntry != null, "rebalance logs a journal entry");

  const entries = effectiveEntries(readEntries());
  ok(entries.length === 1, "exactly ONE forward period logged after first rebalance");
  const e = entries[0];
  ok(e.experiment_id === "TSMOM", "journal entry experiment_id=TSMOM");
  ok(e.config_version === "v3-btc-long", "journal entry config_version=v3-btc-long");
  ok(e.outcome.unit === "proxy", "journal outcome unit=proxy");
  ok(e.outcome.is_realized === false, "journal outcome is_realized=false (NEVER money)");
  ok(e.setup.forward === true, "journal entry flagged forward=true");
  ok(soak.loadSoakState().closed_periods === 1, "state closed_periods incremented to 1");
  ok(soak.loadSoakState().open_position.entry_date === r.latestDate, "new position opened at the rebalance bar");
}

// ── 8) REBALANCE idempotency: re-run after rebalance does not double-log ───
{
  // continuing from test 7 — same history, same latest closed bar
  const before = readEntries().length;
  const r = await soak.runSoak({ fetch: false, log: true });
  ok(r.action === "noop" || r.action === "mark", `re-run right after rebalance is non-mutating (got ${r.action})`);
  ok(readEntries().length === before, "no duplicate journal entry on re-run after rebalance");
}

// ── 9) PROXY HONESTY: even if a caller tries is_realized, proxy stays false ─
{
  // logClosedPeriod always uses unit=proxy; journal.normalizeEntry enforces that
  // is_realized can only be true for SOL/USD. We assert the wired entry is honest.
  const entries = effectiveEntries(readEntries());
  ok(entries.every((e) => e.outcome.unit === "proxy" && e.outcome.is_realized === false),
    "ALL soak journal entries are proxy + non-realized (PnL!=money trap closed)");
}

// ── 10) INSUFFICIENT: too-short history => no crash, no position ───────────
{
  resetState();
  writeBtcHistory(uptrendCloses(50)); // < lookback(252)+1
  const r = await soak.runSoak({ fetch: false, log: true });
  ok(r.action === "insufficient", "history shorter than lookback => insufficient (no fabrication)");
  const st = soak.loadSoakState();
  ok(!st || !st.open_position, "no position opened on insufficient data");
  ok(readEntries().length === 0, "no journal entry on insufficient data");
}

// ── summary ───────────────────────────────────────────────────────────────
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\ntsmom-soak tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
