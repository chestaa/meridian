// scripts/validate-velocity-fields.js
// Vega VETO-clearing validation — Velocity exit live-field wiring.
//
// VETO concern: the velocity-drop exit reads price_change_1h_pct + net_buyers_1h
// off the LIVE position object, but getMyPositions never attached them — so the
// exit could NEVER fire live (only paper had the fields).
//
// This proves the wiring fix end-to-end with mocked HTTP (NO live RPC/wallet):
//   1. fetchVelocityStatsForMint parses Jupiter stats1h → price_change_1h_pct
//      + net_buyers_1h (same source paper uses: token.js stats1h).
//   2. getMyPositions attaches BOTH fields to every live position object.
//   3. The wired live object, fed to updatePnlAndCheckExits, FIRES VELOCITY_EXIT
//      (profit + 1h drop + net_buyers<0) — proving the live path now works.
//   4. Missing stats → fields are null → velocity exit safely NO-OPS (no false fire).
//
// All network calls are stubbed via a global.fetch shim.

import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
if (!fs.existsSync(path.join(ROOT, "tools", "dlmm.js"))) {
  console.error("ERROR: run from the Meridian repo root.");
  process.exit(1);
}

process.env.RPC_URL = process.env.RPC_URL || "https://localhost.invalid/rpc";
process.env.DRY_RUN = "true";
// Ephemeral throwaway burner keypair so getSigningWallet() resolves a valid,
// non-blacklisted pubkey. NEVER a real wallet — generated in-process, used only
// to build (mocked) API URLs. DRY_RUN=true → zero on-chain activity.
const EPHEMERAL = Keypair.generate();
process.env.BURNER_WALLET_KEY = bs58.encode(EPHEMERAL.secretKey);

let assertions = 0;
function check(label, fn) {
  fn();
  assertions += 1;
  console.log(`  PASS ${label}`);
}

const WALLET = "So11111111111111111111111111111111111111112";
const POOL = "Poo1111111111111111111111111111111111111111";
const POSITION = "Pos1111111111111111111111111111111111111111";
const BASE_MINT = "Bas3111111111111111111111111111111111111111";

// ── global.fetch shim routing each endpoint to a faithful payload ──
let velocityVariant = "drop"; // "drop" | "missing"
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

  if (u.includes("/portfolio/open")) {
    return json({
      pools: [{
        poolAddress: POOL,
        tokenX: "WHALE", tokenY: "SOL",
        tokenXMint: BASE_MINT,
        listPositions: [POSITION],
        outOfRange: false,
        positionsOutOfRange: [],
      }],
    });
  }
  if (u.includes("/positions/") && u.includes("/pnl")) {
    // Meteora PnL API shape — in profit, in range.
    return json({ positions: [{
      positionAddress: POSITION,
      lowerBinId: -40, upperBinId: 0, poolActiveBinId: -10,
      isOutOfRange: false,
      pnlUsd: 5, pnlPctChange: 4,
      unrealizedPnl: { balances: 100, balancesSol: 0.5,
        unclaimedFeeTokenX: { usd: 1, amountSol: 0.005 },
        unclaimedFeeTokenY: { usd: 1, amountSol: 0.005 } },
      allTimeFees: { total: { usd: 2, sol: 0.01 } },
      allTimeDeposits: { total: { usd: 96, sol: 0.48 } },
      feePerTvl24h: 8,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
    }] });
  }
  if (u.includes("datapi.jup.ag/v1/assets/search")) {
    if (velocityVariant === "missing") {
      return json([{ id: BASE_MINT, symbol: "WHALE" }]); // no stats1h
    }
    // Faithful Jupiter shape: hard 1h reversal, sellers winning.
    return json([{ id: BASE_MINT, symbol: "WHALE", stats1h: {
      priceChange: -16.4, numNetBuyers: -7, buyVolume: 100, sellVolume: 400, numOrganicBuyers: 3,
    } }]);
  }
  if (u.includes("api.lpagent.io")) return json({ data: [] });
  // Default: empty
  return json({});
};

const dlmm = await import("../tools/dlmm.js");
const state = await import("../state.js");

// Make getWallet resolve without a real key, and force solMode off for simplicity.
const { config } = await import("../config.js");
config.management.velocityExitEnabled = true;
config.management.velocityDropPct = 15;
config.api.lpAgentRelayEnabled = false;
process.env.LPAGENT_API_KEY = ""; // skip lpagent path

// state.js writes ./state.json — back up.
const STATE_FILE = path.join(ROOT, "state.json");
const STATE_BACKUP = path.join(ROOT, "state.json.vvf-bak");
let hadState = false;
if (fs.existsSync(STATE_FILE)) { fs.copyFileSync(STATE_FILE, STATE_BACKUP); hadState = true; }
function cleanup() {
  if (hadState) fs.copyFileSync(STATE_BACKUP, STATE_FILE);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(STATE_BACKUP)) fs.unlinkSync(STATE_BACKUP);
  global.fetch = realFetch;
}

