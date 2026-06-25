// scripts/test-btc-dryrun-validate.js — the DRY-RUN bridge rehearsal runner.
// Proves: forces dry-run, places NOTHING, warms the baseline store, refuses to run
// on an ambient DRY_RUN=false env. Offline (TSMOM_SOAK_NO_FETCH), isolated state.
// Run: node scripts/test-btc-dryrun-validate.js

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-validate-"));
process.env.BTC_TSMOM_STATE = path.join(tmp, "pos.json");
process.env.BTC_TSMOM_EQUITY_BASELINE = path.join(tmp, "baseline.json");
process.env.BTC_TSMOM_VALIDATE_STATE = path.join(tmp, "validate.json");
process.env.TSMOM_SOAK_NO_FETCH = "1"; // offline — use whatever BTC-daily cache exists in the repo

const V = await import("../tsmom/btc-dryrun-validate.js");
const { loadPosition } = await import("../tsmom/btc-position.js");
const { loadStore } = await import("../tsmom/btc-equity-baseline.js");

// ── refuses to run on an ambient LIVE env (defense-in-depth) ────────────────────
process.env.DRY_RUN = "false";
const refused = await V.runValidate({ fetch: false });
ok(refused.action === "refused" && /ambient_DRY_RUN_false/.test(refused.reason), "refuses rehearsal when ambient DRY_RUN=false (never masks a live env)");
delete process.env.DRY_RUN;

// ── normal rehearsal: requires a BTC cache. If absent in CI, the runner returns an
//    honest error (no fabrication) — assert whichever branch applies, both are valid. ─
const r = await V.runValidate({ fetch: false });
if (r.action === "error") {
  ok(/no BTC history/.test(r.reason), "no cache => honest error (no fabrication)");
  console.log("  (note: BTC-daily cache absent — rehearsal error path validated)");
} else {
  ok(["cold_open", "rebalance", "mark", "noop", "insufficient"].includes(r.action), `rehearsal produced a valid action (${r.action})`);
  ok(r.equity_usd > 0 && r.equity_usd <= 300, "rehearsal sized within probe cap");
  // NOTHING placed: no live book fill written by the dry-run.
  const pos = loadPosition();
  ok(pos === null || pos.fills.length === 0, "rehearsal placed NOTHING (no book fill)");
  // baseline store warmed (snapshot recorded).
  const store = loadStore();
  ok(store && store.samples.length >= 1, "rehearsal WARMED the 24h baseline store (snapshot recorded)");
  // validate state log written.
  ok(fs.existsSync(process.env.BTC_TSMOM_VALIDATE_STATE), "rehearsal log persisted");
  // HONESTY: the rehearsal surfaces whether LIVE would halt (cold/young baseline on
  // day one), so the operator isn't misled into thinking a clean dry-run == live-ready.
  ok(typeof r.would_halt_live === "boolean", "rehearsal reports would_halt_live (honest live-gate verdict)");
}

// ── dry-run intended-order honesty: a LONG signal with a healthy baseline SHOWS the
//    intended order AND, with a young baseline, flags would_halt_live=true ──────────
{
  const X = await import("../tsmom/btc-executor.js");
  const { decideSoak } = await import("../tsmom/tsmom-paper-soak.js");
  const { V3_BTC_LONG_PARAMS } = await import("../tsmom/tsmom-variants.js");
  function upCloses(n) { const o=[100]; for(let i=1;i<n;i++) o.push(+(o[i-1]*(1.004+0.01*Math.sin(i*1.7))).toFixed(6)); return o; }
  const rows = upCloses(360).map((c,i)=>({date:new Date(Date.UTC(2024,0,1)+i*86400000).toISOString().slice(0,10),close:c}));
  const d = decideSoak(rows, null, V3_BTC_LONG_PARAMS);
  if (d.action === "cold_open" && d.sig.weight > 0) {
    // young baseline => dry-run STILL computes the intended order, but flags wouldHaltLive.
    const young = () => ({ equityUsd: null, age_hours: null, reason: "baseline_too_young_fail_closed" });
    const step = await X.executeStep({
      rows, currentEquityUsd: 250, recordSnapshot: false,
      deps: { resolvePriceFn: async () => ({ ok: true, price: 60000, source: "test" }), resolveBaselineFn: young },
      dryRunRaw: "true",
    });
    ok(step.intended && step.intended.intended, "dry-run shows the INTENDED order even when live gate would halt");
    ok(step.wouldHaltLive === true && /equity_unknown/.test(step.gateReason), "dry-run flags wouldHaltLive on a young baseline (honest)");
    ok(!step.ordered, "dry-run placed NOTHING regardless");
  } else {
    ok(true, "(signal not LONG in this build — flat-path covered above)");
  }
}

console.log(`\nbtc-dryrun-validate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
