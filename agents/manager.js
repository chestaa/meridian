// Andromeda — Deterministic Manager (PR 4 of internal multi-agent refactor)
//
// Replaces the MANAGER `agentLoop` with deterministic code. Today's MANAGER
// already runs an LLM only after a deterministic rule (SL/TP/trailing/OOR/
// low-yield/instruction) has decided an action — the LLM mostly executes a
// lookup table. This module short-circuits the LLM and dispatches the same
// `close_position` / `claim_fees` tools directly through `executeTool`, so
// every safety check (account circuit breaker, balance, etc.) fires exactly
// as it does today.
//
// Why determinism here:
//   - SL / TP / Trailing / OOR / DRAWDOWN_RECOVERY / MAX_HOLD all live in
//     `state.js#updatePnlAndCheckExits` + `paper-trades.js#evaluatePaperExit`
//     (the latter is wired into `refreshPaperTrades` and runs independently).
//   - Rule 1–5 closes live in `getDeterministicCloseRule` (now exported from
//     index.js).
//   - The LLM's only contribution today is to call `close_position` /
//     `claim_fees` with the already-decided action. Removing it cuts cost,
//     latency, and hallucination risk on the money path.
//
// Feature flag: `config.internalAgents.managerDeterministic` (default OFF).
// When OFF, callers MUST fall through to the legacy LLM agentLoop path.
//
// Composition with Vega (PR-3):
//   Vega handles deploys (SCREENER cycle). Andromeda handles management
//   (MANAGER cycle). They share executeTool but operate on disjoint cycles
//   and disjoint tools — no interference. Both flags can be enabled
//   independently; both default OFF.
//
// Money invariants (must hold at all times):
//   - No LLM call inside this module.
//   - `close_position` is the only close entrypoint — never call
//     `closePosition` from dlmm.js directly (bypasses runSafetyChecks +
//     notifyClose + auto-swap + recordPerformance).
//   - INSTRUCTION-bearing positions are NOT auto-closed (deferred — they
//     need LLM semantic eval). Logged loudly so operator can intervene.
//   - TRAILING_TP signals with `needs_confirmation` are NOT closed inline.
//     They flow through the existing 15s recheck queue (preserved by the
//     caller in runManagementCycle, not by this module — see "Caller
//     responsibilities" below).
//   - Suspect PnL (rule guard in getDeterministicCloseRule) preserved.
//
// Caller responsibilities (in index.js#runManagementCycle):
//   - Pre-call: queuePeakConfirmation + queueTrailingDropConfirmation per
//     position (same as today). These are state-mutating and not deferred.
//   - Pre-call: invoke updatePnlAndCheckExits OUTSIDE this module first so
//     pending TRAILING_TP candidates get queued for 15s recheck. The
//     "confirmed" exits returned from updatePnlAndCheckExits on later
//     cycles are passed in as `exitMap`.
//   - Post-call: trigger post-management screening + OOR notifications
//     (same as today).
//
// This module is intentionally narrow: given a list of positions plus a
// pre-computed exit map (confirmed trailing TPs), it decides CLOSE/CLAIM/
// STAY/DEFERRED per position, dispatches the tool, and returns a summary.

import { config as defaultConfig } from "../config.js";
import { executeTool as defaultExecuteTool } from "../tools/executor.js";
import { getTrackedPosition } from "../state.js";
import { log } from "../logger.js";

// Test-only seam. Mirrors agents/vega.js __setExecuteToolForTests.
let _executeTool = defaultExecuteTool;
export function __setExecuteToolForTests(fn) {
  _executeTool = typeof fn === "function" ? fn : defaultExecuteTool;
}

/**
 * Whether the deterministic Manager is enabled.
 */
export function managerDeterministicEnabled(cfg = defaultConfig) {
  return Boolean(cfg?.internalAgents?.managerDeterministic);
}

/**
 * Replica of `getDeterministicCloseRule` from index.js — duplicated here to
 * keep this module decoupled from the index.js entrypoint (which pulls in
 * cron, REPL, telegram, etc.). Pure function; same precedence:
 *   Rule 1: stop loss
 *   Rule 2: take profit
 *   Rule 3: pumped far above range
 *   Rule 4: OOR > outOfRangeWaitMinutes
 *   Rule 5: low yield (age >= 60m)
 *
 * The pnlSuspect guard mirrors index.js: when PnL <= -90% but the position
 * still has real value, skip the PnL-based rules (Rule 1 + Rule 2) to avoid
 * a false stop loss on bad RPC data. Range + low-yield rules still fire.
 */