try {
  console.log("validate-velocity-fields.js — Vega velocity live-field wiring proof\n");

  // ── 1. parse layer ──
  console.log("Part 1 — fetchVelocityStatsForMint parses Jupiter stats1h");
  velocityVariant = "drop";
  const parsed = await dlmm.fetchVelocityStatsForMint(BASE_MINT);
  check("price_change_1h_pct parsed from stats1h.priceChange (-16.4)", () => {
    assert.equal(parsed.price_change_1h_pct, -16.4);
  });
  check("net_buyers_1h parsed from stats1h.numNetBuyers (-7)", () => {
    assert.equal(parsed.net_buyers_1h, -7);
  });

  // ── 2. getMyPositions attaches both fields to the live position ──
  console.log("\nPart 2 — getMyPositions wires fields onto live position object");
  const result = await dlmm.getMyPositions({ force: true, silent: true });
  const live = result.positions?.find((p) => p.position === POSITION);
  check("getMyPositions returned the live position", () => {
    assert.ok(live, `expected position ${POSITION}; got ${JSON.stringify(result).slice(0, 300)}`);
  });
  check("live position object HAS price_change_1h_pct key", () => {
    assert.ok("price_change_1h_pct" in live);
  });
  check("live position object HAS net_buyers_1h key", () => {
    assert.ok("net_buyers_1h" in live);
  });
  check("live price_change_1h_pct === -16.4 (wired from Jupiter, was ABSENT before)", () => {
    assert.equal(live.price_change_1h_pct, -16.4);
  });
  check("live net_buyers_1h === -7 (wired from Jupiter, was ABSENT before)", () => {
    assert.equal(live.net_buyers_1h, -7);
  });

  // ── 3. wired live object → VELOCITY_EXIT fires ──
  console.log("\nPart 3 — wired live object drives VELOCITY_EXIT");
  // Build the live-shaped object exactly as getMyPositions now produces it.
  const wiredLive = {
    position: POSITION, pool: POOL, in_range: true, pnl_pct: 4,
    price_change_1h_pct: parsed.price_change_1h_pct,
    net_buyers_1h: parsed.net_buyers_1h,
  };
  // Arm a tracked position (partial done so partial TP doesn't pre-empt).
  fs.writeFileSync(STATE_FILE, JSON.stringify({ positions: { [POSITION]: {
    position: POSITION, pool: POOL, pool_name: "WHALE-SOL", closed: false,
    out_of_range_since: null, peak_pnl_pct: 5, trailing_active: false,
    partial_tp_done: true, organic_score: 50, notes: [],
    deployed_at: new Date(Date.now() - 90 * 60000).toISOString(), pending_peak_pnl_pct: null,
  } }, recentEvents: [], lastUpdated: null }, null, 2));

  const MGMT = { stopLossPct: -50, takeProfitPct: 100, trailingTakeProfit: true,
    trailingTriggerPct: 18, trailingDropPct: 6, partialTpEnabled: true,
    partialTpTriggerPct: 15, partialTpPct: 50, velocityExitEnabled: true,
    velocityDropPct: 15, rebalanceOnOorEnabled: false, outOfRangeWaitMinutes: 20 };

  const exit = state.updatePnlAndCheckExits(POSITION, wiredLive, MGMT);
  check("wired live fields → VELOCITY_EXIT fires (live path now functional)", () => {
    assert.ok(exit, "expected an exit action");
    assert.equal(exit.action, "VELOCITY_EXIT");
  });

  // ── 4. missing stats → null fields → safe no-op ──
  console.log("\nPart 4 — missing stats → null → velocity safely no-ops");
  velocityVariant = "missing";
  const parsedMissing = await dlmm.fetchVelocityStatsForMint("Bas4111111111111111111111111111111111111111");
  check("missing stats1h → price_change_1h_pct null", () => {
    assert.equal(parsedMissing.price_change_1h_pct, null);
  });
  check("missing stats1h → net_buyers_1h null", () => {
    assert.equal(parsedMissing.net_buyers_1h, null);
  });
  const noStatExit = state.updatePnlAndCheckExits(POSITION, {
    position: POSITION, pool: POOL, in_range: true, pnl_pct: 4,
    price_change_1h_pct: null, net_buyers_1h: null,
  }, MGMT);
  check("null velocity fields → NO VELOCITY_EXIT (safe no-op, no false fire)", () => {
    assert.ok(noStatExit === null || noStatExit.action !== "VELOCITY_EXIT");
  });

  console.log(`\nALL ${assertions} assertions PASS — velocity fields wired + functional live`);
} finally {
  cleanup();
}
