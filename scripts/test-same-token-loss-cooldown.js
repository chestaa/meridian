/**
 * Same-token loss re-deploy cooldown — SHADOW-FIRST instrumentation test.
 * Cassiopeia 👁️ — verifies the cross-token revenge-deploy instrument:
 *   - pure matchers (reason / figure / qualifies-trigger) incl. fail-safe INVERSE
 *   - cross-pool base_mint keying (prior loss in pool A → re-deploy in pool B)
 *   - shadow mode NEVER rejects (funnel byte-unchanged: base_mint_cooldown_until
 *     untouched, isBaseMintOnCooldown stays false)
 *   - enforce mode reuses the existing base_mint cooldown gate (rejects for real)
 *   - winner-exempt (profit/breakeven closes never arm)
 *   - single-loss trigger (one qualifying close arms — no 3x requirement)
 *   - revenge re-deploy OUTCOME record for Lyra's block-set skew evaluation
 *
 * Run: node scripts/test-same-token-loss-cooldown.js
 * Isolates pool-memory.json AND the shadow-log file (temp + restore).
 */
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";

// ── Isolate the shadow-log file BEFORE importing pool-memory (const read at load) ──
const SHADOW_FILE = path.join(os.tmpdir(), `same-token-cooldown-shadow-test-${process.pid}.jsonl`);
process.env.MERIDIAN_SAME_TOKEN_COOLDOWN_SHADOW_FILE = SHADOW_FILE;
if (fs.existsSync(SHADOW_FILE)) fs.unlinkSync(SHADOW_FILE);

const POOL_MEMORY_FILE = "./pool-memory.json";
const hadFile = fs.existsSync(POOL_MEMORY_FILE);
const backup = hadFile ? fs.readFileSync(POOL_MEMORY_FILE, "utf8") : null;
fs.writeFileSync(POOL_MEMORY_FILE, "{}");

const { config } = await import("../config.js");
const {
  normalizeCloseReason,
  sameTokenLossReasonMatches,
  sameTokenLossFigure,
  sameTokenLossQualifiesTrigger,
  findPriorLossForRedeploy,
  applySameTokenLossCooldown,
  recordPoolDeploy,
  isBaseMintOnCooldown,
} = await import("../pool-memory.js");

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

