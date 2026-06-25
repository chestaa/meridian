// journal-stats.js — Lyra's honest measurement engine (BUILD v1).
//
// The statistical-honesty layer. Reuses the exact logic from the 2026-06-24
// audit that stopped Bro from scaling on a FALSE positive-edge read:
//
//   * Payoff ratio > 1 is NOT positive edge.
//   * Edge = EXPECTANCY = WR*avgWin - (1-WR)*|avgLoss| (per-trade EV).
//   * Break-even WR at payoff P = 1/(1+P). Beating payoff means nothing if WR
//     is below break-even. (At payoff 1.155 break-even WR is 46.4%; live WR
//     was 31% => EV NEGATIVE despite payoff > 1.)
//   * t-stat = mean / (sd/sqrt(n)). |t| < 2 => NOT distinguishable from
//     breakeven => result is NOISE, do not call it edge.
//
// Pure arithmetic. No I/O, no money path. See [[edge-payoff-vs-expectancy-trap]].

import { effectiveEntries } from "./journal.js";

const NOISE_T_THRESHOLD = 2; // |t| below this => statistically indistinguishable
// Minimum sample size before ANY edge verdict. A tiny sample with low variance
// can produce a huge |t| (e.g. 4 wins in a row => t=12) yet tell us nothing
// durable — variance is under-sampled and one regime can flatter a config.
// Below this n we cap the verdict at THIN regardless of t. (Audit discipline:
// the live ledger needed n in the dozens before any read was trustworthy.)
const MIN_EDGE_N = 10;