export function getDeterministicCloseRule(position, mgmtConfig, getTracked = getTrackedPosition) {
  const tracked = getTracked(position.position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= mgmtConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= mgmtConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + mgmtConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= mgmtConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

/**
 * Build per-position action decisions. Pure (no I/O, no tool calls).
 *
 * @param {Array} positions - From getMyPositions().positions
 * @param {Map<string, string>} exitMap - position_address → reason
 *   (from confirmed updatePnlAndCheckExits exits in the caller)
 * @param {Object} mgmtConfig - config.management
 * @returns {Map<string, {action, rule?, reason?}>}
 */
export function buildActionMap(positions, exitMap, mgmtConfig) {
  const actionMap = new Map();
  for (const p of positions) {
    // Confirmed exit signal — highest priority
    if (exitMap?.has(p.position)) {
      actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
      continue;
    }
    // Instruction-bearing positions need LLM semantic eval — defer.
    if (p.instruction) {
      actionMap.set(p.position, { action: "DEFERRED", reason: "instruction requires LLM eval" });
      continue;
    }
    const closeRule = getDeterministicCloseRule(p, mgmtConfig);
    if (closeRule) {
      actionMap.set(p.position, closeRule);
      continue;
    }
    if ((p.unclaimed_fees_usd ?? 0) >= mgmtConfig.minClaimAmount) {
      actionMap.set(p.position, { action: "CLAIM" });
      continue;
    }
    actionMap.set(p.position, { action: "STAY" });
  }
  return actionMap;
}

/**
 * Deterministic management cycle. Replaces the MANAGER agentLoop LLM call.
 *
 * @param {Object} context
 * @param {Array} context.positions - From getMyPositions().positions (live, force-refreshed)
 * @param {Map<string, string>} context.exitMap - Confirmed exits from
 *   updatePnlAndCheckExits (caller-built, includes trailing TP recheck path)
 * @param {Object} [context.mgmtConfig] - Defaults to config.management
 * @returns {Promise<{processed: number, closed: Array, claimed: Array, deferred: Array, stay: Array, errors: Array, actionMap: Map} | null>}
 *   Returns null when flag is OFF. Caller MUST fall through to legacy path.
 */
export async function runDeterministicManagement(context = {}) {
  if (!managerDeterministicEnabled()) return null;

  const positions = Array.isArray(context.positions) ? context.positions : [];
  const exitMap = context.exitMap instanceof Map ? context.exitMap : new Map();
  const mgmtConfig = context.mgmtConfig || defaultConfig.management;

  const actionMap = buildActionMap(positions, exitMap, mgmtConfig);

  const closed = [];
  const claimed = [];
  const deferred = [];
  const stay = [];
  const errors = [];

  for (const p of positions) {
    const decision = actionMap.get(p.position);
    if (!decision) continue;

    if (decision.action === "STAY") {
      stay.push({ position: p.position, pair: p.pair });
      continue;
    }

    if (decision.action === "DEFERRED") {
      // Loud log so operator notices unattended instruction positions.
      log(
        "manager_deterministic",
        `[MANAGER_DETERMINISTIC] DEFERRED ${p.pair} (${p.position}) — ${decision.reason}. Enable LLM path or evaluate instruction manually.`,
      );
      deferred.push({ position: p.position, pair: p.pair, reason: decision.reason });
      continue;
    }

    if (decision.action === "CLOSE") {
      const reasonLabel = decision.rule === "exit"
        ? `exit: ${decision.reason}`
        : `Rule ${decision.rule}: ${decision.reason}`;
      log("manager_deterministic", `[MANAGER_DETERMINISTIC] closing ${p.pair} (${p.position}) — ${reasonLabel}`);
      try {
        const result = await _executeTool("close_position", {
          position_address: p.position,
          reason: decision.reason,
        });
        if (result?.blocked) {
          errors.push({ position: p.position, pair: p.pair, action: "CLOSE", error: `blocked: ${result.reason}` });
          log("manager_deterministic", `[MANAGER_DETERMINISTIC] close blocked: ${p.pair} — ${result.reason}`);
        } else if (result?.error) {
          errors.push({ position: p.position, pair: p.pair, action: "CLOSE", error: result.error });
          log("manager_deterministic", `[MANAGER_DETERMINISTIC] close error: ${p.pair} — ${result.error}`);
        } else if (result?.success === false) {
          errors.push({ position: p.position, pair: p.pair, action: "CLOSE", error: result?.reason || "close returned success=false" });
          log("manager_deterministic", `[MANAGER_DETERMINISTIC] close returned success=false: ${p.pair}`);
        } else {
          closed.push({
            position: p.position,
            pair: p.pair,
            reason: decision.reason,
            rule: decision.rule,
            result,
          });
        }
      } catch (e) {
        errors.push({ position: p.position, pair: p.pair, action: "CLOSE", error: e.message });
        log("manager_deterministic", `[MANAGER_DETERMINISTIC] close threw: ${p.pair} — ${e.message}`);
      }
      continue;
    }

    if (decision.action === "CLAIM") {
      log("manager_deterministic", `[MANAGER_DETERMINISTIC] claiming ${p.pair} (${p.position}) — unclaimed_fees_usd=${p.unclaimed_fees_usd}`);
      try {
        const result = await _executeTool("claim_fees", { position_address: p.position });
        if (result?.blocked) {
          errors.push({ position: p.position, pair: p.pair, action: "CLAIM", error: `blocked: ${result.reason}` });
        } else if (result?.error) {
          errors.push({ position: p.position, pair: p.pair, action: "CLAIM", error: result.error });
        } else if (result?.success === false) {
          errors.push({ position: p.position, pair: p.pair, action: "CLAIM", error: result?.reason || "claim returned success=false" });
        } else {
          claimed.push({ position: p.position, pair: p.pair, result });
        }
      } catch (e) {
        errors.push({ position: p.position, pair: p.pair, action: "CLAIM", error: e.message });
        log("manager_deterministic", `[MANAGER_DETERMINISTIC] claim threw: ${p.pair} — ${e.message}`);
      }
      continue;
    }
  }

  log(
    "manager_deterministic",
    `[MANAGER_DETERMINISTIC] processed=${positions.length} closed=${closed.length} claimed=${claimed.length} deferred=${deferred.length} stay=${stay.length} errors=${errors.length}`,
  );

  return {
    processed: positions.length,
    closed,
    claimed,
    deferred,
    stay,
    errors,
    actionMap,
  };
}
