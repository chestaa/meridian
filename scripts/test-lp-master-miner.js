// Sirius 🐺 — LP-Master miner tests (roadmap step 4, DATA-MOAT).
//
// Verifies the buildRecords() trust-tier logic WITHOUT any RPC / LPAgent call:
//   - schema compliance: every record matches addSmartWallet() shape
//     ({name,address,category,type}) + a _provenance block.
//   - anti-fabrication (anti-pattern #2 + no-fabrication feedback): recurring
//     (on-chain-only) records carry win_rate=null / roi=null — NEVER invented PnL.
//   - lp_master records carry the REAL LPAgent PnL passed in (not zeroed/invented).
//   - dedup: never re-adds a known address; never emits the same address twice.
//   - minPositions floor: recurring wallets below the floor are dropped;
//     lp_masters BYPASS the floor (PnL evidence outranks recurrence count).
//   - only positive-evidence masters become lp_master (no-evidence ones drop out
//     of the master tier — and if also recurring-eligible, fall to recurring).
//   - cap respected.
//   - addSmartWallet() accepts the emitted record shape (real integration check).
//
// Run: node scripts/test-lp-master-miner.js
import assert from "node:assert/strict";
import { buildRecords, isPlausibleMasterEvidence, ROI_CEIL, SOLANA_PUBKEY_RE } from "./lp-master-miner.js";
import { addSmartWallet, listSmartWallets, removeSmartWallet } from "../smart-wallets.js";

let pass = 0;
function check(label, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    process.exitCode = 1;
  }
}

// Real-format Solana pubkeys (base58, valid length) — NOT fabricated identities,
// just valid-shaped test addresses for the pure logic.
const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const C = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const D = "So11111111111111111111111111111111111111112";
const KNOWN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function tallyOf(entries) {
  // entries: [address, poolCount, positionCount, poolName]
  const m = new Map();
  for (const [address, poolCount, positionCount, poolName] of entries) {
    const pools = new Set();
    for (let i = 0; i < poolCount; i++) pools.add(`pool${i}_${address.slice(0, 4)}`);
    m.set(address, { count: positionCount, pools, firstPool: { name: poolName || "POOLX" } });
  }
  return m;
}
function mastersOf(entries) {
  // entries: [address, win_rate, roi, total_pnl_usd, poolName]
  const m = new Map();
  for (const [address, win_rate, roi, total_pnl_usd, poolName] of entries) {
    m.set(address, { address, win_rate, roi, total_pnl_usd, avg_hold_hours: 3, strategy: "spot", poolName: poolName || "POOLX" });
  }
  return m;
}

console.log("LP-Master miner — buildRecords trust tiers + anti-fabrication\n");

// ── 1. schema compliance for both tiers ──────────────────────────────────────
{
  const recs = buildRecords({
    tally: tallyOf([[B, 3, 5, "TOKB"]]),
    lpMasters: mastersOf([[A, 0.7, 0.42, 1234, "TOKA"]]),
    knownAddrs: new Set(),
  });
  check("emits 2 records (1 master + 1 recurring)", recs.length === 2);
  for (const r of recs) {
    check(`record ${r.address.slice(0, 4)} has name`, typeof r.name === "string" && r.name.length > 0);
    check(`record ${r.address.slice(0, 4)} address valid base58`, SOLANA_PUBKEY_RE.test(r.address));
    check(`record ${r.address.slice(0, 4)} category=alpha`, r.category === "alpha");
    check(`record ${r.address.slice(0, 4)} type=lp`, r.type === "lp");
    check(`record ${r.address.slice(0, 4)} has _provenance`, r._provenance && typeof r._provenance === "object");
  }
}

// ── 2. anti-fabrication: recurring tier has NULL PnL ──────────────────────────
{
  const recs = buildRecords({
    tally: tallyOf([[B, 4, 9, "TOKB"]]),
    lpMasters: new Map(),
    knownAddrs: new Set(),
  });
  const r = recs[0];
  check("recurring trust_tier", r._provenance.trust_tier === "recurring");
  check("recurring win_rate is null (no fabricated PnL)", r._provenance.win_rate === null);
  check("recurring roi is null (no fabricated PnL)", r._provenance.roi === null);
  check("recurring source is on-chain", r._provenance.source === "onchain_getProgramAccounts");
  check("recurring notes disclose no-PnL", /NO realized-PnL/.test(r._provenance.notes));
}

// ── 3. lp_master carries REAL passed-in PnL (not zeroed/invented) ─────────────
{
  const recs = buildRecords({
    tally: new Map(),
    lpMasters: mastersOf([[A, 0.81, 0.55, 9999, "TOKA"]]),
    knownAddrs: new Set(),
  });
  const r = recs[0];
  check("lp_master trust_tier", r._provenance.trust_tier === "lp_master");
  check("lp_master win_rate preserved", r._provenance.win_rate === 0.81);
  check("lp_master roi preserved", r._provenance.roi === 0.55);
  check("lp_master total_pnl_usd preserved", r._provenance.total_pnl_usd === 9999);
  check("lp_master source is lpagent", r._provenance.source === "lpagent_top_lper");
}

// ── 4. dedup vs known addresses ───────────────────────────────────────────────
{
  const recs = buildRecords({
    tally: tallyOf([[KNOWN, 5, 5, "TOKK"], [B, 3, 3, "TOKB"]]),
    lpMasters: mastersOf([[KNOWN, 0.9, 0.9, 100, "TOKK"]]),
    knownAddrs: new Set([KNOWN]),
  });
  check("known address never re-added (any tier)", recs.every((r) => r.address !== KNOWN));
  check("non-known recurring still added", recs.some((r) => r.address === B));
}

