// journal.js — Lyra's market-AGNOSTIC trade/experiment journal (BUILD v1).
//
// WHY THIS EXISTS
// ---------------
// We halted the DLMM live loop flying blind: 53 trades that COULDN'T be sliced
// because lessons.json never stamped a config-version. We "improved" without
// proof. This module is the discipline we lacked: every idea is a logged
// HYPOTHESIS with a measurable outcome, tagged by experiment so config A vs
// config B compares cleanly, and a stats layer that flags noise as noise.
//
// DESIGN PRINCIPLES (Lyra's audit code):
//   1. APPEND-ONLY JSONL. History is sacred. We never mutate a closed entry;
//      a correction is a NEW entry referencing the old (corrects field).
//   2. experiment_id + config_version are FIRST-CLASS top-level fields. The
//      single most important feature — the slice key that was missing.
//   3. OUTCOME HONESTY. Every outcome carries an explicit `unit` (SOL/USD/R/
//      proxy/pct). We NEVER conflate a realized-money number with a proxy.
//      (The "PnL != SOL" trap that cost us a real audit.)
//   4. FAIL-CLOSED stats. n too small / |t| < 2 => result flagged NOISE, never
//      reported as edge. Payoff > 1 is NOT edge; we compute break-even WR.
//   5. MARKET AGNOSTIC. No Solana/DLMM coupling. `market` + `asset` are free
//      strings. Works for Solana LP, spot, manual trades, anything.
//
// NO money path. NO LLM cost. Pure local journaling + arithmetic.

import fs from "fs";
import path from "path";

// Resolved at CALL TIME (not module load) so JOURNAL_FILE env overrides and
// test isolation work without import cache-busting.
function journalFile() {
  return process.env.JOURNAL_FILE
    ? path.resolve(process.env.JOURNAL_FILE)
    : path.resolve(process.cwd(), "journal.jsonl");
}

// Outcome units we recognize. "proxy" is the honesty escape hatch: a number
// that is NOT realized money (e.g. unrealized peak, simulated, fee estimate).
export const OUTCOME_UNITS = ["SOL", "USD", "R", "pct", "proxy"];

// ── helpers ─────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function strictNumeric(v) {
  // null/undefined/NaN/Infinity => null. NEVER coerce null->0 (that fabricates
  // a real zero and is exactly how the -100% SOL row got booked). Empty string
  // and non-numeric strings => null.
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clip(v, maxLen) {
  if (v == null) return null;
  return String(v).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── entry normalization ─────────────────────────────────────────────
// An entry is a single trade/experiment observation. Required discipline:
// you MUST name the hypothesis (what edge, why) and tag the experiment.
//
// status:  "open"   — entered, not yet resolved (no outcome yet)
//          "closed" — resolved, outcome present
//          "void"   — abandoned / never executed (kept for honesty)
export function normalizeEntry(raw = {}) {
  const status = ["open", "closed", "void"].includes(raw.status)
    ? raw.status
    : raw.outcome != null || raw.exit != null
    ? "closed"
    : "open";

  // Outcome: honest unit-tagged realized result. value is the number; unit
  // says what it MEANS. is_realized=false => it's a proxy/estimate, NOT money.
  let outcome = null;
  if (raw.outcome && typeof raw.outcome === "object") {
    const unit = OUTCOME_UNITS.includes(raw.outcome.unit) ? raw.outcome.unit : "proxy";
    const value = strictNumeric(raw.outcome.value);
    outcome = {
      value, // null is allowed and HONEST — "we don't have a realized number"
      unit,
      // realized money only if explicitly a money unit AND flagged realized.
      is_realized:
        raw.outcome.is_realized === true && (unit === "SOL" || unit === "USD"),
      note: clip(raw.outcome.note, 280),
    };
  }

  return {
    id: raw.id || genId("je"),
    ts: raw.ts || nowIso(),
    // ── slice keys (FIRST-CLASS) ──
    experiment_id: clip(raw.experiment_id, 80) || "default",
    config_version: clip(raw.config_version, 80) || "v0",
    // ── market-agnostic identity ──
    market: clip(raw.market, 60) || "unspecified",
    asset: clip(raw.asset, 80) || null,
    // ── the discipline: hypothesis is REQUIRED to be meaningful ──
    hypothesis: clip(raw.hypothesis, 600), // what edge am I betting on + WHY
    setup: raw.setup && typeof raw.setup === "object" ? raw.setup : {}, // config snapshot
    // ── trade mechanics (all optional, market-agnostic) ──
    entry: raw.entry && typeof raw.entry === "object" ? raw.entry : null,
    exit: raw.exit && typeof raw.exit === "object" ? raw.exit : null,
    // ── status + honest outcome ──
    status,
    outcome,
    // ── learning ──
    lesson: clip(raw.lesson, 600), // post-mortem: what did this TEACH us
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => clip(t, 40)).filter(Boolean).slice(0, 12)
      : [],
    corrects: clip(raw.corrects, 80) || null, // id of entry this supersedes
  };
}

// ── append-only write ───────────────────────────────────────────────
export function appendEntry(raw) {
  const entry = normalizeEntry(raw);
  fs.appendFileSync(journalFile(), JSON.stringify(entry) + "\n");
  return entry;
}

// ── read ────────────────────────────────────────────────────────────
export function readEntries(file = journalFile()) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip corrupt line, never crash a report on one bad row
    }
  }
  return out;
}

// Apply `corrects` supersession: if entry B corrects A, A is dropped from the
// effective set (its correction stands). History on disk is untouched.
export function effectiveEntries(entries) {
  const superseded = new Set(
    entries.map((e) => e.corrects).filter(Boolean)
  );
  return entries.filter((e) => !superseded.has(e.id));
}

export { journalFile };
