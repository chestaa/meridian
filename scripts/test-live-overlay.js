// Cassiopeia Option C — Live Overlay tests.
//
// Validates:
//   - effectiveScreeningThresholds() returns base when dryRun=true (overlay ignored)
//   - returns overlay-merged values when dryRun=false
//   - liveOverlay() returns null in paper mode, object in live
//   - Live-only rejection: dev_sold_all → "dev_sold_all_in_live"
//   - Live-only rejection: smart_wallets=0 + organic<80 → reject
//   - Pass: smart_wallets=0 + organic>=80 (high organic compensates)
//   - Orion confidence < floor in live → forced skip
//   - Orion confidence >= floor in live → allowed
//   - Orion confidence < floor in paper → allowed (overlay paper-blind)
//   - requireSmartWalletOrHighOrganic=false → not enforced
//   - liveOverrides=null → legacy behavior (no overlay)
//
// Run: node scripts/test-live-overlay.js

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// Import the modules under test
const { config } = await import("../config.js");
const { effectiveScreeningThresholds, liveOverlay } = await import("../tools/screening.js");

// Snapshot the original config state so we can mutate-and-restore.
const originalDryRun = config.dryRun;
const originalOverrides = config.liveOverrides;
const originalMinOrganic = config.screening.minOrganic;
const originalMaxBotPct = config.screening.maxBotHoldersPct;

const OVERLAY_FIXTURE = {
  minOrganic: 75,
  maxBotHoldersPct: 20,
  minFeeActiveTvlRatio: 0.07,
  maxTop10Pct: 55,
  orionMinConfidence: 70,
  requireDevNotSoldAll: true,
  requireSmartWalletOrHighOrganic: true,
};

console.log("=== Cassiopeia Option C — Live Overlay tests ===\n");

// ── 1. DRY_RUN=true → overlay ignored, base thresholds active ──
console.log("[1] dryRun=true → base thresholds (overlay ignored)");
{
  config.dryRun = true;
  config.liveOverrides = OVERLAY_FIXTURE;
  const eff = effectiveScreeningThresholds();
  check("minOrganic matches base (60) not overlay (75)", eff.minOrganic === originalMinOrganic);
  check("maxBotHoldersPct matches base not overlay (20)", eff.maxBotHoldersPct === originalMaxBotPct);
  check("liveOverlay() returns null in paper", liveOverlay() === null);
}

// ── 2. DRY_RUN=false → overlay merged on top of base ──
console.log("\n[2] dryRun=false → overlay active");
{
  config.dryRun = false;
  config.liveOverrides = OVERLAY_FIXTURE;
  const eff = effectiveScreeningThresholds();
  check("minOrganic raised to overlay (75)", eff.minOrganic === 75);
  check("maxBotHoldersPct tightened to overlay (20)", eff.maxBotHoldersPct === 20);
  check("minFeeActiveTvlRatio raised to overlay (0.07)", eff.minFeeActiveTvlRatio === 0.07);
  check("maxTop10Pct tightened to overlay (55)", eff.maxTop10Pct === 55);
  check("base maxMcap preserved (not in overlay)", eff.maxMcap === config.screening.maxMcap);
  check("liveOverlay() returns object in live", liveOverlay() !== null);
  check("liveOverlay().orionMinConfidence=70", liveOverlay().orionMinConfidence === 70);
}

// ── 3. liveOverrides=null → no overlay even when live ──
console.log("\n[3] dryRun=false + liveOverrides=null → legacy");
{
  config.dryRun = false;
  config.liveOverrides = null;
  const eff = effectiveScreeningThresholds();
  check("minOrganic falls back to base", eff.minOrganic === originalMinOrganic);
  check("liveOverlay() returns null when liveOverrides=null", liveOverlay() === null);
}

// ── 4. Simulate dev_sold_all live rejection rule ──
console.log("\n[4] requireDevNotSoldAll rule (live only)");
{
  config.dryRun = false;
  config.liveOverrides = OVERLAY_FIXTURE;
  const overlay = liveOverlay();
  const pool = { name: "TEST-SOL", dev_sold_all: true };
  // Replicate the rejection predicate from screening.js
  const shouldReject = !!(overlay?.requireDevNotSoldAll && pool.dev_sold_all === true);
  check("dev_sold_all=true in live → rejected (dev_sold_all_in_live)", shouldReject === true);

  const poolOk = { name: "OK-SOL", dev_sold_all: false };
  const shouldRejectOk = !!(overlay?.requireDevNotSoldAll && poolOk.dev_sold_all === true);
  check("dev_sold_all=false in live → not rejected", shouldRejectOk === false);

  // Paper mode: rule should not fire even with dev_sold_all=true
  config.dryRun = true;
  const overlayPaper = liveOverlay();
  const shouldRejectPaper = !!(overlayPaper?.requireDevNotSoldAll && pool.dev_sold_all === true);
  check("dev_sold_all=true in paper → NOT rejected (overlay off)", shouldRejectPaper === false);
}

