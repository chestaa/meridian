// tsmom/btc-equity-baseline.js — PERSISTED 24h equity baseline for the daily-loss circuit.
//
// VEGA 🔥 — Phase-B gap #1 fix. The circuit breaker (checkDailyLossCircuit in
// btc-guards.js) needs an HONEST 24h-ago equity to measure drawdown against. Before
// this module, executeStep defaulted windowStartEquity to currentEquity → drawdown
// 0% → the breaker could NEVER trip. That is a circuit breaker wired to never fire.
//
// This module stores a rolling equity snapshot in a small JSON state file (same
// idempotent discipline as the soak/position state) and resolves the baseline that
// is closest to ~24h old. The contract is:
//
//   recordEquitySnapshot(equityUsd)  — append a {at, equityUsd} sample (call each run).
//   resolveBaselineEquity(now)       — return { equityUsd, age_hours, reason } where
//                                      equityUsd is the snapshot nearest to 24h ago
//                                      INSIDE the freshness window, else null.
//
// FAIL-CLOSED (the whole point): if there is NO usable baseline (no samples, or the
// only samples are too YOUNG to bound a 24h window, or too STALE to trust), we
// return equityUsd:null. The caller passes that straight into checkDailyLossCircuit,
// which already HALTS on a non-finite baseline ("equity_unknown_fail_closed_halt").
// So a missing/stale baseline errs toward HALT, NEVER toward "no drawdown / safe".
//
// NO MONEY MOVES HERE. Read/write a state file + a pure baseline-selection decision.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Window we measure drawdown over (the circuit is a "−8% / 24h" breaker).
export const WINDOW_HOURS = 24;
// A snapshot must be at least this old to anchor a 24h baseline. If our oldest
// sample is younger than this, we do NOT have a true 24h reference yet → fail-closed.
// (At cold start we genuinely cannot know the 24h drawdown — so we HALT, by design,
//  until the snapshot store has aged enough. Phase D funding will pre-seed it.)
export const MIN_BASELINE_AGE_HOURS = 20; // allow some slack below 24h (timer jitter)
// A snapshot older than this is STALE — the runner has not been recording, so we
// cannot trust it as "24h ago". Treat as no-baseline → fail-closed HALT.
export const MAX_BASELINE_AGE_HOURS = 48;
// Keep at most this many samples (a couple days at a daily/hourly cadence is plenty).
const MAX_SAMPLES = 200;

export function baselineStateFile() {
  return process.env.BTC_TSMOM_EQUITY_BASELINE
    ? path.resolve(process.env.BTC_TSMOM_EQUITY_BASELINE)
    : path.resolve(__dirname, "data", "btc-equity-baseline-v3-btc-long.json");
}

function coldStore() {
  return { version: "v3-btc-long", created_at: new Date().toISOString(), samples: [] };
}

export function loadStore() {
  const f = baselineStateFile();
  if (!fs.existsSync(f)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!s || !Array.isArray(s.samples)) return null;
    return s;
  } catch {
    return null; // corrupt => treat as no store; never crash the money path
  }
}

function saveStore(store) {
  const f = baselineStateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(store, null, 2));
  return f;
}

/**
 * Append one equity sample. FAIL-CLOSED on a non-finite equity: we REFUSE to record
 * a bogus snapshot (a fabricated 0 baseline would let the circuit under-measure a
 * real drawdown). Returns { ok, file, samples } or { ok:false, reason }.
 */
export function recordEquitySnapshot(equityUsd, now = new Date()) {
  const eq = Number(equityUsd);
  if (!Number.isFinite(eq) || eq < 0) {
    return { ok: false, reason: "non_finite_equity_refused" };
  }
  const store = loadStore() || coldStore();
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  store.samples.push({ at, equityUsd: +eq.toFixed(6) });
  // Trim oldest beyond MAX_SAMPLES (keep the tail).
  if (store.samples.length > MAX_SAMPLES) {
    store.samples = store.samples.slice(store.samples.length - MAX_SAMPLES);
  }
  store.last_record_at = at;
  const file = saveStore(store);
  return { ok: true, file, samples: store.samples.length };
}

/**
 * PURE baseline selection over a sample array. Returns { equityUsd, age_hours,
 * reason }. equityUsd is null (=> caller fail-closes to HALT) when no sample is a
 * trustworthy ~24h anchor.
 *
 * Selection: among samples whose age is within [MIN_BASELINE_AGE_HOURS,
 * MAX_BASELINE_AGE_HOURS], pick the one whose age is CLOSEST to WINDOW_HOURS (24h).
 * If none qualify, null.
 *
 *   - No samples at all                 → null (cold start, HALT).
 *   - Oldest sample younger than MIN     → null (no true 24h reference yet, HALT).
 *   - Newest qualifying sample older than MAX (store gone stale / runner stopped)
 *     with nothing in-window               → null (stale, HALT — never trust an old mark).
 */
export function selectBaseline(samples, now = new Date()) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { equityUsd: null, age_hours: null, reason: "no_samples_fail_closed" };
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  let best = null;
  let bestDist = Infinity;
  let sawAnyAged = false;
  for (const s of samples) {
    const eq = Number(s.equityUsd);
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(eq) || eq <= 0 || !Number.isFinite(t)) continue;
    const ageH = (nowMs - t) / 3600000;
    if (ageH < 0) continue; // future-dated sample — ignore
    if (ageH >= MIN_BASELINE_AGE_HOURS) sawAnyAged = true;
    if (ageH < MIN_BASELINE_AGE_HOURS || ageH > MAX_BASELINE_AGE_HOURS) continue;
    const dist = Math.abs(ageH - WINDOW_HOURS);
    if (dist < bestDist) {
      bestDist = dist;
      best = { equityUsd: +eq.toFixed(6), age_hours: +ageH.toFixed(3) };
    }
  }
  if (best) return { ...best, reason: null };
  return {
    equityUsd: null,
    age_hours: null,
    reason: sawAnyAged ? "baseline_stale_out_of_window_fail_closed" : "baseline_too_young_fail_closed",
  };
}

/** Load store + select. Convenience wrapper used by the executor/runner. */
export function resolveBaselineEquity(now = new Date(), store = undefined) {
  const s = store !== undefined ? store : loadStore();
  if (!s) return { equityUsd: null, age_hours: null, reason: "no_store_fail_closed" };
  return selectBaseline(s.samples, now);
}