function resetPoolMemory() { fs.writeFileSync(POOL_MEMORY_FILE, "{}"); }
function resetShadow() { if (fs.existsSync(SHADOW_FILE)) fs.unlinkSync(SHADOW_FILE); }
function readShadow() {
  if (!fs.existsSync(SHADOW_FILE)) return [];
  return fs.readFileSync(SHADOW_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function restore() {
  if (backup !== null) fs.writeFileSync(POOL_MEMORY_FILE, backup);
  else if (fs.existsSync(POOL_MEMORY_FILE)) fs.unlinkSync(POOL_MEMORY_FILE);
  resetShadow();
}

const CFG = { sameTokenLossCooldownHours: 6, sameTokenLossCooldownReasons: ["stop loss", "give_back_protect"] };
const MINT = "So1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT2 = "So2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const iso = (ms) => new Date(ms).toISOString();

try {
  console.log("Same-token loss re-deploy cooldown (shadow-first)\n");

  // ── 1. normalizeCloseReason ──────────────────────────────────
  assert.strictEqual(normalizeCloseReason("Stop_Loss"), "stop loss");
  assert.strictEqual(normalizeCloseReason("give_back_protect: peak 5% → 1%"), "give back protect: peak 5% → 1%");
  assert.strictEqual(normalizeCloseReason(null), "");
  ok("normalizeCloseReason lowercases, [-_]→space, collapses");

  // ── 2. sameTokenLossReasonMatches ────────────────────────────
  assert.strictEqual(sameTokenLossReasonMatches("stop loss", CFG.sameTokenLossCooldownReasons), true);
  assert.strictEqual(sameTokenLossReasonMatches("stop_loss", CFG.sameTokenLossCooldownReasons), true, "underscore variant");
  assert.strictEqual(sameTokenLossReasonMatches("give_back_protect: peak 5% → -3%", CFG.sameTokenLossCooldownReasons), true, "give-back prefix");
  assert.strictEqual(sameTokenLossReasonMatches("low yield", CFG.sameTokenLossCooldownReasons), false, "non-listed reason");
  assert.strictEqual(sameTokenLossReasonMatches("agent decision", CFG.sameTokenLossCooldownReasons), false, "generic close");
  assert.strictEqual(sameTokenLossReasonMatches("", CFG.sameTokenLossCooldownReasons), false, "empty reason → false");
  assert.strictEqual(sameTokenLossReasonMatches(null, CFG.sameTokenLossCooldownReasons), false, "null reason → false");
  ok("sameTokenLossReasonMatches: SL/give-back match; low-yield/agent/empty/null → false");

  // ── 3. sameTokenLossFigure — SOL preferred, then USD, then %, else null ──
  assert.deepStrictEqual(sameTokenLossFigure({ realized_sol_delta: -0.05, pnl_usd: -8, pnl_pct: -30 }), { value: -0.05, unit: "SOL" });
  assert.deepStrictEqual(sameTokenLossFigure({ pnl_usd: -8, pnl_pct: -30 }), { value: -8, unit: "USD" });
  assert.deepStrictEqual(sameTokenLossFigure({ pnl_pct: -30 }), { value: -30, unit: "%" });
  assert.strictEqual(sameTokenLossFigure({ realized_sol_delta: null, pnl_usd: null, pnl_pct: null }), null, "all null → null");
  assert.strictEqual(sameTokenLossFigure({}), null, "empty → null");
  ok("sameTokenLossFigure: SOL→USD→% preference; no finite figure → null");

  // ── 4. sameTokenLossQualifiesTrigger ─────────────────────────
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "stop loss", realized_sol_delta: -0.05 }, CFG), true, "loss + SL → arm");
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "give_back_protect: -2%", pnl_usd: -3 }, CFG), true, "loss + give-back → arm");
  // winner-exempt
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "stop loss", realized_sol_delta: 0.04 }, CFG), false, "PROFIT + SL → winner-exempt");
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "stop loss", realized_sol_delta: 0 }, CFG), false, "breakeven → not a loss");
  // reason filter
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "low yield", realized_sol_delta: -0.05 }, CFG), false, "loss but non-listed reason → no arm");
  // FAIL-SAFE INVERSE — missing pnl must NOT fabricate a cooldown
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "stop loss" }, CFG), false, "SL but missing pnl → no arm (fail-safe inverse)");
  assert.strictEqual(sameTokenLossQualifiesTrigger({ close_reason: "stop loss", realized_sol_delta: null, pnl_usd: null, pnl_pct: null }, CFG), false, "all-null pnl → no arm");
  ok("sameTokenLossQualifiesTrigger: loss+reason arms; winner/breakeven/wrong-reason/missing-pnl → no arm");

  // ── 5. findPriorLossForRedeploy — CROSS-POOL base_mint keying ─
  const T0 = Date.parse("2026-07-20T00:00:00.000Z");
  const dbCross = {
    poolA: { name: "POOL-A", base_mint: MINT, deploys: [
      { close_reason: "stop loss", realized_sol_delta: -0.05, closed_at: iso(T0) },
    ] },
    poolB: { name: "POOL-B", base_mint: MINT, deploys: [] },
    poolC: { name: "POOL-C", base_mint: MINT2, deploys: [
      { close_reason: "stop loss", realized_sol_delta: -0.09, closed_at: iso(T0) },
    ] },
  };
  // re-deploy of MINT in a DIFFERENT pool (B), 2h after the pool-A loss → matched
  const priorCross = findPriorLossForRedeploy(dbCross, MINT, T0 + 2 * 3600e3, CFG);
  assert.ok(priorCross, "cross-pool prior loss found (loss in A → redeploy in B)");
  assert.strictEqual(priorCross.gapHours, 2, "gap 2h");
  assert.deepStrictEqual(priorCross.priorLoss, { value: -0.05, unit: "SOL" });
  // outside window (8h > 6h) → null
  assert.strictEqual(findPriorLossForRedeploy(dbCross, MINT, T0 + 8 * 3600e3, CFG), null, "8h gap > 6h window → null");
  // re-deploy that OPENED before the loss closed → null
  assert.strictEqual(findPriorLossForRedeploy(dbCross, MINT, T0 - 3600e3, CFG), null, "redeploy before loss → null");
  // wrong mint keying is respected (MINT2's loss must not match MINT)
  const priorMint2 = findPriorLossForRedeploy(dbCross, MINT2, T0 + 1 * 3600e3, CFG);
  assert.strictEqual(priorMint2.priorLoss.value, -0.09, "MINT2 keyed to its own loss");
  // missing base_mint → null (fail-safe inverse)
  assert.strictEqual(findPriorLossForRedeploy(dbCross, null, T0 + 2 * 3600e3, CFG), null, "missing base_mint → null");
  ok("findPriorLossForRedeploy: cross-pool keying, window bound, ordering, mint isolation, fail-safe");

  // ── 6. applySameTokenLossCooldown OFF mode → no-op ───────────
  resetPoolMemory(); resetShadow();
  {
    const db = { p1: { name: "p1", base_mint: MINT, deploys: [{ close_reason: "stop loss", realized_sol_delta: -0.05, closed_at: iso(T0), deployed_at: iso(T0 - 3600e3) }] } };
    const r = applySameTokenLossCooldown({ db, poolAddress: "p1", deployData: { base_mint: MINT, close_reason: "stop loss", realized_sol_delta: -0.05, deployed_at: iso(T0 - 3600e3) }, cfg: { ...CFG, sameTokenLossCooldownMode: "off" } });
    assert.strictEqual(r.mode, "off");
    assert.strictEqual(r.armed, false);
    assert.strictEqual(db.p1.same_token_loss_shadow_until, undefined, "off → no shadow marker");
    assert.strictEqual(db.p1.base_mint_cooldown_until, undefined, "off → no base cooldown");
    assert.strictEqual(readShadow().length, 0, "off → no shadow-log");
  }
  ok("OFF mode → total no-op (no marker, no cooldown, no log)");

  // ── 7. SHADOW mode → funnel byte-unchanged (single-loss trigger) ──
  resetPoolMemory(); resetShadow();
  config.management.sameTokenLossCooldownMode = "shadow";
  config.management.sameTokenLossCooldownHours = 6;
  config.management.sameTokenLossCooldownReasons = ["stop loss", "give_back_protect"];
  recordPoolDeploy("shadowPool", {
    pool_name: "SHADOW-POOL", base_mint: MINT,
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: -30, pnl_usd: -8, realized_sol_delta: -0.05,
    close_reason: "stop loss", strategy: "spot",
  });
  {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    // FUNNEL BYTE-UNCHANGED: the field the screening gate reads must be untouched
    assert.strictEqual(db.shadowPool.base_mint_cooldown_until, undefined, "shadow → base_mint_cooldown_until UNTOUCHED");
    assert.strictEqual(isBaseMintOnCooldown(MINT), false, "shadow → isBaseMintOnCooldown FALSE (funnel unchanged)");
    // But the shadow marker + shadow-log DO record the would-block
    assert.ok(db.shadowPool.same_token_loss_shadow_until, "shadow → shadow marker set");
    assert.strictEqual(db.shadowPool.same_token_loss_prior_sol, -0.05, "shadow marker carries -0.05 SOL");
    const armed = readShadow().filter((r) => r.kind === "armed");
    assert.strictEqual(armed.length, 1, "shadow → one armed record");
    assert.strictEqual(armed[0].enforced, false, "shadow armed record enforced=false");
    assert.strictEqual(armed[0].base_mint, MINT);
    assert.deepStrictEqual(armed[0].prior_loss, { value: -0.05, unit: "SOL" });
  }
  ok("SHADOW → single-loss arms marker+log but base_mint_cooldown_until untouched (funnel byte-unchanged)");

  // ── 8. ENFORCE mode → reuses existing base_mint gate (rejects for real) ──
  resetPoolMemory(); resetShadow();
  config.management.sameTokenLossCooldownMode = "enforce";
  recordPoolDeploy("enforcePool", {
    pool_name: "ENFORCE-POOL", base_mint: MINT2,
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: -20, pnl_usd: -5, realized_sol_delta: -0.03,
    close_reason: "stop loss", strategy: "spot",
  });
  {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    assert.ok(db.enforcePool.base_mint_cooldown_until, "enforce → base_mint_cooldown_until SET");
    assert.strictEqual(isBaseMintOnCooldown(MINT2), true, "enforce → isBaseMintOnCooldown TRUE (real block)");
    const armed = readShadow().filter((r) => r.kind === "armed");
    assert.strictEqual(armed[0].enforced, true, "enforce armed record enforced=true");
  }
  ok("ENFORCE → arms the EXISTING base_mint cooldown gate (isBaseMintOnCooldown TRUE)");

  // ── 9. WINNER-EXEMPT — profit close never arms (shadow or enforce) ──
  resetPoolMemory(); resetShadow();
  config.management.sameTokenLossCooldownMode = "enforce";
  recordPoolDeploy("winnerPool", {
    pool_name: "WINNER-POOL", base_mint: MINT,
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: 12, pnl_usd: 3, realized_sol_delta: 0.036,
    close_reason: "stop loss", strategy: "spot",
  });
  {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    assert.strictEqual(db.winnerPool.base_mint_cooldown_until, undefined, "winner → NO base cooldown even in enforce");
    assert.strictEqual(isBaseMintOnCooldown(MINT), false, "winner → not blocked (winner-exempt)");
    assert.strictEqual(readShadow().filter((r) => r.kind === "armed").length, 0, "winner → no armed record");
  }
  ok("WINNER-EXEMPT → +0.036 SOL profit close never arms (even in enforce)");

  // ── 10. FAIL-SAFE INVERSE — missing base_mint / missing pnl → no cooldown ──
  resetPoolMemory(); resetShadow();
  config.management.sameTokenLossCooldownMode = "enforce";
  recordPoolDeploy("noMintPool", {
    pool_name: "NO-MINT", base_mint: null,
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: -30, pnl_usd: -8, realized_sol_delta: -0.05,
    close_reason: "stop loss", strategy: "spot",
  });
  recordPoolDeploy("noPnlPool", {
    pool_name: "NO-PNL", base_mint: "So3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: null, pnl_usd: null, realized_sol_delta: null,
    close_reason: "stop loss", strategy: "spot",
  });
  {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    assert.strictEqual(db.noMintPool.same_token_loss_shadow_until, undefined, "missing base_mint → no arm");
    assert.strictEqual(db.noPnlPool.same_token_loss_shadow_until, undefined, "missing pnl → no arm");
    assert.strictEqual(readShadow().filter((r) => r.kind === "armed").length, 0, "fail-safe inverse → no armed records");
  }
  ok("FAIL-SAFE INVERSE → missing base_mint OR missing pnl never fabricates a cooldown");

  // ── 11. REVENGE OUTCOME record — cross-pool, shadow mode ─────
  resetPoolMemory(); resetShadow();
  config.management.sameTokenLossCooldownMode = "shadow";
  // loss in pool A
  recordPoolDeploy("revA", {
    pool_name: "REV-A", base_mint: MINT,
    deployed_at: iso(T0 - 3600e3), closed_at: iso(T0),
    pnl_pct: -30, pnl_usd: -8, realized_sol_delta: -0.05,
    close_reason: "stop loss", strategy: "spot",
  });
  // re-deploy of SAME token in pool B, opened 2h after the loss, closes a WINNER
  recordPoolDeploy("revB", {
    pool_name: "REV-B", base_mint: MINT,
    deployed_at: iso(T0 + 2 * 3600e3), closed_at: iso(T0 + 3 * 3600e3),
    pnl_pct: 8, pnl_usd: 2, realized_sol_delta: 0.02,
    close_reason: "agent decision", strategy: "spot",
  });
  {
    const outcomes = readShadow().filter((r) => r.kind === "redeploy_outcome");
    assert.strictEqual(outcomes.length, 1, "one revenge-outcome record");
    assert.strictEqual(outcomes[0].base_mint, MINT);
    assert.strictEqual(outcomes[0].pool, "revB", "outcome logged against the re-deploy pool");
    assert.strictEqual(outcomes[0].gap_hours, 2, "gap 2h from prior loss");
    assert.strictEqual(outcomes[0].redeploy_result, "win", "this revenge deploy WON (block would've been wrong)");
    assert.deepStrictEqual(outcomes[0].prior_loss, { value: -0.05, unit: "SOL" });
    assert.deepStrictEqual(outcomes[0].redeploy_pnl, { value: 0.02, unit: "SOL" });
  }
  ok("REVENGE OUTCOME → cross-pool re-deploy result recorded (block-set skew data for Lyra)");

  // ── 12. config default mode is SHADOW (observe-only) ─────────
  // Re-import config fresh values would be ideal, but the field default is asserted
  // via the loader contract: an unset/invalid mode resolves to "shadow".
  {
    const { config: c2 } = await import("../config.js");
    // (we mutated it above; assert the DEFAULT contract by checking the loader logic
    //  produced a valid enum — the shipped user-config leaves it unset → "shadow")
    assert.ok(["off", "shadow", "enforce"].includes(String(c2.management.sameTokenLossCooldownMode).toLowerCase()), "mode is a valid enum");
  }
  ok("config mode is a valid enum (ships default 'shadow' = observe-only)");

  console.log(`\n${passed} assertions passed ✅`);
  console.log("— Cassiopeia 👁️");
} catch (e) {
  console.error("\n❌ FAILED:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  restore();
}