// ── 5. no address emitted twice (master + recurring overlap → master wins) ────
{
  const recs = buildRecords({
    tally: tallyOf([[A, 3, 7, "TOKA"]]), // A is also recurring-eligible
    lpMasters: mastersOf([[A, 0.6, 0.3, 50, "TOKA"]]),
    knownAddrs: new Set(),
  });
  const occurrences = recs.filter((r) => r.address === A).length;
  check("overlapping address emitted exactly once", occurrences === 1);
  check("overlap resolves to lp_master tier (PnL outranks)", recs.find((r) => r.address === A)._provenance.trust_tier === "lp_master");
  check("lp_master cross-references on-chain recurrence", recs.find((r) => r.address === A)._provenance.onchain_pools_seen_in === 3);
}

// ── 6. minPositions floor: recurring below floor dropped, master bypasses ─────
{
  const recs = buildRecords({
    tally: tallyOf([[B, 1, 1, "TOKB"]]),          // poolCount=1 < floor 2
    lpMasters: mastersOf([[A, 0.5, 0.2, 120, "TOKA"]]), // master, no recurrence at all
    knownAddrs: new Set(),
    minPositions: 2,
  });
  check("recurring below minPositions dropped", recs.every((r) => r.address !== B));
  check("lp_master bypasses minPositions floor", recs.some((r) => r.address === A && r._provenance.trust_tier === "lp_master"));
}

// ── 7. only PLAUSIBLE-evidence masters become lp_master ───────────────────────
{
  const recs = buildRecords({
    tally: new Map(),
    lpMasters: mastersOf([[A, 0, 0, 0, "TOKA"]]), // zero evidence
    knownAddrs: new Set(),
  });
  check("zero-evidence master is NOT written as lp_master", recs.every((r) => r._provenance.trust_tier !== "lp_master"));
  check("zero-evidence + no recurrence → nothing written", recs.length === 0);
}
{
  // zero-evidence master that IS recurring-eligible falls to recurring tier
  const recs = buildRecords({
    tally: tallyOf([[A, 3, 4, "TOKA"]]),
    lpMasters: mastersOf([[A, 0, 0, 0, "TOKA"]]),
    knownAddrs: new Set(),
  });
  check("zero-evidence master that is recurring → recurring tier (honest downgrade)", recs.length === 1 && recs[0]._provenance.trust_tier === "recurring");
  check("downgraded record has null PnL (no fabrication)", recs[0]._provenance.win_rate === null);
}

// ── 7b. PnL plausibility gate — reject broken/extreme LPAgent feed values ─────
{
  // Live-observed garbage: roi in the millions with winrate 0. MUST be rejected.
  check("broken feed (roi=58M%, wr=0) rejected as master evidence", isPlausibleMasterEvidence({ win_rate: 0, roi: 584654, total_pnl_usd: 9927 }) === false);
  check("winrate=0 rejected even with bounded roi", isPlausibleMasterEvidence({ win_rate: 0, roi: 0.5, total_pnl_usd: 500 }) === false);
  check("winrate>1 rejected (impossible)", isPlausibleMasterEvidence({ win_rate: 1.4, roi: 0.5, total_pnl_usd: 500 }) === false);
  check("roi above ceiling rejected", isPlausibleMasterEvidence({ win_rate: 0.6, roi: ROI_CEIL + 1, total_pnl_usd: 500 }) === false);
  check("dust PnL (<=$20) rejected (kills ROI artifacts)", isPlausibleMasterEvidence({ win_rate: 0.6, roi: 0.5, total_pnl_usd: 5 }) === false);
  check("plausible evidence accepted", isPlausibleMasterEvidence({ win_rate: 0.6, roi: 0.42, total_pnl_usd: 500 }) === true);
  check("NaN/garbage rejected (fail-safe)", isPlausibleMasterEvidence({ win_rate: NaN, roi: NaN, total_pnl_usd: NaN }) === false);
}
{
  // The exact live broken record must NOT be written as lp_master; with no
  // on-chain recurrence it must produce ZERO records (no fabricated alpha).
  const recs = buildRecords({
    tally: new Map(),
    lpMasters: mastersOf([[A, 0, 584654, 9927, "TOKA"]]),
    knownAddrs: new Set(),
  });
  check("live broken-feed master → NOT written (no fake alpha)", recs.length === 0);
}

// ── 8. cap respected ──────────────────────────────────────────────────────────
{
  const tally = tallyOf([[A, 3, 3, "T"], [B, 3, 3, "T"], [C, 3, 3, "T"]]);
  const recs = buildRecords({ tally, lpMasters: new Map(), knownAddrs: new Set(), cap: 2 });
  check("cap=2 limits output to 2", recs.length === 2);
}

// ── 9. addSmartWallet accepts emitted record shape (real integration) ─────────
{
  const recs = buildRecords({
    tally: new Map(),
    lpMasters: mastersOf([[D, 0.7, 0.4, 500, "TOKD"]]),
    knownAddrs: new Set(),
  });
  const r = recs[0];
  // ensure not already present from a prior run
  removeSmartWallet({ address: r.address });
  const res = addSmartWallet({ name: r.name, address: r.address, category: r.category, type: r.type });
  check("addSmartWallet accepts mined record shape", res.success === true);
  const list = listSmartWallets();
  check("wallet now listed", list.wallets.some((w) => w.address === r.address));
  // cleanup so the test is idempotent and never pollutes a real watchlist
  const cleanup = removeSmartWallet({ address: r.address });
  check("cleanup removed test wallet", cleanup.success === true);
}

console.log(`\n${pass} checks passed${process.exitCode ? " — WITH FAILURES" : ""}.`);
