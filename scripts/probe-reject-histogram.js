// Cassiopeia 👁️ — one-shot reject-histogram probe (NOT a production path).
// Pulls the broad discovery set exactly as discoverPools() does, then runs the
// REAL exported gate fns (getRawPoolScreeningRejectReason + the getTopCandidates
// secondary filters) and tallies reject reasons. No enrichment (we measure the
// RAW funnel wall, the cheap gates that bind BEFORE any API spend). Read-only.
import { config } from "../config.js";
import {
  buildDiscoveryFilters,
  effectiveScreeningThresholds,
  getRawPoolScreeningRejectReason,
} from "../tools/screening.js";

const BASE = "https://pool-discovery-api.datapi.meteora.ag";

function bucket(reason) {
  if (!reason) return null;
  // Collapse the noisy numeric reasons into stable gate families for the histogram.
  if (reason.startsWith("mcap")) return reason.includes("below") ? "mcap_below_min" : "mcap_above_max";
  if (reason === "holders_unknown") return "holders_unknown(missing)";
  if (reason.startsWith("holders ")) return "holders_below_min(real)";
  if (reason.startsWith("volume")) return "volume_below_min";
  if (reason.startsWith("TVL") && reason.includes("below")) return "tvl_below_min";
  if (reason.startsWith("TVL") && reason.includes("above")) return "tvl_above_max";
  if (reason.startsWith("bin_step") && reason.includes("below")) return "binstep_below_min";
  if (reason.startsWith("bin_step") && reason.includes("above")) return "binstep_above_max";
  if (reason.startsWith("fee/active-TVL")) return "fee_tvl_below_min";
  if (reason === "volatility_unknown") return "volatility_unknown(missing)";
  if (reason.includes("volatility") && reason.includes("unusable")) return "volatility_unusable";
  if (reason === "organic_unknown") return "organic_unknown(missing)";
  if (reason.startsWith("base organic")) return "organic_below_min(real)";
  if (reason.startsWith("quote organic")) return "quote_organic_below_min";
  if (reason.includes("token age below")) return "token_age_below_min";
  if (reason.includes("token age above")) return "token_age_above_max";
  if (reason.includes("launchpad")) return "launchpad";
  if (reason.includes("critical warnings")) return "critical_warnings";
  if (reason.includes("single ownership")) return "high_single_ownership";
  if (reason.includes("supply concentration")) return "high_supply_concentration";
  if (reason.includes("not dlmm")) return "not_dlmm";
  return reason.slice(0, 40);
}

