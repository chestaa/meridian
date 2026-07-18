// Cassiopeia 👁️ — one-shot probe for the two-sided PAPER activity floor (S2 blocker #2).
// Pulls the SAME universe the two-sided paper supplement fetches (buildTwoSidedPaperSupplement
// Filters + tvl:desc), narrows to GENUINE two-sided paper candidates (both legs bluechip +
// wSOL=quote — the money-path-deployable set), and reports the volume / fee-TVL distribution.
// Then applies candidate activity floors and counts survivors. Read-only, no enrichment, no tx.
import {
  buildTwoSidedPaperSupplementFilters,
  effectiveScreeningThresholds,
  poolLegMints,
  isBluechipMintPair,
  bluechipWsolQuoteRejectReason,
  BLUECHIP_INCOME_MINTS,
} from "../tools/screening.js";

const BASE = "https://pool-discovery-api.datapi.meteora.ag";

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

async function main() {
  const s = effectiveScreeningThresholds();
  const filters = buildTwoSidedPaperSupplementFilters(s);
  const pageSize = Number(s.broadDiscoveryPageSize ?? 1000);
  const url = `${BASE}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(filters)}&timeframe=${s.timeframe}&category=${s.category}&sort_by=${encodeURIComponent("tvl:desc")}`;
  console.log("Supplement filter:", filters);
  console.log("timeframe:", s.timeframe, "| category:", s.category, "| sort: tvl:desc | page_size:", pageSize);

  const res = await fetch(url);
  const data = await res.json();
  const raw = Array.isArray(data.data) ? data.data : [];
  console.log(`\nServer total=${data.total}  |  page returned=${raw.length} raw pools\n`);

  // Genuine two-sided paper candidates: both legs bluechip AND wSOL=quote (deployable).
  const cands = raw.filter((p) => {
    const { base, quote } = poolLegMints(p);
    return isBluechipMintPair(base, quote) && bluechipWsolQuoteRejectReason(p) === null;
  });
  console.log(`Two-sided paper candidates (both-leg bluechip + wSOL=quote): ${cands.length}\n`);

  // Also count the WIDER "either leg wSOL" bluechip set (what a wSOL-as-base relax WOULD admit)
  // to quantify what the money-path guard excludes.
  const eitherWsol = raw.filter((p) => {
    const { base, quote } = poolLegMints(p);
    return isBluechipMintPair(base, quote) && (base === "So11111111111111111111111111111111111111112" || quote === "So11111111111111111111111111111111111111112");
  });
  const wsolBaseOnly = eitherWsol.filter((p) => bluechipWsolQuoteRejectReason(p) !== null);
  console.log(`(context) bluechip pairs with EITHER leg wSOL: ${eitherWsol.length}; of those wSOL-as-BASE (guard-excluded, e.g. SOL-USDC): ${wsolBaseOnly.length}\n`);

  const rows = cands.map((p) => {
    const { base, quote } = poolLegMints(p);
    return {
      name: p.pool_name || `${p.token_x?.symbol || base?.slice(0, 4)}-${p.token_y?.symbol || quote?.slice(0, 4)}`,
      base: p.token_x?.symbol || base,
      tvl: n(p.tvl ?? p.active_tvl),
      vol: n(p.volume ?? p.volume_window),
      feeTvl: n(p.fee_active_tvl_ratio),
    };
  });
  rows.sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0));
  console.log("Top candidates by 24h volume:");
  console.log("  name".padEnd(28), "tvl".padStart(14), "vol24h".padStart(14), "fee/TVL".padStart(12), "turnover%".padStart(12));
  for (const r of rows.slice(0, 25)) {
    const turnover = r.tvl && r.vol != null ? ((r.vol / r.tvl) * 100).toFixed(3) : "n/a";
    console.log(
      "  " + String(r.name).slice(0, 26).padEnd(26),
      (r.tvl == null ? "?" : `$${Math.round(r.tvl).toLocaleString()}`).padStart(14),
      (r.vol == null ? "?" : `$${Math.round(r.vol).toLocaleString()}`).padStart(14),
      (r.feeTvl == null ? "?" : r.feeTvl.toFixed(5)).padStart(12),
      String(turnover).padStart(12),
    );
  }

  // Survivor counts at candidate absolute-volume floors and fee/TVL floors.
  const volFloors = [0, 500, 1000, 2000, 5000, 10000, 25000, 50000];
  const feeTvlFloors = [0, 0.001, 0.003, 0.005, 0.01, 0.02, 0.03];
  console.log("\nSurvivors by ABSOLUTE 24h volume floor (fail-closed: missing vol = reject):");
  for (const f of volFloors) {
    const survive = rows.filter((r) => r.vol != null && r.vol >= f).length;
    console.log(`  vol >= $${f.toLocaleString().padEnd(8)} : ${survive}/${rows.length}`);
  }
  console.log("\nSurvivors by fee/TVL floor (fail-closed: missing fee/TVL = reject):");
  for (const f of feeTvlFloors) {
    const survive = rows.filter((r) => r.feeTvl != null && r.feeTvl >= f).length;
    console.log(`  fee/TVL >= ${String(f).padEnd(6)} : ${survive}/${rows.length}`);
  }
}

main().catch((e) => {
  console.error("PROBE_FAIL", e.message);
  process.exit(1);
});
