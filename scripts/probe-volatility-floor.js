// Cassiopeia 👁️ — one-shot volatility-floor anti-dormancy probe (NOT production).
// Pulls the broad discovery set exactly as discoverPools() does, runs the REAL
// exported gate fn, and answers: how many pools survive the CURRENT gate, and how
// many ALSO clear a volatility floor of 3.0 / 3.5. Evidence for minVolatility.
// Read-only. Mirrors scripts/probe-reject-histogram.js.
import { config } from "../config.js";
import {
  buildDiscoveryFilters,
  effectiveScreeningThresholds,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

const BASE = "https://pool-discovery-api.datapi.meteora.ag";

async function main() {
  const s = effectiveScreeningThresholds();
  console.log("dryRun =", config.dryRun);
  console.log("Effective gate values (vol-relevant):");
  for (const k of ["minMcap","maxMcap","minTvl","maxTvl","minFeeActiveTvlRatio","minVolatility"]) {
    console.log("  ", k, "=", s[k]);
  }

  const filters = buildDiscoveryFilters(s);
  const pageSize = Number(s.broadDiscoveryPageSize ?? 1000);
  const sortBy = s.broadSortBy || "fee_active_tvl_ratio:desc";
  const url = `${BASE}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(filters)}&timeframe=${s.timeframe}&category=${s.category}&sort_by=${encodeURIComponent(sortBy)}`;
  const res = await fetch(url);
  const data = await res.json();
  const pools = Array.isArray(data.data) ? data.data : [];
  console.log(`\nServer total=${data.total}  |  broad page returned=${pools.length} raw pools\n`);

  // Pools that pass the CURRENT gate (minVolatility ignored here — we measure the
  // vol distribution of the ALREADY-deployable set, then overlay candidate floors).
  const sNoVolFloor = { ...s, minVolatility: 0 };
  const survivors = [];
  for (const p of pools) {
    if (getRawPoolScreeningRejectReason(p, sNoVolFloor) === null) survivors.push(p);
  }
  console.log(`Survivors of current gate (NO vol floor): ${survivors.length}`);

  const volOf = (p) => Number(p?.volatility);
  const stat = (vals) => {
    const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return "n/a";
    const q = (pp) => v[Math.min(v.length - 1, Math.floor(pp * v.length))];
    return `n=${v.length} min=${v[0]} p10=${q(0.1)} p25=${q(0.25)} med=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${v[v.length-1]}`;
  };
  console.log("\n=== volatility distribution ===");
  console.log("  WHOLE broad set :", stat(pools.map(volOf)));
  console.log("  CURRENT survivors:", stat(survivors.map(volOf)));

  // How many survivors ALSO clear a volatility floor.
  const floorPass = (set, floor) => set.filter((p) => Number.isFinite(volOf(p)) && volOf(p) >= floor).length;
  const floorMissing = (set) => set.filter((p) => !Number.isFinite(volOf(p)) || volOf(p) == null).length;
  console.log("\n=== survivors AFTER adding volatility floor (combined with all current gates) ===");
  for (const floor of [3.0, 3.5, 4.0]) {
    console.log(`  vol >= ${floor.toFixed(1)} : ${floorPass(survivors, floor)} pools`);
  }
  console.log(`  survivors with MISSING/non-finite vol (would reject fail-safe): ${floorMissing(survivors)}`);

  // Vol buckets of survivors (mirror Lyra's trade buckets) so we see WHERE the
  // deployable mass sits relative to the bleed/profit boundary at 3.5.
  const buckets = [[0,2.5],[2.5,3.5],[3.5,4.5],[4.5,Infinity]];
  console.log("\n=== survivor vol buckets (Lyra alignment) ===");
  for (const [lo, hi] of buckets) {
    const n = survivors.filter((p) => { const v = volOf(p); return Number.isFinite(v) && v >= lo && v < hi; }).length;
    console.log(`  [${lo}, ${hi === Infinity ? "+" : hi}) : ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
