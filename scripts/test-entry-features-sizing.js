/**
 * Vega self-check (2026-07-10, data-collection mode) — TWO money-path changes:
 *
 *  A) SIZE PIN unblock: with deployAmountSol=maxDeployAmount=0.10 (floor===ceil),
 *     computeDeployAmount(0.737 SOL) must return EXACTLY 0.10 and CLEAR the
 *     executor minDeploy floor (max(0.02, deployAmountSol)) — proving the Jul 7-10
 *     "computed 0.48 < floor 0.5" deadlock is gone. Hard caps still bind above 0.10.
 *
 *  B) entry_features capture: buildEntryFeatures (dlmm.js) + trackPosition (state.js)
 *     persist a 5-field snapshot; present values kept, absent → null (fail-safe,
 *     anti-pattern #2, NEVER fabricated).
 *
 * Run: node scripts/test-entry-features-sizing.js
 * (chdir's to a temp cwd so trackPosition writes a throwaway ./state.json.)
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeDeployAmount } from "../config.js";
import { buildEntryFeatures, MAX_LIVE_POSITION_SOL } from "../tools/dlmm.js";

let passed = 0;
function check(desc, fn) {
  fn();
  passed++;
  console.log(`  ok - ${desc}`);
}

// ─── TASK A — size pin / deadlock unblock ─────────────────────────────────
console.log("\nTASK A — size pin (computeDeployAmount @ wallet 0.737):");

const WALLET = 0.737;

// Pinned config: floor === ceil === 0.10 (uniform 0.10 SOL bet).
const pinnedOff = {
  management: { gasReserve: 0.2, positionSizePct: 0.35, deployAmountSol: 0.10 },
  risk: {
    maxDeployAmount: 0.10,
    autoCompoundEnabled: false,
    maxConcentrationPct: 0.60,
    autoCompoundHardCeilingSol: 1.0,
  },
};
const pinnedOn = {
  ...pinnedOff,
  risk: { ...pinnedOff.risk, autoCompoundEnabled: true },
};
// VPS-shaped variant (positionSizePct 0.1, autoCompound ON) — the config that
// produced the 0.48 deadlock, now pinned to 0.10.
const pinnedVps = {
  management: { gasReserve: 0.2, positionSizePct: 0.1, deployAmountSol: 0.10 },
  risk: {
    maxDeployAmount: 0.10,
    autoCompoundEnabled: true,
    maxConcentrationPct: 0.60,
    autoCompoundHardCeilingSol: 1.0,
  },
};

const amtOff = computeDeployAmount(WALLET, pinnedOff);
const amtOn = computeDeployAmount(WALLET, pinnedOn);
const amtVps = computeDeployAmount(WALLET, pinnedVps);

check(`computeDeployAmount = 0.10 (autoCompound OFF), got ${amtOff}`, () =>
  assert.strictEqual(amtOff, 0.10),
);
check(`computeDeployAmount = 0.10 (autoCompound ON), got ${amtOn}`, () =>
  assert.strictEqual(amtOn, 0.10),
);
check(`computeDeployAmount = 0.10 (VPS-shape pct=0.1, ON), got ${amtVps}`, () =>
  assert.strictEqual(amtVps, 0.10),
);

// Deadlock proof: the executor minDeploy floor is max(0.02, deployAmountSol).
const minDeploy = Math.max(0.02, pinnedOff.management.deployAmountSol);
check(`clears executor minDeploy floor ${minDeploy} (0.10 >= ${minDeploy})`, () =>
  assert.ok(amtOff >= minDeploy),
);
// Counterfactual: the OLD pin (0.5) with autoCompound produced ~0.48 < 0.5 → block.
const oldCfg = {
  management: { gasReserve: 0.2, positionSizePct: 0.35, deployAmountSol: 0.5 },
  risk: {
    maxDeployAmount: 0.5,
    autoCompoundEnabled: true,
    maxConcentrationPct: 0.60,
    autoCompoundHardCeilingSol: 1.0,
  },
};
const oldAmt = computeDeployAmount(WALLET, oldCfg);
const oldFloor = Math.max(0.02, 0.5);
check(`counterfactual: OLD 0.5 pin computed ${oldAmt} < old floor ${oldFloor} (was blocked)`, () =>
  assert.ok(oldAmt < oldFloor),
);

// Hard caps still bind ABOVE the 0.10 pin.
check(`MAX_LIVE_POSITION_SOL (${MAX_LIVE_POSITION_SOL}) > 0.10 pin (cap intact)`, () =>
  assert.ok(MAX_LIVE_POSITION_SOL > 0.10),
);
check(`0.10 within live cap min(MAX_LIVE_POSITION_SOL, maxDeployAmount)`, () => {
  const liveCap = Math.min(MAX_LIVE_POSITION_SOL, pinnedOff.risk.maxDeployAmount);
  assert.ok(amtOff <= liveCap);
});

// ─── TASK B — buildEntryFeatures (pure, fail-safe) ────────────────────────
console.log("\nTASK B — buildEntryFeatures:");

const full = buildEntryFeatures({
  sol_regime_24h_pct: -3.2,
  token_price_change_1h: 4.1,
  token_price_change_24h: -12.5,
  buy_vol: 30000,
  sell_vol: 10000,
  mcap: 850000,
});
check("full inputs preserved + ratio computed", () => {
  assert.strictEqual(full.sol_regime_24h_pct, -3.2);
  assert.strictEqual(full.token_price_change_1h, 4.1);
  assert.strictEqual(full.token_price_change_24h, -12.5);
  assert.strictEqual(full.buy_sell_flow_ratio, 0.75); // 30000/40000
  assert.strictEqual(full.mcap, 850000);
});

const empty = buildEntryFeatures({});
check("no inputs → all 5 fields null (fail-safe, never fabricated)", () => {
  assert.deepStrictEqual(empty, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  });
});

check("undefined arg → all null (no throw)", () => {
  const r = buildEntryFeatures(undefined);
  assert.strictEqual(r.mcap, null);
  assert.strictEqual(r.buy_sell_flow_ratio, null);
});

check("partial inputs: present kept, absent null", () => {
  const r = buildEntryFeatures({ sol_regime_24h_pct: 1.5, mcap: 500000 });
  assert.strictEqual(r.sol_regime_24h_pct, 1.5);
  assert.strictEqual(r.mcap, 500000);
  assert.strictEqual(r.token_price_change_1h, null);
  assert.strictEqual(r.buy_sell_flow_ratio, null);
});

check("zero total flow → ratio null (not 0, not NaN)", () => {
  const r = buildEntryFeatures({ buy_vol: 0, sell_vol: 0 });
  assert.strictEqual(r.buy_sell_flow_ratio, null);
});

check("missing one flow leg → ratio null (unknown, not fabricated)", () => {
  const r = buildEntryFeatures({ buy_vol: 5000 });
  assert.strictEqual(r.buy_sell_flow_ratio, null);
});

check("non-finite inputs → null (NaN/Infinity/strings never leak through)", () => {
  const r = buildEntryFeatures({
    sol_regime_24h_pct: NaN,
    token_price_change_1h: Infinity,
    mcap: "not-a-number",
  });
  assert.strictEqual(r.sol_regime_24h_pct, null);
  assert.strictEqual(r.token_price_change_1h, null);
  assert.strictEqual(r.mcap, null);
});

// ─── TASK B — trackPosition persists entry_features (state.js) ────────────
console.log("\nTASK B — trackPosition persistence (state.js):");

// chdir to a throwaway cwd so trackPosition writes ./state.json there, NOT the repo.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vega-ef-"));
fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true }); // logger writes ./logs
process.chdir(tmpDir);

const { trackPosition, getTrackedPosition } = await import("../state.js");

trackPosition({
  position: "POS_FULL",
  pool: "POOL_A",
  pool_name: "FOO-SOL",
  strategy: "bid_ask",
  amount_sol: 0.10,
  active_bin: 100,
  bin_step: 80,
  entry_features: full,
});
const recFull = getTrackedPosition("POS_FULL");
check("entry_features persisted with all fields", () => {
  assert.deepStrictEqual(recFull.entry_features, {
    sol_regime_24h_pct: -3.2,
    token_price_change_1h: 4.1,
    token_price_change_24h: -12.5,
    buy_sell_flow_ratio: 0.75,
    mcap: 850000,
  });
});

trackPosition({
  position: "POS_NONE",
  pool: "POOL_B",
  pool_name: "BAR-SOL",
  strategy: "bid_ask",
  amount_sol: 0.10,
  active_bin: 200,
  bin_step: 100,
  // no entry_features → must persist a null-filled 5-field object (not undefined)
});
const recNone = getTrackedPosition("POS_NONE");
check("missing entry_features → 5-field null object (never undefined/fabricated)", () => {
  assert.deepStrictEqual(recNone.entry_features, {
    sol_regime_24h_pct: null,
    token_price_change_1h: null,
    token_price_change_24h: null,
    buy_sell_flow_ratio: null,
    mcap: null,
  });
});

trackPosition({
  position: "POS_PARTIAL",
  pool: "POOL_C",
  pool_name: "BAZ-SOL",
  strategy: "bid_ask",
  amount_sol: 0.10,
  active_bin: 300,
  bin_step: 125,
  entry_features: { sol_regime_24h_pct: -6.0, mcap: 1200000 },
});
const recPartial = getTrackedPosition("POS_PARTIAL");
check("partial entry_features: present kept, absent coerced to null", () => {
  assert.strictEqual(recPartial.entry_features.sol_regime_24h_pct, -6.0);
  assert.strictEqual(recPartial.entry_features.mcap, 1200000);
  assert.strictEqual(recPartial.entry_features.token_price_change_1h, null);
  assert.strictEqual(recPartial.entry_features.buy_sell_flow_ratio, null);
});

// cleanup throwaway state
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* best-effort */ }

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
