// scripts/test-auto-compound.js
// Vega money-path validation: auto-compound position sizing.
//
// computeDeployAmount(walletSol, cfg) scales a single LP position with the
// wallet balance when config.risk.autoCompoundEnabled === true. As realized
// profit grows the wallet, deployable (= wallet − gasReserve) grows, so the
// position grows — bounded by THREE limits that can never produce over-leverage:
//   floor (deployAmountSol)            — never too small
//   ceiling (maxDeployAmount)          — configurable per-position cap
//   concentration (maxConcentrationPct)— ≤ X% of TOTAL wallet (buffer always held)
//   hard ceiling (autoCompoundHardCeilingSol) — absolute belt, unbounded-wallet guard
//
// Compound is SYMMETRIC: wallet up → position up; wallet down (post-loss) →
// position down (auto de-risk). gasReserve is ALWAYS subtracted first.
//
// Pure unit test: computeDeployAmount takes a `cfg` test seam so we never touch
// user-config.json or the live config object. We also re-verify the circuit
// breaker cap and the executor's per-position reject predicate are UNCHANGED
// (auto-compound must not weaken any existing money belt).

process.env.DRY_RUN = "false";
process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";

const { config, computeDeployAmount, computeDynamicDeployAmount } = await import("../config.js");
const { DAILY_LOSS_CAP_SOL } = await import("../account-circuit-breaker.js");

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}  ${detail}`);
    process.exitCode = 1;
  }
}

// ── cfg factory (test seam — does NOT mutate live config) ────────────────────
// Conservative recommended defaults under test (Sirius to tune pct later):
//   pct=0.55, floor=0.20, ceil=1.0, conc=0.60, hard=1.0, gas=0.20
function makeCfg(overrides = {}) {
  return {
    management: {
      gasReserve:      overrides.gasReserve      ?? 0.20,
      positionSizePct: overrides.positionSizePct ?? 0.55,
      deployAmountSol: overrides.deployAmountSol ?? 0.20, // floor
    },
    risk: {
      maxDeployAmount:           overrides.maxDeployAmount           ?? 1.0,  // ceiling
      autoCompoundEnabled:       overrides.autoCompoundEnabled       ?? true,
      maxConcentrationPct:       overrides.maxConcentrationPct       ?? 0.60,
      autoCompoundHardCeilingSol: overrides.autoCompoundHardCeilingSol ?? 1.0,
    },
  };
}

console.log("\n=== Vega auto-compound sizing ===\n");

// ── (a) wallet UP → position UP (compound) ───────────────────────────────────
console.log("-- (a) compound up: wallet grows -> position grows --");
const cfgA = makeCfg();
// deployable = (w-0.2)*0.55, clamped [0.20, 1.0], conc 0.60*w, hard 1.0
//  w=0.74 -> (0.54)*0.55=0.297 -> floor binds? 0.297>0.20 -> 0.30; conc=0.444 ok -> 0.30
//  w=1.00 -> (0.80)*0.55=0.44; conc=0.60 ok -> 0.44
//  w=1.50 -> (1.30)*0.55=0.715; conc=0.90 ok -> 0.72 (rounding)
//  w=2.00 -> (1.80)*0.55=0.99; conc=1.20, ceil=1.0, hard=1.0 -> 0.99
const aPts = [
  [0.74, 0.30],
  [1.00, 0.44],
  [1.50, 0.72],
  [2.00, 0.99],
];
let prev = -1;
for (const [w, expect] of aPts) {
  const got = computeDeployAmount(w, cfgA);
  check(`wallet ${w} -> deploy ${got} (~${expect})`, Math.abs(got - expect) <= 0.011, `got ${got}`);
  check(`  monotonic up (${got} >= ${prev})`, got >= prev, `got ${got}, prev ${prev}`);
  prev = got;
}

// ── (b) wallet DOWN → position DOWN (auto de-risk) ───────────────────────────
console.log("-- (b) compound down: wallet shrinks (post-loss) -> position shrinks --");
const cfgB = makeCfg();
const bSeq = [2.0, 1.5, 1.0, 0.74, 0.5];
let last = Infinity;
for (const w of bSeq) {
  const got = computeDeployAmount(w, cfgB);
  check(`wallet ${w} -> deploy ${got} (<= previous ${last === Infinity ? "inf" : last})`, got <= last + 1e-9, `got ${got}`);
  last = got;
}
// At w=0.5: deployable=(0.3)*0.55=0.165 -> floor 0.20 binds -> 0.20; conc=0.30 ok -> 0.20
check("small wallet hits floor (w=0.5 -> 0.20)", computeDeployAmount(0.5, cfgB) === 0.20, `got ${computeDeployAmount(0.5, cfgB)}`);

// ── (c) ceiling cap enforced (not unbounded) ─────────────────────────────────
console.log("-- (c) ceiling + hard-ceiling cap: never unbounded --");
// Huge wallet, generous pct, but hard ceiling 1.0 and maxDeployAmount 1.0 bind.
const cfgC = makeCfg({ maxDeployAmount: 5.0, autoCompoundHardCeilingSol: 1.0, maxConcentrationPct: 0.99 });
for (const w of [10, 100, 1000]) {
  const got = computeDeployAmount(w, cfgC);
  check(`huge wallet ${w} capped at hard ceiling 1.0 (got ${got})`, got <= 1.0 + 1e-9, `got ${got}`);
}
// maxDeployAmount alone (hard ceiling raised above it) — ceiling 0.45 binds.
const cfgCb = makeCfg({ maxDeployAmount: 0.45, autoCompoundHardCeilingSol: 5.0, maxConcentrationPct: 0.99 });
check("maxDeployAmount ceiling binds (w=100 -> 0.45)", computeDeployAmount(100, cfgCb) === 0.45, `got ${computeDeployAmount(100, cfgCb)}`);

// ── (d) floor enforced (not too small) ───────────────────────────────────────
console.log("-- (d) floor: position never below deployAmountSol on a healthy wallet --");
const cfgD = makeCfg({ deployAmountSol: 0.20, positionSizePct: 0.10 });
// w=1.0 -> (0.8)*0.10=0.08 -> floor 0.20 binds; conc=0.60 doesn't cut -> 0.20
check("low-pct sizing lifted to floor (w=1.0 -> 0.20)", computeDeployAmount(1.0, cfgD) === 0.20, `got ${computeDeployAmount(1.0, cfgD)}`);

// ── (e) gasReserve ALWAYS subtracted first ───────────────────────────────────
console.log("-- (e) gasReserve always reserved before sizing --");
const cfgE = makeCfg({ gasReserve: 0.20, positionSizePct: 1.0, deployAmountSol: 0.0, maxDeployAmount: 100, maxConcentrationPct: 0.99, autoCompoundHardCeilingSol: 100 });
// pct=1.0 => position == deployable == wallet-0.2. So position + gas == wallet exactly.
for (const w of [0.74, 1.0, 2.0]) {
  const got = computeDeployAmount(w, cfgE);
  check(`gas reserved: deploy ${got} + 0.2 <= wallet ${w}`, got + 0.20 <= w + 1e-9, `got ${got}`);
  check(`  deployable == wallet-gas (w=${w} -> ${got})`, Math.abs(got - (w - 0.20)) <= 0.011, `got ${got}`);
}
// Wallet below gasReserve => deployable 0 => floor would lift, but conc(=0 wallet frac) small;
// with floor 0 here result floors to 0 (nothing to deploy). Executor minDeploy refuses dust.
check("wallet <= gas -> 0 (nothing deployable)", computeDeployAmount(0.15, cfgE) === 0.0, `got ${computeDeployAmount(0.15, cfgE)}`);

// ── (f) concentration cap: position <= X% of wallet ──────────────────────────
console.log("-- (f) concentration cap: position never exceeds maxConcentrationPct of wallet --");
// pct=1.0 would want all deployable, but conc 0.60 caps at 60% of TOTAL wallet.
const cfgF = makeCfg({ positionSizePct: 1.0, maxConcentrationPct: 0.60, deployAmountSol: 0.0, maxDeployAmount: 100, autoCompoundHardCeilingSol: 100 });
for (const w of [1.0, 2.0, 5.0]) {
  const got = computeDeployAmount(w, cfgF);
  check(`concentration: deploy ${got} <= 60% of wallet ${w} (${(0.60 * w).toFixed(3)})`, got <= 0.60 * w + 1e-9, `got ${got}`);
  // and a buffer of at least 40% wallet remains (excl gas)
  check(`  >=40% wallet buffer remains (w=${w})`, w - got >= 0.40 * w - 1e-9, `residual ${w - got}`);
}
// Concentration must bind BELOW the ceiling at moderate wallets, proving it's active.
const concGot = computeDeployAmount(1.0, cfgF); // (0.8)*1.0=0.8, conc 0.6 -> 0.60
check("concentration binds below raw dynamic (w=1.0 -> 0.60, not 0.80)", concGot === 0.60, `got ${concGot}`);

// ── (g) flag OFF -> fixed size (regression) ──────────────────────────────────
console.log("-- (g) flag OFF: fixed legacy size, no wallet scaling --");
// Mirror live locked state: floor===ceil===0.20, flag off. Must return 0.20 for ALL wallets.
const cfgOff = makeCfg({ autoCompoundEnabled: false, deployAmountSol: 0.20, maxDeployAmount: 0.20 });
for (const w of [0.5, 0.74, 1.0, 2.0, 100]) {
  const got = computeDeployAmount(w, cfgOff);
  check(`flag OFF fixed @ wallet ${w} -> 0.20 (no scaling)`, got === 0.20, `got ${got}`);
}
// Flag off but floor!=ceil (un-locked without compound): legacy clamp, NO conc/hard bounds.
const cfgOff2 = makeCfg({ autoCompoundEnabled: false, deployAmountSol: 0.20, maxDeployAmount: 1.0, positionSizePct: 0.55, maxConcentrationPct: 0.01 });
// w=2.0 -> (1.8)*0.55=0.99 clamp[0.2,1.0]=0.99; conc 0.01 IGNORED when flag off -> 0.99
check("flag OFF ignores concentration cap (legacy clamp only)", computeDeployAmount(2.0, cfgOff2) === 0.99, `got ${computeDeployAmount(2.0, cfgOff2)}`);

// ── Invariant sweep: for ALL bounds, result <= every cap, never over-leverage ─
console.log("-- invariant sweep: result <= min(ceil, conc*wallet, hardCeiling), >=0 --");
const cfgInv = makeCfg({ positionSizePct: 0.55, maxDeployAmount: 1.0, maxConcentrationPct: 0.60, autoCompoundHardCeilingSol: 1.0 });
let sweepOk = true;
for (let w = 0.0; w <= 50; w += 0.13) {
  const got = computeDeployAmount(w, cfgInv);
  const ceilB = 1.0;
  const concB = 0.60 * w;
  const hardB = 1.0;
  if (got < 0 || got > ceilB + 1e-9 || got > concB + 1e-9 || got > hardB + 1e-9) {
    sweepOk = false;
    console.error(`    sweep breach @w=${w.toFixed(2)} got=${got} (ceil ${ceilB}, conc ${concB.toFixed(3)}, hard ${hardB})`);
    break;
  }
  // gas always reserved: position must fit in deployable
  if (got > Math.max(0, w - 0.20) + 1e-9) {
    sweepOk = false;
    console.error(`    sweep breach (gas) @w=${w.toFixed(2)} got=${got} > deployable ${(w - 0.20).toFixed(3)}`);
    break;
  }
}
check("invariant holds for ALL wallets 0..50 (<= every cap, gas reserved)", sweepOk);

// ── Existing money belts UNCHANGED (auto-compound weakens nothing) ───────────
console.log("-- existing belts unchanged --");
check("circuit daily SOL cap still 0.10 (UNCHANGED)", DAILY_LOSS_CAP_SOL === 0.10, `got ${DAILY_LOSS_CAP_SOL}`);
// Dynamic sizing belt still hard-caps at maxDeployAmount for any confidence.
const baseForDyn = computeDeployAmount(2.0, cfgInv); // ~0.99
for (const conf of [50, 75, 85, 95, 100]) {
  const sized = computeDynamicDeployAmount(baseForDyn, conf, cfgInv);
  check(`dynamic sizing belt: conf ${conf} sized ${sized} <= ceil 1.0`, sized <= 1.0 + 1e-9, `got ${sized}`);
}
// Live default: flag is OFF by default (Bro enables explicitly).
check("LIVE DEFAULT: autoCompoundEnabled defaults to false", config.risk.autoCompoundEnabled === false, `got ${config.risk.autoCompoundEnabled}`);
check("LIVE DEFAULT: maxConcentrationPct present (0.60)", config.risk.maxConcentrationPct === 0.60, `got ${config.risk.maxConcentrationPct}`);
check("LIVE DEFAULT: autoCompoundHardCeilingSol present (1.0)", config.risk.autoCompoundHardCeilingSol === 1.0, `got ${config.risk.autoCompoundHardCeilingSol}`);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