async function main() {
  const s = effectiveScreeningThresholds();
  console.log("dryRun =", config.dryRun, "| liveOverrides active =", config.dryRun === false && !!config.liveOverrides);
  console.log("Effective gate values:");
  for (const k of ["minMcap","maxMcap","minHolders","minVolume","minTvl","maxTvl","minBinStep","maxBinStep","minFeeActiveTvlRatio","minOrganic","minQuoteOrganic","minTokenAgeHours","maxTokenAgeHours"]) {
    console.log("  ", k, "=", s[k]);
  }

  const filters = buildDiscoveryFilters(s);
  const pageSize = Number(s.broadDiscoveryPageSize ?? 1000);
  const sortBy = s.broadSortBy || "fee_active_tvl_ratio:desc";
  const url = `${BASE}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(filters)}&timeframe=${s.timeframe}&category=${s.category}&sort_by=${encodeURIComponent(sortBy)}`;
  console.log("\nBroad filter:", filters);
  const res = await fetch(url);
  const data = await res.json();
  const pools = Array.isArray(data.data) ? data.data : [];
  console.log(`\nServer total=${data.total}  |  broad page returned=${pools.length} raw pools\n`);

  // ── Primary histogram: getRawPoolScreeningRejectReason (the cheap client gate
  //    that binds BEFORE any enrichment). This is the funnel wall we're profiling.
  const hist = new Map();
  let passed = 0;
  const passExamples = [];
  // Also track "what fee/TVL & organic & holders do the REJECTED pools have" so we
  // can answer the miscalibration question (are 0.06-0.10 fee/TVL pools being cut?).
  const feeTvlOfRejected = [];   // fee/TVL of pools rejected for a NON-fee reason but in 0.05-0.10
  const organicNear = [];        // organic of pools whose ONLY fail would be organic, in 60-72 band

  for (const p of pools) {
    const reason = getRawPoolScreeningRejectReason(p, s);
    if (!reason) { passed++; if (passExamples.length < 15) passExamples.push(p.name); continue; }
    const b = bucket(reason);
    hist.set(b, (hist.get(b) || 0) + 1);
  }

  console.log("=== REJECT HISTOGRAM (raw client gate, pre-enrichment) ===");
  const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of sorted) {
    const pct = ((n / pools.length) * 100).toFixed(1);
    console.log(`  ${String(n).padStart(5)}  ${pct.padStart(5)}%   ${reason}`);
  }
  console.log(`  ${String(passed).padStart(5)}  ${((passed/pools.length)*100).toFixed(1).padStart(5)}%   *** PASSED RAW GATE ***`);
  if (passExamples.length) console.log("  passed examples:", passExamples.join(", "));

  // ── Counterfactual sweep: relax ONE calibration gate at a time, hold all else,
  //    re-count survivors. Tells us which gate is the DOMINANT binding constraint
  //    on otherwise-deployable pools (a gate is "miscalibrated-suspect" if relaxing
  //    it alone unlocks many pools that pass EVERYTHING else).
  function passWith(override) {
    const s2 = { ...s, ...override };
    let n = 0;
    for (const p of pools) if (getRawPoolScreeningRejectReason(p, s2) === null) n++;
    return n;
  }
  console.log("\n=== COUNTERFACTUAL: survivors if ONE gate relaxed (all else held) ===");
  console.log(`  baseline (current gate)............. ${passed}`);
  console.log(`  organic floor 60→40................. ${passWith({ minOrganic: 40 })}`);
  console.log(`  organic floor 60→0 (off)............ ${passWith({ minOrganic: 0 })}`);
  console.log(`  holders 500→200..................... ${passWith({ minHolders: 200 })}`);
  console.log(`  holders 500→100..................... ${passWith({ minHolders: 100 })}`);
  console.log(`  fee/TVL 0.05→0.02................... ${passWith({ minFeeActiveTvlRatio: 0.02 })}`);
  console.log(`  fee/TVL 0.05→0 (off)................ ${passWith({ minFeeActiveTvlRatio: 0 })}`);
  console.log(`  binStep 80→1, 125→500 (off)......... ${passWith({ minBinStep: 1, maxBinStep: 500 })}`);
  console.log(`  binStep max 125→200................. ${passWith({ maxBinStep: 200 })}`);
  console.log(`  binStep min 80→1.................... ${passWith({ minBinStep: 1 })}`);
  console.log(`  mcap band 150k-10M → 50k-50M........ ${passWith({ minMcap: 50000, maxMcap: 50000000 })}`);
  console.log(`  minTvl 10k→1k....................... ${passWith({ minTvl: 1000 })}`);
  console.log(`  maxTvl 150k→1M...................... ${passWith({ maxTvl: 1000000 })}`);
  console.log(`  token age min 8h→0.................. ${passWith({ minTokenAgeHours: 0 })}`);
  // Combined: the two cheapest suspected-miscalibrated relaxations together.
  console.log(`  binStep off + organic 60→40......... ${passWith({ minBinStep: 1, maxBinStep: 200, minOrganic: 40 })}`);

  // ── Distribution probes on the WHOLE broad set (independent of gate order) so we
  //    see the true population shape for the calibration gates.
  const stat = (vals) => {
    const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return "n/a";
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return `n=${v.length} min=${v[0]} p10=${q(0.1)} p25=${q(0.25)} med=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${v[v.length-1]}`;
  };
  console.log("\n=== POPULATION DISTRIBUTIONS (whole broad set) ===");
  console.log("  binStep   :", stat(pools.map((p) => Number(p?.dlmm_params?.bin_step))));
  console.log("  fee/TVL   :", stat(pools.map((p) => Number(p?.fee_active_tvl_ratio))));
  console.log("  organic   :", stat(pools.map((p) => Number(p?.token_x?.organic_score))));
  console.log("  holders   :", stat(pools.map((p) => Number(p?.base_token_holders))));
  console.log("  mcap      :", stat(pools.map((p) => Number(p?.token_x?.market_cap))));
  console.log("  tvl       :", stat(pools.map((p) => Number(p?.tvl ?? p?.active_tvl))));
  console.log("  volume    :", stat(pools.map((p) => Number(p?.volume))));

  // ── bin_step occupancy histogram (for the maxBinStep 125→200 question).
  const bsHist = new Map();
  for (const p of pools) {
    const bs = Number(p?.dlmm_params?.bin_step);
    if (!Number.isFinite(bs)) continue;
    bsHist.set(bs, (bsHist.get(bs) || 0) + 1);
  }
  console.log("\n=== bin_step occupancy (whole broad set) ===");
  for (const [bs, n] of [...bsHist.entries()].sort((a, b) => a[0] - b[0])) {
    const inBand = bs >= s.minBinStep && bs <= s.maxBinStep ? " [in 80-125]" : (bs > s.maxBinStep && bs <= 200 ? " [126-200: would unlock]" : "");
    console.log(`  bin_step ${String(bs).padStart(4)}: ${String(n).padStart(5)}${inBand}`);
  }
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(1); });