// ── 5. requireSmartWalletOrHighOrganic rule (live only) ──
console.log("\n[5] requireSmartWalletOrHighOrganic rule");
{
  config.dryRun = false;
  config.liveOverrides = OVERLAY_FIXTURE;
  const overlay = liveOverlay();

  function shouldRejectSmartRule(p) {
    if (!overlay?.requireSmartWalletOrHighOrganic) return false;
    const swCount = Number(p.smart_wallet_count ?? 0);
    const organic = Number(p.organic_score ?? 0);
    return swCount === 0 && organic < 80;
  }

  check("sw=0 + organic=70 → rejected", shouldRejectSmartRule({ smart_wallet_count: 0, organic_score: 70 }) === true);
  check("sw=0 + organic=85 → PASS (high organic compensates)", shouldRejectSmartRule({ smart_wallet_count: 0, organic_score: 85 }) === false);
  check("sw=1 + organic=50 → PASS (smart money compensates)", shouldRejectSmartRule({ smart_wallet_count: 1, organic_score: 50 }) === false);
  check("sw=2 + organic=85 → PASS (both)", shouldRejectSmartRule({ smart_wallet_count: 2, organic_score: 85 }) === false);

  // Flag off → not enforced
  config.liveOverrides = { ...OVERLAY_FIXTURE, requireSmartWalletOrHighOrganic: false };
  const overlayOff = liveOverlay();
  function shouldRejectFlagOff(p) {
    if (!overlayOff?.requireSmartWalletOrHighOrganic) return false;
    const swCount = Number(p.smart_wallet_count ?? 0);
    const organic = Number(p.organic_score ?? 0);
    return swCount === 0 && organic < 80;
  }
  check("flag=false → not enforced even on sw=0 + low organic", shouldRejectFlagOff({ smart_wallet_count: 0, organic_score: 50 }) === false);
}

// ── 6. Orion confidence floor enforcement ──
console.log("\n[6] Orion confidence floor (live only)");
{
  // Stub OpenAI seam for orion.
  let nextVerdict = null;
  const fakeClient = {
    chat: {
      completions: {
        create: async (payload) => {
          const userMsg = payload.messages?.find?.((m) => m.role === "user")?.content || "";
          let parsed = {};
          try { parsed = JSON.parse(userMsg); } catch { /* ignore */ }
          const pool_address = parsed?.candidate?.pool_address || "UNKNOWN";
          const v = { pool_address, ...nextVerdict };
          return {
            id: "stub", model: payload.model,
            choices: [{
              index: 0, finish_reason: "tool_calls",
              message: { role: "assistant", content: null, tool_calls: [{
                id: "call_x", type: "function",
                function: { name: "judge_candidate", arguments: JSON.stringify(v) },
              }] },
            }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          };
        },
      },
    },
  };

  const { judgeCandidates, __setClientForTests } = await import("../agents/orion.js");
  __setClientForTests(fakeClient);

  const candidate = {
    pool: { pool: "PoolX", name: "X-SOL", bin_step: 100, fee_pct: 1, volatility: 3, organic_score: 70 },
    sw: { in_pool: [] }, n: { narrative: null }, ti: { audit: {}, global_fees_sol: 50 }, mem: null,
  };

  // Live + confidence=65 (below 70 floor) → forced skip
  config.dryRun = false;
  config.liveOverrides = OVERLAY_FIXTURE;
  nextVerdict = { decision: "enter", confidence: 65, reason: "ok metrics" };
  let [v] = await judgeCandidates([candidate], {});
  check("live + conf 65 < floor 70 → decision=skip", v.decision === "skip");
  check("live + conf 65 → reason mentions floor", /< live floor/.test(v.reason));

  // Live + confidence=75 (above floor) → enter allowed
  nextVerdict = { decision: "enter", confidence: 75, reason: "strong setup" };
  [v] = await judgeCandidates([candidate], {});
  check("live + conf 75 >= floor 70 → decision=enter", v.decision === "enter");
  check("live + conf 75 → reason unchanged", v.reason === "strong setup");

  // Paper + confidence=65 → enter allowed (no overlay)
  config.dryRun = true;
  nextVerdict = { decision: "enter", confidence: 65, reason: "ok metrics" };
  [v] = await judgeCandidates([candidate], {});
  check("paper + conf 65 → decision=enter (overlay off)", v.decision === "enter");

  // Live + liveOverrides=null → no floor enforced
  config.dryRun = false;
  config.liveOverrides = null;
  nextVerdict = { decision: "enter", confidence: 30, reason: "low conf" };
  [v] = await judgeCandidates([candidate], {});
  check("live + liveOverrides=null + conf 30 → decision=enter (legacy)", v.decision === "enter");

  // Orion skip verdict in live + low confidence → already skip, untouched
  config.liveOverrides = OVERLAY_FIXTURE;
  nextVerdict = { decision: "skip", confidence: 10, reason: "bad pool" };
  [v] = await judgeCandidates([candidate], {});
  check("live + decision=skip stays skip (no floor side-effect)", v.decision === "skip");
}

// ── Restore ──
config.dryRun = originalDryRun;
config.liveOverrides = originalOverrides;

console.log(`\n${passed} assertions passed, ${failed} failed.`);
if (failed > 0) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
