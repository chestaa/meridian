import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getTradeJournal } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  notifyBalanceDrain,
  isEnabled as telegramEnabled,
  createLiveMessage,
  markManualClose,
  isExecutiveMode,
  isMeaningfulReport,
} from "./telegram.js";
import { formatAgeIndo, formatPositionsMessage, formatTradeJournal } from "./telegram-display.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, markPartialTpDone } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { consumeKnownOutflowSol } from "./deploy-outflow-ledger.js";
import { recordPaperDeploy, refreshPaperTrades } from "./paper-trades.js";
import { getCircuitStatus, manualReset as circuitReset } from "./account-circuit-breaker.js";
import { judgeCandidates, formatOrionVerdicts } from "./agents/orion.js";
import { formatDeployReport, formatNoDeployReport, andromedaEnabled, formatScreeningTerse, formatDormantRollup, shouldNotifyScreeningCycle } from "./agents/andromeda.js";
import { deployFromOrionVerdict, vegaDeterministicDeployEnabled } from "./agents/vega.js";
import { runDeterministicManagement, managerDeterministicEnabled } from "./agents/manager.js";
import { rebalanceOnOor } from "./agents/rebalance.js";
import { buildDigest, formatExecutiveDigest, gatherDigestData } from "./digest.js";
import { execSync } from "child_process";
import fs from "fs";