// Pull the comparable numeric outcome from an entry. ONLY closed entries with
// a realized money outcome (or an explicitly chosen proxy unit) are countable.
// We refuse to mix units silently — a group is measured in ONE unit.
function outcomeValue(entry) {
  if (entry.status !== "closed") return null;
  if (!entry.outcome) return null;
  return entry.outcome.value; // may be null (honest: no number recorded)
}

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Sample standard deviation (n-1). Returns 0 for n<2.
function sampleSd(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

// Core honest stats over an array of realized numeric outcomes.
// `unit` is carried through for display so we never report a unitless number.
export function computeStats(values, unit = "unit") {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;

  const wins = xs.filter((v) => v > 0);
  const losses = xs.filter((v) => v < 0);
  const breakeven = xs.filter((v) => v === 0);

  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0; // negative number
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;
  // Break-even WR at this payoff. null payoff (no losses yet) => undefined.
  const breakEvenWr = payoff != null ? 1 / (1 + payoff) : null;

  const expectancy = mean(xs); // per-trade EV in `unit`
  const sd = sampleSd(xs);
  // t-stat for H0: expectancy == 0.
  const tStat = n >= 2 && sd > 0 ? expectancy / (sd / Math.sqrt(n)) : null;

  // HONESTY FLAG. This is the whole point.
  let verdict, honesty;
  if (n < 2) {
    verdict = "INSUFFICIENT";
    honesty = `n=${n}: not enough samples to measure anything.`;
  } else if (n < MIN_EDGE_N) {
    // tiny sample: even a huge |t| is untrustworthy (variance under-sampled).
    verdict = "THIN";
    honesty = `n=${n} < ${MIN_EDGE_N}: sample too thin for an edge verdict even if |t| looks strong (one regime can flatter a config). Direction so far: expectancy ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(6)} ${unit}, but treat as UNPROVEN. Keep logging.`;
  } else if (tStat == null || Math.abs(tStat) < NOISE_T_THRESHOLD) {
    verdict = "NOISE";
    honesty = `|t|=${tStat == null ? "n/a" : Math.abs(tStat).toFixed(2)} < ${NOISE_T_THRESHOLD}: result is NOT statistically distinguishable from breakeven. Do NOT call this edge (either direction).`;
  } else if (tStat >= NOISE_T_THRESHOLD) {
    verdict = "EDGE_POSITIVE";
    honesty = `|t|=${tStat.toFixed(2)} >= ${NOISE_T_THRESHOLD} and expectancy > 0: statistically supported positive edge at n=${n}.`;
  } else {
    verdict = "EDGE_NEGATIVE";
    honesty = `|t|=${Math.abs(tStat).toFixed(2)} >= ${NOISE_T_THRESHOLD} and expectancy < 0: statistically supported NEGATIVE edge (losing) at n=${n}.`;
  }

  // Secondary honesty check: payoff>1 but WR below break-even => the payoff
  // trap. Surface it explicitly even when verdict is NOISE.
  let payoffTrap = null;
  if (payoff != null && payoff > 1 && breakEvenWr != null && winRate < breakEvenWr) {
    payoffTrap = `payoff ${payoff.toFixed(3)} > 1 looks good but WR ${(winRate * 100).toFixed(1)}% < break-even WR ${(breakEvenWr * 100).toFixed(1)}% => expectancy is NEGATIVE. Payoff is NOT edge.`;
  }

  return {
    n,
    unit,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRatePct: +(winRate * 100).toFixed(2),
    avgWin: +avgWin.toFixed(6),
    avgLoss: +avgLoss.toFixed(6),
    payoff: payoff == null ? null : +payoff.toFixed(4),
    breakEvenWrPct: breakEvenWr == null ? null : +(breakEvenWr * 100).toFixed(2),
    expectancy: +expectancy.toFixed(6),
    sd: +sd.toFixed(6),
    tStat: tStat == null ? null : +tStat.toFixed(3),
    net: +xs.reduce((a, b) => a + b, 0).toFixed(6),
    verdict,
    honesty,
    payoffTrap,
  };
}

// Group effective entries by experiment_id (+ config_version) and report each.
// We REFUSE to aggregate across mixed outcome units — if an experiment mixes
// SOL and USD outcomes we split by unit and flag it, never silently sum.
export function reportByExperiment(entries) {
  const eff = effectiveEntries(entries);
  const closed = eff.filter((e) => e.status === "closed" && e.outcome);

  // key = experiment_id :: config_version :: unit
  const groups = new Map();
  for (const e of closed) {
    const v = e.outcome.value;
    if (!Number.isFinite(v)) continue; // honest: no number => not countable
    const unit = e.outcome.unit || "proxy";
    const key = `${e.experiment_id}::${e.config_version}::${unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ value: v, is_realized: e.outcome.is_realized });
  }

  const reports = [];
  for (const [key, rows] of groups) {
    const [experiment_id, config_version, unit] = key.split("::");
    const stats = computeStats(rows.map((r) => r.value), unit);
    const realizedCount = rows.filter((r) => r.is_realized).length;
    reports.push({
      experiment_id,
      config_version,
      unit,
      // proxy/unrealized honesty: how many of these are ACTUAL money?
      realized_of_total: `${realizedCount}/${rows.length}`,
      is_realized_money: unit === "SOL" || unit === "USD",
      ...stats,
    });
  }

  // also count entries we COULDN'T measure (open, void, null outcome) for honesty
  const openCount = eff.filter((e) => e.status === "open").length;
  const voidCount = eff.filter((e) => e.status === "void").length;
  const unmeasurable = closed.filter(
    (e) => !Number.isFinite(e.outcome?.value)
  ).length;

  return {
    reports: reports.sort((a, b) =>
      a.experiment_id === b.experiment_id
        ? a.config_version.localeCompare(b.config_version)
        : a.experiment_id.localeCompare(b.experiment_id)
    ),
    coverage: {
      total_effective: eff.length,
      closed_measured: closed.filter((e) => Number.isFinite(e.outcome?.value))
        .length,
      closed_unmeasurable: unmeasurable,
      open: openCount,
      void: voidCount,
    },
  };
}

// Compare two experiment/config groups head-to-head (A vs B). This is the
// "config A vs config B" feature the missing stamp blocked. Honest: if EITHER
// side is NOISE/INSUFFICIENT, the comparison is flagged inconclusive.
export function compareGroups(entries, keyA, keyB) {
  const { reports } = reportByExperiment(entries);
  const find = (k) =>
    reports.find(
      (r) =>
        `${r.experiment_id}::${r.config_version}::${r.unit}` === k ||
        `${r.experiment_id}::${r.config_version}` ===
          k.split("::").slice(0, 2).join("::")
    );
  const a = find(keyA);
  const b = find(keyB);
  if (!a || !b) {
    return { ok: false, reason: `group not found: ${!a ? keyA : keyB}` };
  }
  if (a.unit !== b.unit) {
    return {
      ok: false,
      reason: `unit mismatch: ${a.unit} vs ${b.unit} — cannot compare across units`,
    };
  }
  const inconclusive =
    ["NOISE", "INSUFFICIENT", "THIN"].includes(a.verdict) ||
    ["NOISE", "INSUFFICIENT", "THIN"].includes(b.verdict);
  return {
    ok: true,
    a,
    b,
    expectancy_delta: +(a.expectancy - b.expectancy).toFixed(6),
    inconclusive,
    note: inconclusive
      ? `At least one side is NOISE/INSUFFICIENT — the difference is NOT trustworthy yet. Collect more samples before declaring a winner.`
      : `Both sides statistically resolved; expectancy delta is meaningful.`,
  };
}

export { NOISE_T_THRESHOLD };
