// Regression: signal-mode mcap band widening (Bro-authorized opt Y, 2026-06-11).
// Band moved 5k-80k → 50k-2M. Asserts:
//   - pools that USED to reject (>80k) now PASS the band: $200k, $900k, $1.2M
//   - maxMcap edge: $50M still rejects (above 2M ceiling)
//   - minMcap edge: $2k still rejects (below 50k floor)
//   - OTHER quality gates remain strict (top10 / bundlers hard-fail untouched by mcap)
//   - the baked-in config.js defaults are 50k / 2M (not stale 5k/80k)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { scoreParsedSignal } from "../signal-parser.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

// ---- 1. baked-in config.js DEFAULT fallbacks are the widened band ----
// NOTE: the live `config.screening` value may be overridden by user-config.json
// (the local machine still has the OLD 5k/80k there — that is the VPS edit Draco
// must apply). So we assert the SOURCE default fallbacks in config.js, which are
// what a fresh deploy / VPS-without-override uses.
const cfgSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config.js"), "utf8");
ok("config.js default signalMinMcap fallback === 50_000",
   /signalMinMcap\s*:\s*u\.signalMinMcap\s*\?\?\s*50_000/.test(cfgSrc));
ok("config.js default signalMaxMcap fallback === 2_000_000",
   /signalMaxMcap\s*:\s*u\.signalMaxMcap\s*\?\?\s*2_000_000/.test(cfgSrc));
ok("native minMcap unchanged === 150_000", config.screening.minMcap === 150_000);
ok("native maxMcap unchanged === 10_000_000", config.screening.maxMcap === 10_000_000);

// Force the widened band for behavior tests (runtime reads config, not source).
config.screening.signalMinMcap = 50_000;
config.screening.signalMaxMcap = 2_000_000;

// ---- helper: enriched signal with all OTHER gates clean, vary mcap ----
function cleanEnriched(mcap) {
  return {
    enriched: true,
    tokenAddress: "So11111111111111111111111111111111111111112",
    mcapUsd: mcap,
    enrichment: {
      mcapUsd: mcap,
      bundlersPct: 5,      // clean (< 30)
      top10Pct: 30,        // clean (< 60)
      volume24h: 288 * 500, // 5m proxy 500 ≥ 200 → score
      organicScore: 75,    // ≥ 60
      holders: 800,        // ≥ 200
      liquidityUsd: 50_000, // ≥ 10k
      riskLevel: "LOW",
    },
  };
}

// in-band score component is +20; band-miss loses it. Decision threshold 55.
function bandComponentPresent(res) {
  return !res.reasons.includes("mcap outside early signal band");
}

// ---- 2. pools that USED to reject (>80k) now sit IN-BAND ----
for (const mc of [200_000, 900_000, 1_200_000]) {
  const res = scoreParsedSignal(cleanEnriched(mc));
  ok(`$${mc.toLocaleString()} now IN-BAND (was rejected at 80k ceiling)`, bandComponentPresent(res));
  ok(`$${mc.toLocaleString()} decision=watch (clean pool passes)`, res.decision === "watch");
}

// ---- 3. minMcap floor: $2k still BELOW band (out-of-band) ----
{
  const res = scoreParsedSignal(cleanEnriched(2_000));
  ok("$2,000 out-of-band (below 50k floor)", !bandComponentPresent(res));
}

// ---- 4. above-band: $50M trips the hard late-stage reject (>50M is strict, so use 51M) ----
{
  const res = scoreParsedSignal(cleanEnriched(51_000_000));
  ok("$51M hard-rejected (late stage >50M)", res.decision === "skip" && res.score === 0);
}
// $5M and $50M: above 2M band → out-of-band (no +20). 50M is NOT >50M so not hard-capped,
// but still out-of-band → loses the band score and ranks low.
for (const mc of [5_000_000, 50_000_000]) {
  const res = scoreParsedSignal(cleanEnriched(mc));
  ok(`$${mc.toLocaleString()} out-of-band (above 2M ceiling)`, !bandComponentPresent(res));
}

// ---- 5. OTHER gates still STRICT despite mcap now in-band (no loosening) ----
{
  const s = cleanEnriched(900_000); // in-band mcap...
  s.enrichment.top10Pct = 75;       // ...but concentrated supply
  const res = scoreParsedSignal(s);
  ok("in-band mcap + top10 75% STILL hard-skips (gate not loosened)",
     res.decision === "skip" && res.score === 0 && res.reasons.some(r => r.includes("top10")));
}
{
  const s = cleanEnriched(900_000); // in-band mcap...
  s.enrichment.bundlersPct = 45;    // ...but bundled
  const res = scoreParsedSignal(s);
  ok("in-band mcap + bundlers 45% STILL hard-skips (gate not loosened)",
     res.decision === "skip" && res.score === 0 && res.reasons.some(r => r.includes("bundlers")));
}

// ---- 6. runtime override still propagates (config-driven, not hardcoded) ----
{
  const savedMin = config.screening.signalMinMcap;
  const savedMax = config.screening.signalMaxMcap;
  config.screening.signalMinMcap = 100_000;
  config.screening.signalMaxMcap = 500_000;
  const inNarrow = scoreParsedSignal(cleanEnriched(300_000));
  const outNarrow = scoreParsedSignal(cleanEnriched(900_000));
  ok("runtime override: $300k in narrowed band", bandComponentPresent(inNarrow));
  ok("runtime override: $900k out of narrowed band", !bandComponentPresent(outNarrow));
  config.screening.signalMinMcap = savedMin;
  config.screening.signalMaxMcap = savedMax;
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