// Vega fix #1 — single source for the exit DECISION PnL. Prefers the
// fee-inclusive net economic position (current value + fees − deposit, real IL
// embedded) over the SDK price-only pnl_pct, matching updatePnlAndCheckExits.
// Peak/trailing-drop confirmation MUST track the same metric as the exit
// evaluator, else peak (price) vs current (fee-inclusive) mismatch corrupts the
// trailing/drawdown deltas. FAIL-SAFE: missing fee-inclusive → reported pnl_pct.
function decisionPnlPct(p) {
  if (!p) return null;
  if (
    config.internalAgents?.feeInclusiveExitEnabled !== false &&
    p.pnl_pct_fee_inclusive != null &&
    Number.isFinite(Number(p.pnl_pct_fee_inclusive))
  ) {
    return Number(p.pnl_pct_fee_inclusive);
  }
  return p.pnl_pct ?? null;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
// Sirius dormant-cycle throttle: count consecutive routine no-deploy cycles so we
// emit one rollup notif instead of beronding Bro every 15 min. Reset on deploy.
let _dormantStreak = 0;
let _dormantDominantReason = null;
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management

// ─── Burner balance-drain monitor (Sirius Pillar B fix #4) ───────
// Sampled at the start of each management cycle. If sample-to-sample drop
// exceeds BALANCE_DRAIN_THRESHOLD_PCT (only meaningful when samples are
// within BALANCE_DRAIN_WINDOW_MS of each other, i.e. ~1h), fire alert.
// Read-only: uses existing getWalletBalances() — Vega's wallet code untouched.
const BALANCE_DRAIN_THRESHOLD_PCT = 20; // alert when SOL drops > this %
const BALANCE_DRAIN_WINDOW_MS = 60 * 60 * 1000; // 1h sample window
// A drop this large is treated as "catastrophic / likely drain" and REQUIRES a
// confirming second read before any alert fires (defends against Helius blips
// that previously returned sentinel 0 → phantom 100% drain).
const BALANCE_DRAIN_CONFIRM_PCT = 90;
let _lastBalanceSample = null; // { sol: number, at: ms }
// Test-only seams for the drain monitor (production never calls these).
export function __setLastBalanceSampleForTest(sample) { _lastBalanceSample = sample; }
export function __getLastBalanceSampleForTest() { return _lastBalanceSample; }

/**
 * Pure decision core for the burner balance-drain monitor (Vega money-path
 * balance-read integrity). Decides what to do with a freshly-read balance sample
 * GIVEN the previous sample. No I/O, no clock — fully unit-testable.
 *
 * Returns one of:
 *   { action: "skip" }                         — read failed/unknown; do nothing,
 *                                                 do NOT even store (a bad read must
 *                                                 never become the next baseline).
 *   { action: "store" }                         — usable read, no alert-worthy drop;
 *                                                 caller stores it as new baseline.
 *   { action: "confirm", dropPct, prevSol, solNow }
 *                                                 — drop >= CONFIRM_PCT; caller MUST
 *                                                 re-read and confirm before alerting.
 *   { action: "alert", dropPct, prevSol, solNow }
 *                                                 — drop in (THRESHOLD, CONFIRM); fire
 *                                                 directly (still store new baseline).
 *
 * Hard rules:
 *  - balSnap.error OR sol == null OR non-finite  → skip (no compute, no store).
 *  - solNow must be > 0 to ever compute a drop  → a 0/sentinel read can NEVER
 *    produce a 100% drop (defends the phantom-drain class of bug at the math layer
 *    too, belt-and-suspenders with the wallet.js sol:null fix).
 *
 * DEPLOY-AWARE (Vega honesty-audit 2026-06-21 FIX #2): opts.knownOutflowSol is the
 * SOL that a recently-successful deploy moved out of the wallet into the LP (a
 * KNOWN, EXPECTED outflow, NOT a drain). We credit it back into the observed
 * balance before computing the drop, so a fall fully explained by a deploy is not
 * flagged. Only the portion of the drop NOT explained by the known outflow is
 * measured — a real drain occurring alongside a deploy is STILL caught. The credit
 * never raises the effective balance above the previous baseline (clamped), so it
 * cannot manufacture a fake gain.
 */
export function decideBalanceDrainAction(prev, balSnap, now, opts = {}) {
  const windowMs = opts.windowMs ?? BALANCE_DRAIN_WINDOW_MS;
  const thresholdPct = opts.thresholdPct ?? BALANCE_DRAIN_THRESHOLD_PCT;
  const confirmPct = opts.confirmPct ?? BALANCE_DRAIN_CONFIRM_PCT;
  const knownOutflowSol = Number(opts.knownOutflowSol) > 0 ? Number(opts.knownOutflowSol) : 0;

  // 1) Reject unreadable samples outright — never store, never compute.
  if (!balSnap || balSnap.error === true) return { action: "skip", reason: "read_error" };
  const solNow = Number(balSnap.sol);
  if (balSnap.sol == null || !Number.isFinite(solNow)) return { action: "skip", reason: "sol_unknown" };

  // 2) No usable previous baseline → just store this one.
  if (!prev || !Number.isFinite(prev.sol) || prev.sol <= 0 || (now - prev.at) > windowMs) {
    return { action: "store" };
  }

  // 2b) Deploy-aware: credit the known deploy outflow back into the observed
  //     balance so the EXPECTED drop is not counted as a drain. Clamp to the prior
  //     baseline so a credit can never fabricate a gain. The drop is then measured
  //     against this adjusted figure — any drop BEYOND the known deploy still counts.
  const adjustedSolNow = Math.min(prev.sol, solNow + knownOutflowSol);

  // 3) Guard solNow > 0 so a 0-read can never compute a 100% drop. A 0 read that
  //    survived the error checks is a genuine empty wallet — that is a real (but
  //    not necessarily drain-shaped) state; treat as confirm-worthy below via pct.
  const dropPct = ((prev.sol - adjustedSolNow) / prev.sol) * 100;
  if (dropPct <= thresholdPct) {
    // Store the TRUE observed balance (not the adjusted one) as the new baseline —
    // the modal really did leave the wallet, so the next cycle compares against the
    // real post-deploy balance.
    return { action: "store", dropPct };
  }
  if (dropPct >= confirmPct) {
    return { action: "confirm", dropPct, prevSol: prev.sol, solNow };
  }
  return { action: "alert", dropPct, prevSol: prev.sol, solNow };
}

/**
 * Runs the drain monitor for one sample. Side-effecting orchestrator around the
 * pure decision core. The second-read fetcher is injectable for tests.
 *
 * @param {object} balSnap   freshly-read balance snapshot (from getWalletBalances)
 * @param {object} deps      { now, secondRead, fireAlert, store } — all optional
 * @returns {Promise<object>} the resolved decision (for tests/observability)
 */
export async function runBalanceDrainMonitor(balSnap, deps = {}) {
  const now = deps.now ?? Date.now();
  const secondRead = deps.secondRead ?? getWalletBalances;
  const fireAlert = deps.fireAlert ?? ((prevSol, solNow, dropPct) =>
    notifyBalanceDrain(prevSol, solNow, dropPct).catch((e) =>
      log("balance_drain_error", `notifyBalanceDrain failed: ${e.message}`)));
  const store = deps.store ?? ((sample) => { _lastBalanceSample = sample; });

  // Deploy-aware (FIX #2): consume any recently-recorded deploy outflow so an
  // EXPECTED wallet drop (modal → LP) is credited and not flagged as a drain. The
  // ledger expires entries on its own window, so a stale deploy can't suppress a
  // later real drain. Injectable for tests.
  const windowMs = deps.opts?.windowMs ?? BALANCE_DRAIN_WINDOW_MS;
  const knownOutflowSol = deps.knownOutflowSol != null
    ? Number(deps.knownOutflowSol)
    : consumeKnownOutflowSol(now, windowMs);
  const mergedOpts = { ...(deps.opts || {}), knownOutflowSol };

  const decision = decideBalanceDrainAction(_lastBalanceSample, balSnap, now, mergedOpts);

  if (decision.action === "skip") {
    log("balance_drain_warn", `Balance sample skipped (${decision.reason}) — not stored, no compute`);
    return decision;
  }

  if (decision.action === "store") {
    store({ sol: Number(balSnap.sol), at: now });
    return decision;
  }

  if (decision.action === "alert") {
    log("balance_drain", `Detected burner drop: ${decision.prevSol.toFixed(4)} → ${decision.solNow.toFixed(4)} SOL (${decision.dropPct.toFixed(2)}%)`);
    await fireAlert(decision.prevSol, decision.solNow, decision.dropPct);
    store({ sol: decision.solNow, at: now });
    return decision;
  }

  // action === "confirm" — catastrophic drop. REQUIRE a confirming second read
  // before alerting. If the second read shows the balance intact (or is itself
  // unreadable), this was a blip → SKIP the alert. Only a SECOND consecutive
  // real-drain read fires. We do NOT update the baseline off the confirm sample
  // here unless confirmed, so a transient bad reading can't poison it.
  let second;
  try {
    second = await secondRead();
  } catch (e) {
    log("balance_drain_warn", `Drain confirm second-read failed: ${e.message} — treating as blip, no alert`);
    return { ...decision, action: "skip", reason: "second_read_error" };
  }
  const secondSol = Number(second?.sol);
  if (!second || second.error === true || second.sol == null || !Number.isFinite(secondSol) || secondSol <= 0) {
    log("balance_drain_warn", `Drain confirm second-read unusable (sol=${second?.sol}) — treating as blip, no alert`);
    return { ...decision, action: "skip", reason: "second_read_unusable" };
  }
  const confirmDropPct = ((decision.prevSol - secondSol) / decision.prevSol) * 100;
  if (confirmDropPct >= (deps.opts?.confirmPct ?? BALANCE_DRAIN_CONFIRM_PCT) - 1) {
    // Second read AGREES the balance really collapsed → real drain, fire.
    log("balance_drain", `CONFIRMED burner drop across two reads: ${decision.prevSol.toFixed(4)} → ${secondSol.toFixed(4)} SOL (${confirmDropPct.toFixed(2)}%)`);
    await fireAlert(decision.prevSol, secondSol, confirmDropPct);
    store({ sol: secondSol, at: now });
    return { ...decision, action: "alert", confirmed: true, solNow: secondSol, dropPct: confirmDropPct };
  }
  // Second read shows balance intact → it was a blip. Store the GOOD reading.
  log("balance_drain_warn", `Drain not confirmed by second read (now ${secondSol.toFixed(4)} SOL, drop ${confirmDropPct.toFixed(2)}%) — phantom blip suppressed`);
  store({ sol: secondSol, at: now });
  return { ...decision, action: "skip", reason: "not_confirmed_by_second_read", solNow: secondSol };
}
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

function screeningCooldownMs() {
  return Math.max(60_000, (config.schedule.screeningIntervalMin || 5) * 60 * 1000);
}

function shouldTriggerScreening() {
  return !_screeningBusy && Date.now() - _screeningLastTriggered > screeningCooldownMs();
}

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, decisionPnlPct(position), TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        decisionPnlPct(position),
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  try {
    // ── Burner balance-drain sample (Sirius Pillar B fix #4) ───────
    // READ-only: reuses existing getWalletBalances(). Compares to previous
    // sample taken within BALANCE_DRAIN_WINDOW_MS. Fires Telegram alert if
    // SOL dropped > BALANCE_DRAIN_THRESHOLD_PCT. Throttled inside the
    // notify helper (1h cooldown).
    try {
      const balSnap = await getWalletBalances();
      // Drain decision + (for catastrophic drops) confirming second-read are now
      // handled by runBalanceDrainMonitor. A failed/unknown read is SKIPPED (never
      // stored, never computed), and a >90% "drain" only alerts if a second read
      // agrees — killing the phantom-drain-from-Helius-blip class entirely.
      await runBalanceDrainMonitor(balSnap);
    } catch (e) {
      log("balance_drain_warn", `Balance sample failed: ${e.message}`);
    }

    await refreshPaperTrades().catch((error) => log("paper_warn", `Paper trade refresh failed: ${error.message}`));
    if (!silent && telegramEnabled() && !isExecutiveMode()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      if (shouldTriggerScreening()) {
        log("cron", "No open positions — triggering screening cycle");
        mgmtReport = "No open positions. Triggering screening cycle.";
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      } else {
        log("cron", "No open positions — screening already running or cooling down");
        mgmtReport = "No open positions. Screening already running or cooling down.";
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, decisionPnlPct(p), { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        // Vega Item 2B — PARTIAL_TP is NOT a close. Execute the partial pull
        // inline (keeps account open), mark done so it fires ONCE, and do NOT
        // add to exitMap — the remainder keeps running with trailing.
        // Fail-safe: any error → leave the position fully open + monitored
        // (never close on a failed partial), surface in mgmt report next cycle.
        if (exit.action === "PARTIAL_TP") {
          try {
            const partialRes = await executeTool("partial_close_position", {
              position_address: p.position,
              pct: exit.partial_pct,
              reason: exit.reason,
            });
            if (partialRes?.blocked || partialRes?.error || partialRes?.success === false) {
              log("state", `Partial TP for ${p.pair} did not execute: ${partialRes?.reason || partialRes?.error || "failed"} — position stays fully open + monitored`);
            } else {
              // Only flip the idempotency flag after a confirmed (or dry-run) partial.
              markPartialTpDone(p.position);
              log("state", `Partial TP executed for ${p.pair}: ${exit.reason}`);
            }
          } catch (e) {
            log("state", `Partial TP threw for ${p.pair}: ${e.message} — position stays fully open + monitored`);
          }
          continue; // partial does not end the position; keep monitoring
        }
        // Vega Item 9 — REBALANCE_OOR (gated OFF by default). When the operator
        // has opted in (flag on, organic >= threshold, under maxRebalances), a
        // high-organic OOR position is RE-CENTERED instead of hard-closed:
        // pull 100% + re-deploy same/less capital on the current active bin so
        // it keeps earning fees. Executed inline via agents/rebalance.js, which
        // composes the audited close_position + deploy_position entrypoints
        // (hardcap + circuit breaker enforced unchanged).
        //
        // Fail-safe: rebalanceOnOor NEVER leaves a position open + unmanaged.
        //   - "rebalanced"      → new centered position is live; nothing to do.
        //   - "closed_*"        → position already closed (capital safe).
        //   - "closed_error" w/ position still open (pre-close failure) → push
        //     into exitMap so the existing close path hard-closes it this cycle.
        if (exit.action === "REBALANCE_OOR") {
          try {
            const rb = await rebalanceOnOor({
              position: p,
              exit,
              mgmtConfig: config.management,
              strategyConfig: config.strategy,
            });
            if (rb?.outcome === "rebalanced") {
              log("state", `Re-centered ${p.pair}: ${exit.reason} → new ${String(rb.new_position).slice(0, 8)} @ bin ${rb.active_bin}, ${rb.amount_sol} SOL (rebalance #${rb.rebalance_count})`);
              continue; // position re-centered + live; not a close
            }
            if (rb?.redeployed === false && rb?.outcome === "closed_error" && rb?.error) {
              // Pre-close failure — position may still be open. Guarantee it is
              // managed this cycle by routing through the hard-close path.
              log("state", `REBALANCE_OOR for ${p.pair} could not execute (${rb.error}) — hard-closing to keep position managed.`);
              exitMap.set(p.position, `OOR (re-center failed, hard close fallback): ${exit.reason}`);
              continue;
            }
            // Any other "closed_*" outcome → position already closed by the
            // orchestrator (friction skip or post-close fallback). Done.
            log("state", `REBALANCE_OOR for ${p.pair} resolved as ${rb?.outcome} (capital safe, position closed). ${rb?.reason || ""}`);
            continue;
          } catch (e) {
            // Defensive: orchestrator should never throw, but if it does, fall
            // back to the legacy hard close so the OOR position is never left
            // unmanaged.
            log("cron_error", `rebalanceOnOor threw for ${p.pair}: ${e.message} — failing safe to hard close.`);
            exitMap.set(p.position, `OOR (re-center threw, hard close fallback): ${exit.reason}`);
            continue;
          }
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    // ─── Andromeda PR-4 — Deterministic manager path (flag-gated, default OFF) ──
    // When `config.internalAgents.managerDeterministic === true`, skip the
    // MANAGER agentLoop LLM call entirely and dispatch close_position /
    // claim_fees directly through executeTool. All safety checks
    // (runSafetyChecks, account circuit breaker, notifyClose, auto-swap)
    // fire as normal — only the LLM intermediary is removed.
    //
    // INSTRUCTION-bearing positions are deferred (logged, not auto-closed).
    // Operator must enable LLM path or evaluate manually.
    //
    // Note: exitMap (confirmed trailing-TP exits and direct SL/TP/OOR exits
    // returned by updatePnlAndCheckExits earlier in this cycle) is passed
    // through unchanged — same precedence as the LLM path.
    if (managerDeterministicEnabled(config) && actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) — deterministic manager (flag ON, no LLM)`);
      const detResult = await runDeterministicManagement({
        positions: positionData,
        exitMap,
        mgmtConfig: config.management,
      });
      if (detResult) {
        const lines = [];
        for (const c of detResult.closed) {
          lines.push(`Closed ${c.pair}: ${c.reason} (rule ${c.rule})`);
        }
        for (const c of detResult.claimed) {
          lines.push(`Claimed fees ${c.pair}`);
        }
        for (const d of detResult.deferred) {
          lines.push(`Deferred ${d.pair}: ${d.reason} (instruction needs LLM — toggle flag OFF or evaluate manually)`);
        }
        for (const e of detResult.errors) {
          lines.push(`ERROR ${e.action} ${e.pair}: ${e.error}`);
        }
        if (lines.length > 0) mgmtReport += `\n\n${lines.join("\n")}`;
        await liveMessage?.note(`Deterministic manager: closed=${detResult.closed.length} claimed=${detResult.claimed.length} deferred=${detResult.deferred.length} errors=${detResult.errors.length}`);
      }
      // Post-management screening trigger (mirrors legacy tail)
      const afterPositions = await getMyPositions({ force: true }).catch(() => null);
      const afterCount = afterPositions?.positions?.length ?? 0;
      if (afterCount < config.risk.maxPositions && shouldTriggerScreening()) {
        log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
      return mgmtReport;
    }

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", null, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && shouldTriggerScreening()) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        // HOTFIX-5: Executive mode silences cycle-header noise + boilerplate,
        // but ALLOWS Orion verdict text (DEPLOY / NO DEPLOY / close-decision).
        // Legacy (non-exec) mode: fires every report as before.
        else {
          const stripped = stripThink(mgmtReport);
          if (!isExecutiveMode() || isMeaningfulReport(stripped)) {
            sendMessage(`🔄 Management Cycle\n\n${stripped}`).catch(() => { });
          }
        }
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range, positionId: p.position || p.pair }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  // Sirius terse-notif funnel state (function-scope so the `finally` send block
  // can render the 2–5 line summary). Verbose `screenReport` stays the audit
  // record; this drives ONLY the Telegram message to Bro.
  const funnel = { universe: null, passed: 0, deployed: false, poolName: null, amountSol: null, reason: null, skipped: false, skipReason: null, failed: false };
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    // FAIL-CLOSED (Vega): unknown balance (sol:null on a failed read) must SKIP
    // the live screening cycle, not proceed. `null < minRequired` is falsy, so the
    // plain `<` check below would FAIL OPEN — screening would run (and could reach
    // a deploy) on an unknown balance. Refuse instead; a blip just defers one cycle.
    if (!isDryRun && (preBalance?.error || preBalance?.sol == null || !Number.isFinite(Number(preBalance.sol)))) {
      log("cron", `Screening skipped — wallet balance unreadable (${preBalance?.error_message || "no sol value"})`);
      screenReport = `Screening skipped — wallet balance unreadable; will retry next cycle.`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Wallet balance unreadable (${preBalance?.error_message || "no sol value"})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled() && !isExecutiveMode()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    // Funnel baseline for the terse notif: raw universe scanned this cycle.
    funnel.universe = topCandidates?.total_universe ?? topCandidates?.total_screened ?? null;

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    funnel.passed = passing.length;

    if (passing.length === 0) {
      // Terse notif: "ga ada kandidat lolos" (universe → 0 lolos). The single
      // most-common rejection reason (if any) drives the plain phrase.
      funnel.reason = filteredOut[0]?.reason || earlyFilteredExamples[0]?.reason || "no candidates";
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        funnel.reason = skipReason;
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // ─── Orion-int (LLM Judge) — pre-judgment pass before the fat screener loop ──
    // Feature-flagged. Disable via user-config.internalAgents.orionEnabled=false.
    let orionVerdicts = [];
    let orionBlock = null;
    const orionEnabled = config.internalAgents?.orionEnabled !== false;
    if (orionEnabled) {
      try {
        orionVerdicts = await judgeCandidates(passing, {
          portfolio: preBalance,
          positions: prePositions,
        });
        orionBlock = formatOrionVerdicts(orionVerdicts);
      } catch (e) {
        log("cron_error", `Orion judge failed (non-fatal): ${e.message}`);
        orionVerdicts = [];
        orionBlock = null;
      }
    }

    // ─── Vega PR-3 — Deterministic deploy path (flag-gated, default OFF) ──
    // When `config.internalAgents.vegaDeterministicDeploy === true` AND Orion
    // produced at least one ENTER verdict that clears the live confidence
    // floor, skip the fat LLM agentLoop entirely and call deploy_position
    // directly through executeTool (all safety checks still fire).
    // Falls through to legacy SCREENER agentLoop on:
    //   - flag off (default)
    //   - Orion disabled or returned no ENTER verdicts
    //   - Vega declines (null) due to bad volatility / missing pool
    if (vegaDeterministicDeployEnabled(config)) {
      const liveMinConf = (config.dryRun === false && config.liveOverrides?.orionMinConfidence) ?? 0;
      const enterVerdicts = (orionVerdicts || [])
        .filter((v) => v.decision === "enter" && Number(v.confidence ?? 0) >= liveMinConf)
        .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
      const candidateByPoolVega = new Map(passing.map((c) => [c.pool.pool, c]));

      let vegaDeployResult = null;
      let vegaDeployedVerdict = null;
      let vegaDeployedCandidate = null;

      for (const verdict of enterVerdicts) {
        const candidate = candidateByPoolVega.get(verdict.pool_address);
        if (!candidate) continue;
        const outcome = await deployFromOrionVerdict(verdict, candidate, { walletSol: preBalance.sol });
        if (outcome == null) continue; // Vega declined — try next ENTER (or fall through)
        if (outcome.deployed) {
          vegaDeployResult = outcome.result;
          vegaDeployedVerdict = verdict;
          vegaDeployedCandidate = candidate;
          // Paper-trade recording (mirrors legacy onToolFinish path) so DRY_RUN
          // equivalence holds — paper-trade equivalence is the success criterion
          // for this PR.
          if (process.env.DRY_RUN === "true" && outcome.result?.would_deploy?.pool_address) {
            const pool = candidate?.pool || {};
            const ti = candidate?.ti || {};
            recordPaperDeploy({
              pool_address: outcome.result.would_deploy.pool_address,
              pool_name: pool.name || outcome.result.would_deploy.pool_address,
              base_mint: pool.base?.mint || ti.mint || null,
              strategy: outcome.result.would_deploy.strategy,
              amount_sol: outcome.result.would_deploy.amount_y ?? outcome.result.would_deploy.amount_sol ?? null,
              active_bin: pool.active_bin ?? null,
              bins_below: outcome.result.would_deploy.bins_below,
              bins_above: outcome.result.would_deploy.bins_above,
              entry_price: pool.price ?? null,
              entry_fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
              entry_volume: pool.volume_window ?? null,
              entry_tvl: pool.tvl ?? pool.active_tvl ?? null,
              entry_volatility: pool.volatility ?? null,
              entry_age_hours: pool.token_age_hours ?? null,
              entry_top10_pct: ti.audit?.top_holders_pct ?? null,
              entry_bot_pct: ti.audit?.bot_holders_pct ?? null,
              entry_bundle_pct: pool.bundle_pct ?? null,
              entry_sniper_pct: pool.sniper_pct ?? null,
              // Andromeda Track-A — propagate Vega's two-sided paper record
              // (null for single-side) so the trade takes the two-asset exit path.
              two_sided: outcome.result.would_deploy.two_sided === true,
              two_sided_paper: outcome.result.two_sided_paper ?? null,
            });
          }
          break;
        }
        // outcome.deployed === false — safety check blocked or impl failed.
        // Log + try the next ENTER candidate. Anti-pattern #4: no retry of
        // the same pool; we move on to the next-best confidence verdict.
        log(
          "cron",
          `[VEGA_DETERMINISTIC] deploy declined for ${verdict.pool_address?.slice(0, 8)}: ${outcome.error}`,
        );
      }

      // Vega owns the report path when it ran (regardless of deploy outcome).
      // If Vega declined every ENTER without dispatching, we still surface a
      // no-deploy report — the LLM agentLoop is skipped entirely under this flag.
      if (vegaDeployResult) {
        funnel.deployed = true;
        funnel.poolName = vegaDeployResult.pool_name || vegaDeployedCandidate?.pool?.name
          || vegaDeployResult.would_deploy?.pool_address || vegaDeployResult.pool || null;
        funnel.amountSol = vegaDeployResult.amount_y ?? vegaDeployResult.would_deploy?.amount_y
          ?? vegaDeployResult.would_deploy?.amount_sol ?? null;
        screenReport = formatDeployReport({
          deployResult: vegaDeployResult,
          candidate: vegaDeployedCandidate,
          orionVerdict: vegaDeployedVerdict,
        });
      } else {
        funnel.reason = enterVerdicts.length === 0 ? "judge no enter" : "judge skip";
        const verdictByPool = new Map((orionVerdicts || []).map((v) => [v.pool_address, v]));
        const rejectedCandidates = passing.map((c) => ({
          pool: c.pool,
          reason: verdictByPool.get(c.pool?.pool)?.reason || "did not qualify",
        }));
        screenReport = formatNoDeployReport({
          rejectedCandidates,
          reason: enterVerdicts.length === 0
            ? "Orion produced no ENTER verdicts above the live confidence floor."
            : "Vega declined every ENTER verdict (safety guard or stale snapshot).",
        });
        appendDecision({
          type: "no_deploy",
          actor: "VEGA",
          summary: "Vega deterministic path produced no deploy",
          reason: enterVerdicts.length === 0 ? "no Orion ENTER verdicts" : "Vega declined all ENTERs",
        });
      }
      return screenReport;
    }

    // Orion cost fix (2026-06-01) — cap the candidate list shown to the LLM.
    // `passing` is already score-ordered from the top-10 discovery slice; sending all
    // of them (each with up to 500-char narrative + 500-char memory) is the main driver
    // of the 6k+ prompt-token bloat that escalated screening into the v4-pro premium tier.
    // Top-5 keeps the highest-conviction candidates while bounding prompt size. Reporting
    // (rejectedCandidates) still uses the full `passing` list below.
    const PROMPT_CANDIDATE_CAP = config.llm.screeningPromptCandidateCap ?? 5;
    const promptCandidates = passing.slice(0, PROMPT_CANDIDATE_CAP);

    // Pre-fetch active_bin for prompt candidates in parallel
    const activeBinResults = await Promise.allSettled(
      promptCandidates.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = promptCandidates.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 240)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 240)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        stageSignals(pool.pool, {
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;
    const candidateByPool = new Map(passing.map((candidate) => [candidate.pool.pool, candidate]));

    let deployAttempted = false;
    let deploySucceeded = false;
    let lastDeployResult = null;
    let lastDeployPoolAddress = null;
    const deployHeader = process.env.DRY_RUN === "true" ? "SIMULATED DEPLOY" : "DEPLOYED";
    const andromedaOn = andromedaEnabled(config);

    // PR 2: when Andromeda is enabled, the LLM no longer renders the Telegram
    // report — index.js calls formatDeployReport directly after the tool call.
    // The LLM goal therefore drops the giant template and just demands a
    // tool-call + a one-line ACK. When disabled, fall through to legacy.
    const legacyReportSteps = `STEPS:
DRY_RUN REPORTING RULE:
If DRY_RUN is true and deploy_position returns dry_run/would_deploy, write SIMULATED DEPLOY instead of DEPLOYED. Never imply a real on-chain deployment happened during dry-run.

0. All enrichment is already in the candidate blocks above. Do NOT re-fetch, verify, or double-check anything — decide on the data shown.
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.`;

    const terseReportSteps = `STEPS (Andromeda renders the Telegram report — do NOT render it yourself):
0. All enrichment is already in the candidate blocks above. Do NOT re-fetch, verify, or double-check anything — decide on the data shown.
1. Decide if any candidate is worth deploying. One surviving candidate is not automatically good enough.
2. Pick the highest-conviction candidate (narrative + smart wallets + pool metrics + Orion verdict).
3. Call deploy_position with active_bin pre-fetched. bins_below = round(${config.strategy.minBinsBelow} + (volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}]. Pass deploy_position.volatility = candidate volatility. amount_y only, amount_x=0, bins_above=0.
4. Reply with ONE LINE only:
   - On successful tool call:  OK <pool_address>
   - On skip / no-deploy:       SKIP <pool_address_or_none> <short_reason>
   Do NOT render the Telegram report — index.js + Andromeda will format the user-facing message from the tool result.`;

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${Number.isFinite(Number(currentBalance.sol)) ? Number(currentBalance.sol).toFixed(3) : "unknown"} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (top ${promptCandidates.length} of ${passing.length} by score):
${candidateBlocks.join("\n\n")}
${orionBlock ? `\nORION PRE-JUDGMENT (advisory — you may override):\n${orionBlock}\n` : ""}
${andromedaOn ? terseReportSteps : legacyReportSteps}
      `, config.llm.screeningMaxSteps ?? config.llm.maxSteps, [], "SCREENER", null, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
            if (deploySucceeded) {
              lastDeployResult = result;
              lastDeployPoolAddress = result?.pool || result?.would_deploy?.pool_address || null;
            }
            if (process.env.DRY_RUN === "true" && result?.would_deploy?.pool_address) {
              const candidate = candidateByPool.get(result.would_deploy.pool_address);
              const pool = candidate?.pool || {};
              const ti = candidate?.ti || {};
              recordPaperDeploy({
                pool_address: result.would_deploy.pool_address,
                pool_name: pool.name || result.would_deploy.pool_address,
                base_mint: pool.base?.mint || ti.mint || null,
                strategy: result.would_deploy.strategy,
                amount_sol: result.would_deploy.amount_y ?? result.would_deploy.amount_sol ?? deployAmount,
                active_bin: pool.active_bin ?? null,
                bins_below: result.would_deploy.bins_below,
                bins_above: result.would_deploy.bins_above,
                entry_price: pool.price ?? null,
                entry_fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
                entry_volume: pool.volume_window ?? null,
                entry_tvl: pool.tvl ?? pool.active_tvl ?? null,
                entry_volatility: pool.volatility ?? null,
                entry_age_hours: pool.token_age_hours ?? null,
                entry_top10_pct: ti.audit?.top_holders_pct ?? null,
                entry_bot_pct: ti.audit?.bot_holders_pct ?? null,
                entry_bundle_pct: pool.bundle_pct ?? null,
                entry_sniper_pct: pool.sniper_pct ?? null,
                // Andromeda Track-A — propagate Vega's two-sided paper record
                // (null for single-side) so the trade takes the two-asset exit path.
                two_sided: result.would_deploy.two_sided === true,
                two_sided_paper: result.two_sided_paper ?? null,
              });
            }
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    if (andromedaOn) {
      // PR 2: index.js owns the report — Andromeda renders, LLM only signaled.
      if (deploySucceeded && lastDeployResult) {
        const candidate = candidateByPool.get(lastDeployPoolAddress);
        const orionVerdict = Array.isArray(orionVerdicts)
          ? orionVerdicts.find((v) => v.pool_address === lastDeployPoolAddress) || null
          : null;
        funnel.deployed = true;
        funnel.poolName = lastDeployResult.pool_name || candidate?.pool?.name
          || lastDeployResult.would_deploy?.pool_address || lastDeployResult.pool || null;
        funnel.amountSol = lastDeployResult.amount_y ?? lastDeployResult.would_deploy?.amount_y
          ?? lastDeployResult.would_deploy?.amount_sol ?? null;
        screenReport = formatDeployReport({ deployResult: lastDeployResult, candidate, orionVerdict });
      } else {
        // No deploy: synthesize a reject list from Orion skips (advisory) +
        // surviving candidates. LLM ACK content is preserved in decision-log.
        const verdictByPool = new Map((orionVerdicts || []).map((v) => [v.pool_address, v]));
        const rejectedCandidates = passing.map((c) => ({
          pool: c.pool,
          reason: verdictByPool.get(c.pool?.pool)?.reason || "did not qualify",
        }));
        const reason = stripThink(content || "").trim().slice(0, 400) || null;
        // Terse-notif reason: prefer the top Orion verdict reason (most specific)
        // over the freeform LLM ACK, which is often a full sentence.
        funnel.reason = rejectedCandidates[0]?.reason || reason || "no enter";
        screenReport = formatNoDeployReport({ rejectedCandidates, reason });
      }
    } else {
      // Legacy (non-Andromeda) LLM-rendered report. Derive terse funnel from
      // the deploy signal — full LLM content stays the audit record.
      if (deploySucceeded) {
        funnel.deployed = true;
        funnel.poolName = lastDeployResult?.pool_name
          || candidateByPool.get(lastDeployPoolAddress)?.pool?.name
          || lastDeployPoolAddress || null;
        funnel.amountSol = lastDeployResult?.amount_y ?? lastDeployResult?.would_deploy?.amount_y
          ?? lastDeployResult?.would_deploy?.amount_sol ?? null;
      } else {
        funnel.reason = (orionVerdicts || [])[0]?.reason || "no enter";
      }
      screenReport = process.env.DRY_RUN === "true"
        ? content.replace(/^[^\n]*DEPLOYED/m, deployHeader)
        : content;
    }
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
    funnel.failed = true;
    funnel.reason = error.message;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      // Sirius terse-notif: Bro reads 2–5 lines only. We send the collapsed
      // funnel summary instead of the verbose report. The verbose report is
      // already persisted (decision-log + log files) for Lyra's audit. The
      // funnel ran if we reached candidate discovery (universe set) OR a deploy
      // landed OR the cycle threw. Pre-check skips (max positions / balance /
      // insufficient SOL) never touch the funnel → keep the legacy verbose-but-
      // exec-silenced path so they stay quiet in executive mode as before.
      const funnelRan = funnel.universe != null || funnel.deployed || funnel.failed;
      if (funnelRan) {
        // Sirius spam-control: maintain the dormant streak, then let
        // shouldNotifyScreeningCycle decide whether Bro hears about this cycle.
        // DEPLOY + material (circuit/error/infra) always notify; routine dormant
        // no-deploy is suppressed and surfaced as one rollup every Nth cycle.
        if (funnel.deployed) {
          _dormantStreak = 0;
          _dormantDominantReason = null;
        } else {
          _dormantStreak += 1;
          _dormantDominantReason = funnel.reason || _dormantDominantReason;
        }
        const notifyDormant = config.internalAgents?.notifyDormantCycles === true;
        const rollupEvery = Number(config.internalAgents?.dormantRollupEvery) || 8;
        const decision = shouldNotifyScreeningCycle(funnel, {
          notifyDormant,
          dormantStreak: _dormantStreak,
          rollupEvery,
        });
        const terse = decision.kind === "rollup"
          ? formatDormantRollup({ count: _dormantStreak, dominantReason: _dormantDominantReason })
          : formatScreeningTerse(funnel);
        // finalizeTerse REPLACES the whole live message (drops the tool-step echo
        // that finalize() would leave above the footer) → true 2–5 line notif.
        // When suppressing a dormant cycle we still finalize the live message so
        // it doesn't dangle, but we do NOT push a fresh sendMessage to Bro.
        if (liveMessage) {
          if (decision.notify) await liveMessage.finalizeTerse(terse).catch(() => {});
          else await liveMessage.finalizeTerse(terse).catch(() => {}); // collapse silently in place
        } else if (decision.notify) {
          // Terse/rollup notif always carries a verdict marker, so it passes
          // isMeaningfulReport in executive mode.
          if (!isExecutiveMode() || isMeaningfulReport(terse)) {
            sendMessage(terse).catch(() => { });
          }
        }
      } else if (screenReport) {
        // Pre-check skip / boilerplate — unchanged legacy path.
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        // HOTFIX-5: Executive mode silences cycle-header noise + boilerplate,
        // but ALLOWS Orion verdict text (DEPLOY / NO DEPLOY / BEST CANDIDATE).
        // Legacy (non-exec) mode: fires every report as before.
        else {
          const stripped = stripThink(screenReport);
          if (!isExecutiveMode() || isMeaningfulReport(stripped)) {
            sendMessage(`🔍 Screening Cycle\n\n${stripped}`).catch(() => { });
          }
        }
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, decisionPnlPct(p), { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  // Vega fix #1 — SL/TP decide on the fee-inclusive net position (fallback to
  // reported pnl_pct). pnlSuspect still guards on the price-only reported value
  // (the divergence check is about SDK reporting, not the economic metric).
  const decisionPnl = decisionPnlPct(position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && decisionPnl != null && decisionPnl <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && decisionPnl != null && decisionPnl >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | default ${config.strategy.defaultBinsBelow}`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "📋 Perintah utama",
    "",
    "/menu — menu tombol utama",
    "/positions — posisi terbuka (bernomor)",
    "/journal — riwayat trade (untung/rugi, win-rate)",
    "/pool 1 — detail satu posisi (ganti 1 dengan nomornya)",
    "/close 1 — tutup posisi nomor 1",
    "/closeall — tutup semua posisi",
    "/set 1 catatanmu — kasih catatan ke posisi nomor 1",
    "/wallet — saldo wallet + deploy amount",
    "/digest — ringkasan hari ini (PnL, win-rate, biaya)",
    "/log — 50 baris log terakhir",
    "/about — tentang bot",
    "",
    "⚙️ Lanjutan (teknis/ops — tetap jalan kalau diketik)",
    "/details — digest verbose teknis",
    "/config — lihat config aktif",
    "/settings — menu tombol config",
    "/setcfg <key> <value> — ubah satu config",
    "/screen — refresh kandidat | /candidates — lihat kandidat",
    "/deploy 1 — deploy kandidat nomor 1",
    "/circuit [reset] — status / re-arm circuit breaker",
    "/briefing — morning briefing",
    "/hive [pull] — HiveMind sync status / manual pull",
    "/pause — stop cron | /resume — start cron",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const _balForSize = await getWalletBalances();
  // FAIL-CLOSED (Vega): unknown balance (sol:null on a failed read) must NOT be
  // sized into a deploy. computeDeployAmount(null) yields NaN which the executor
  // SOL-coverage gate now rejects too, but abort early with a clear reason rather
  // than firing a doomed deploy attempt.
  if (process.env.DRY_RUN !== "true" && (_balForSize?.error || _balForSize?.sol == null || !Number.isFinite(Number(_balForSize.sol)))) {
    throw new Error(`NO DEPLOY: wallet balance unreadable (${_balForSize?.error_message || "no sol value"}) — refusing to size a deploy on an unknown balance.`);
  }
  const deployAmount = computeDeployAmount(_balForSize.sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

// ─── Main menu (Sirius UX upgrade A) ─────────────────────────────
// Plain inline-keyboard menu; callbacks use prefix "main:" to avoid
// colliding with the "cfg:" settings-menu callbacks.
const MAIN_MENU_BUTTONS = [
  [
    { text: "📊 Positions", callback_data: "main:positions" },
    { text: "📒 Journal",   callback_data: "main:journal" },
  ],
  [
    { text: "📋 Digest",    callback_data: "main:digest" },
    { text: "💰 Wallet",    callback_data: "main:wallet" },
  ],
  [
    { text: "📜 Log",       callback_data: "main:log" },
  ],
  [
    { text: "ℹ️ About",     callback_data: "main:about" },
  ],
];

async function showMainMenu() {
  await sendMessageWithButtons(
    "Meridian — pilih menu:",
    MAIN_MENU_BUTTONS,
  ).catch(() => {});
}

// 7d paper-trade win rate helper for executive digest
function computeWinRate7d() {
  try {
    const p = readJsonSafe("paper-trades.json");
    const trades = Array.isArray(p?.trades) ? p.trades : [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const closed = trades.filter((t) => {
      if (t.status === "open") return false;
      const ts = t.closed_at || t.matured_at;
      const ms = typeof ts === "number" ? ts : Date.parse(ts || "");
      return Number.isFinite(ms) && ms >= cutoff;
    });
    if (closed.length === 0) return null;
    const wins = closed.filter((t) => {
      const pnl = t.fee_inclusive_pnl_pct ?? t.latest_snapshot?.fee_inclusive_pnl_pct ?? t.latest_snapshot?.price_proxy_pnl_pct;
      return Number.isFinite(pnl) && pnl > 0;
    }).length;
    return Math.round((wins / closed.length) * 100);
  } catch { return null; }
}

function readJsonSafe(rel) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  } catch { return null; }
}

async function handleExecutiveDigest() {
  try {
    const data = gatherDigestData({ timers });
    const winRate7d = computeWinRate7d();
    let walletSol = null;
    let walletUsd = null;
    try {
      const w = await getWalletBalances();
      walletSol = Number(w?.sol);
      // getWalletBalances() returns LIVE values from Jupiter price v3 (via Helius):
      //   sol_price = live USD/SOL, sol_usd = live SOL position value in USD.
      // Prefer the pre-computed live sol_usd; fall back to sol * sol_price.
      // Both are live — never a hardcoded/stale constant. If neither is finite
      // (price API down) leave walletUsd null so the digest omits USD rather
      // than printing a wrong number.
      const solUsd = Number(w?.sol_usd);
      const solPrice = Number(w?.sol_price);
      if (Number.isFinite(solUsd) && solUsd > 0) {
        walletUsd = solUsd;
      } else if (Number.isFinite(walletSol) && Number.isFinite(solPrice) && solPrice > 0) {
        walletUsd = walletSol * solPrice;
      }
    } catch { /* non-fatal */ }
    const html = formatExecutiveDigest(data, { winRate7d, walletSol, walletUsd });
    await sendHTML(html);
  } catch (e) {
    await sendMessage(`Digest error: ${e.message}`).catch(() => {});
  }
}

async function handleLog() {
  try {
    let out = "";
    try {
      out = execSync("journalctl -u meridian.service -n 50 --no-pager 2>&1", {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch (e) {
      out = e.stdout?.toString?.() || `journalctl unavailable: ${e.message}`;
    }
    let text = out.trim();
    if (text.length > 3800) text = "...(truncated)...\n" + text.slice(-3800);
    await sendMessage("```\n" + text + "\n```");
  } catch (e) {
    await sendMessage(`Log error: ${e.message}`).catch(() => {});
  }
}

function formatAboutText() {
  const maxPos = config.risk?.maxPositions ?? "?";
  const dep = config.management?.deployAmountSol ?? "?";
  const maxDep = config.risk?.maxDeployAmount ?? "?";
  const dry = process.env.DRY_RUN === "true" ? "PAPER (dry-run)" : "LIVE (burner)";
  return [
    "ℹ️ <b>Meridian</b>",
    "",
    "Bot autonomous Liquidity Provider untuk DLMM Meteora di Solana.",
    "Tugasnya: scan pool, deploy LP, monitor, close kalau exit condition.",
    "",
    "<b>Konfigurasi sekarang</b>",
    `Mode: ${dry}`,
    `Max posisi: ${maxPos}`,
    `Deploy amount: ${dep} SOL (cap ${maxDep} SOL)`,
    "",
    "<b>Pipeline</b>",
    "Meteora pools → Cassiopeia filter → Orion judge → Vega execute → Andromeda monitor",
    "",
    "<b>Safety</b>",
    "• Circuit breaker (halt deploy kalau loss harian > cap)",
    "• Hardcoded cap (maxDeployAmount, maxPositions)",
    "• Burner wallet only (no main funds)",
    "• Allow-list Telegram user-id",
    "",
    "Menu: /menu  •  Detail: /details  •  Help: /help",
  ].join("\n");
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }

  // Main menu callback dispatcher (Sirius UX upgrade A)
  if (msg?.isCallback && text.startsWith("main:")) {
    const action = text.slice(5);
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    // Re-dispatch as a synthetic command message into the same handler
    const dispatch = {
      positions: "/positions",
      journal:   "/journal",
      digest:    "/digest",
      log:       "/log",
      about:     "/about",
      wallet:    "/wallet",
    }[action];
    if (dispatch) {
      await telegramHandler({ ...msg, text: dispatch, isCallback: false, callbackData: null });
    }
    return;
  }

  if (text === "/start" || text === "/menu") {
    await showMainMenu();
    return;
  }
  if (text === "/settings" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }

  if (text === "/about") {
    await sendHTML(formatAboutText()).catch(() => {});
    return;
  }

  if (text === "/log") {
    await handleLog();
    return;
  }

  // /digest — executive summary (default). /details = legacy verbose digest.
  if (text === "/digest") {
    await handleExecutiveDigest();
    return;
  }
  if (text === "/details") {
    try {
      const { html } = buildDigest({ timers });
      await sendHTML(html);
    } catch (e) {
      await sendMessage(`Digest error: ${e.message}`).catch(() => {});
    }
    return;
  }
  // /journal — riwayat closed trades (honest ledger, money-honesty fix).
  // Pure file read (lessons.json) — cheap, placed before the busy gate so it
  // always answers even mid-cycle.
  if (text === "/journal" || text === "/history" || text === "/riwayat") {
    try {
      const journal = getTradeJournal({ limit: 10 });
      const cur = config.management.solMode ? "◎" : "$";
      await sendMessage(formatTradeJournal(journal, cur)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nKetik /positions buat lihat daftar posisi bernomor.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("Belum ada posisi terbuka."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      // Live SL/TP config for the trade-card (honest labels — DLMM has no hard
      // TP price, so formatTpLabel maps to the real trailing/fee-harvest exit).
      const cardOpts = {
        stopLossPct: config.management.stopLossPct,
        takeProfitPct: config.management.takeProfitPct,
        trailingTakeProfit: config.management.trailingTakeProfit,
        trailingTriggerPct: config.management.trailingTriggerPct,
        trailingDropPct: config.management.trailingDropPct,
      };
      await sendMessage(formatPositionsMessage(positions, total_positions, cur, cardOpts));
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor tidak valid. Cek /positions dulu buat lihat nomornya."); return; }
      const pos = positions[idx];
      const cur = config.management.solMode ? "◎" : "$";
      const rangeStatus = pos.in_range ? "✅ Dalam range" : `⚠️ Keluar range (OOR) ${formatAgeIndo(pos.minutes_out_of_range ?? 0)}`;
      // Total kalau ditutup = PnL harga + fee (additif, sama seperti list view).
      const pnlSafe = Number.isFinite(Number(pos.pnl_usd)) ? Number(pos.pnl_usd) : 0;
      const feesSafe = Number.isFinite(Number(pos.unclaimed_fees_usd)) ? Number(pos.unclaimed_fees_usd) : 0;
      const totalNum = pnlSafe + feesSafe;
      const totalStr = totalNum >= 0 ? `+${cur}${totalNum.toFixed(2)}` : `-${cur}${Math.abs(totalNum).toFixed(2)}`;
      await sendMessage([
        `#${idx + 1}  ${pos.pair}`,
        `Kalau ditutup sekarang (≈ sebelum gas): ${totalStr}`,
        `Nilai posisi: ${cur}${Number(pos.total_value_usd ?? 0).toFixed(2)}`,
        `Untung/Rugi (harga saja): ${cur}${pnlSafe.toFixed(2)} (${pos.pnl_pct ?? "?"}%)`,
        `Fee didapat (income, belum diklaim): ${cur}${feesSafe.toFixed(2)}`,
        `Umur: ${formatAgeIndo(pos.age_minutes)}  |  ${rangeStatus}`,
        `Range bin: ${pos.lower_bin} → ${pos.upper_bin} (aktif ${pos.active_bin})`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        pos.instruction ? `Catatan: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor tidak valid. Cek /positions dulu buat lihat nomornya."); return; }
      const pos = positions[idx];
      // Vega fix #4 — dedupe: mark this position so any downstream notifyClose
      // (if /close is ever routed through executor) skips its own emit.
      markManualClose(pos.position);
      await sendMessage(`Menutup posisi #${idx + 1} ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const cur = config.management.solMode ? "◎" : "$";
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nTx klaim fee: ${result.claim_txs.join(", ")}` : "";
        // Money-honesty (Lyra) — lead with the LEDGER realized SOL (wallet truth,
        // net IL+slippage+gas), demote price-only LP-PnL. Win/loss keyed on the
        // realized sign, NOT pnl%. ledger_realized_sol_delta is dlmm.js's single
        // source of truth (== the number booked to lessons.json).
        const rsd = Number(result.ledger_realized_sol_delta);
        const rsdPct = Number(result.ledger_realized_sol_delta_pct);
        const hasRsd = Number.isFinite(rsd);
        const closeEmoji = hasRsd ? (rsd > 0 ? "✅" : rsd < 0 ? "🔴" : "⚪") : "🔒";
        const pnlUsdNum = Number(result.pnl_usd);
        const pnlPctNum = Number(result.pnl_pct);
        const realizedLine = hasRsd
          ? `💰 Realized SOL: ${rsd >= 0 ? "+" : ""}${rsd.toFixed(4)} SOL${Number.isFinite(rsdPct) ? ` (${rsdPct >= 0 ? "+" : ""}${rsdPct.toFixed(2)}%)` : ""} — uang bersih ke wallet`
          : `💰 Realized SOL: belum tersedia (pakai angka harga di bawah)`;
        const lpLine = `LP-PnL (harga saja, bukan SOL bersih): ${Number.isFinite(pnlUsdNum) ? `${cur}${pnlUsdNum.toFixed(2)}` : "?"}${Number.isFinite(pnlPctNum) ? ` (${pnlPctNum >= 0 ? "+" : ""}${pnlPctNum.toFixed(2)}%)` : ""}`;
        const closeExplainer = (hasRsd && rsd < 0)
          ? `\nℹ️ "Diterima < dikirim" wajar: rent akun balik pas close & sisa token di-swap ke SOL di tx terpisah — patokan Realized SOL di atas.`
          : "";
        await sendMessage(`${closeEmoji} Posisi ${pos.pair} ditutup\n${realizedLine}\n${lpLine}\nTx tutup: ${closeTxs?.join(", ") || "n/a"}${claimNote}${closeExplainer}`);
      } else {
        await sendMessage(`❌ Gagal menutup posisi: ${result.error || result.message || 'Close failed'}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          // Vega fix #4 — mark manual close so notifyClose skips duplicate emit
          markManualClose(pos.position);
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Nomor tidak valid. Cek /positions dulu buat lihat nomornya."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Catatan tersimpan untuk posisi #${idx + 1} ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/circuit" || text === "/circuit reset") {
    try {
      if (text === "/circuit reset") {
        const result = circuitReset("Telegram /circuit reset by operator");
        await sendMessage(`✅ Circuit breaker reset. Deploys re-armed for today.`).catch(() => {});
      } else {
        const s = getCircuitStatus();
        const haltLine = s.halted ? `🔴 HALTED — ${s.halt_reason}` : `🟢 ARMED`;
        await sendMessage(
          `🔌 Circuit Breaker — ${s.date}\n` +
          `Status: ${haltLine}\n` +
          `Loss today: ${s.realized_loss_sol?.toFixed(4) ?? 0} SOL (${s.realized_loss_pct?.toFixed(1) ?? 0}%)\n` +
          `Cap: ${s.cap_sol} SOL | ${s.cap_pct}%\n` +
          `Progress: SOL ${s.pct_to_cap_sol?.toFixed(0) ?? 0}% | PCT ${s.pct_to_cap_pct?.toFixed(0) ?? 0}%\n` +
          `Closes today: ${s.positions_closed_today} (W:${s.winning_closes_today ?? 0} L:${s.losing_closes_today ?? 0})`
        ).catch(() => {});
      }
    } catch (e) { await sendMessage(`Circuit error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, null, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const smartWalletCount = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  // FAIL-CLOSED (anti-pattern #2): missing/null/NaN/non-finite fee data → SKIP, never treat as pass.
  if (!Number.isFinite(globalFeesSol)) {
    return "token_fees_unknown: no valid global fee data to verify minimum";
  }
  if (globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", null, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
