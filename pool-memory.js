/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";
const MAX_NOTE_LENGTH = 280;

// Cassiopeia — same-token loss re-deploy cooldown shadow-log (JSON-lines).
// One record per event; Lyra reads this to judge whether the would-block set
// skews loser or winner before any "enforce" flip. Overridable for test isolation.
const SAME_TOKEN_COOLDOWN_SHADOW_FILE =
  process.env.MERIDIAN_SAME_TOKEN_COOLDOWN_SHADOW_FILE || "./same-token-cooldown-shadow.jsonl";

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy) {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Same-token loss re-deploy cooldown (Cassiopeia — shadow-first) ──────────
//
// Cross-token revenge-deploy INSTRUMENTATION, thin-edge, SHADOW-FIRST. This is
// NOT a "POB fix". Lyra census: block-set (18 distinct tokens, −0.0665 SOL) passes
// her threshold but BLUNTLY (41% of revenge re-deploys WIN, net edge only +0.066
// SOL / 145 trades). So: build the instrument + shadow-observe first; the "enforce"
// flip is a LATER Bro gate once shadow data confirms the block-set condong loser.
//
// FAIL-SAFE is INVERSE to the rug gates: this is a funnel-PAUSING action, so an
// "unknown" (missing pnl / missing base_mint) must NOT fabricate a cooldown — we
// only ever pause on a POSITIVELY-measured qualifying loss. Mirrors the
// market-regime NEUTRAL-on-missing posture.

/** Normalize a close-reason for matching: lowercase, [-_] → space, collapse ws. */
export function normalizeCloseReason(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if `reason` matches any configured loss-trigger reason (normalized substring).
 * Empty/missing reason → false (fail-safe inverse: unknown reason never arms).
 */
export function sameTokenLossReasonMatches(reason, reasonList) {
  const norm = normalizeCloseReason(reason);
  if (!norm) return false;
  const list = Array.isArray(reasonList) && reasonList.length > 0
    ? reasonList
    : ["stop loss", "give_back_protect"];
  return list.some((r) => {
    const rn = normalizeCloseReason(r);
    return rn.length > 0 && norm.includes(rn);
  });
}

/**
 * Realized loss/gain figure for a closed deploy, preferring the TRUE SOL delta.
 * Preference: realized_sol_delta (SOL) → pnl_usd (USD) → pnl_pct (%).
 * Returns { value, unit } or null when NO finite figure exists (fail-safe inverse
 * — a missing pnl must never fabricate a cooldown).
 */
export function sameTokenLossFigure(deploy) {
  if (!deploy || typeof deploy !== "object") return null;
  // strictFinite — null/undefined/"" must NOT coerce to 0 (Number(null)===0 would
  // fabricate a breakeven and defeat the fail-safe-inverse posture).
  const strictFinite = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sol = strictFinite(deploy.realized_sol_delta);
  if (sol !== null) return { value: sol, unit: "SOL" };
  const usd = strictFinite(deploy.pnl_usd);
  if (usd !== null) return { value: usd, unit: "USD" };
  const pct = strictFinite(deploy.pnl_pct);
  if (pct !== null) return { value: pct, unit: "%" };
  return null;
}

/**
 * Does this closing deploy qualify as a loss-trigger (i.e. arm the cooldown)?
 * Requires: close_reason ∈ list AND a finite pnl figure AND that figure < 0.
 * Winner/breakeven (figure >= 0) → false (winner-exempt).
 * No finite figure / no base reason → false (fail-safe inverse).
 */
export function sameTokenLossQualifiesTrigger(deploy, cfg) {
  if (!sameTokenLossReasonMatches(deploy?.close_reason, cfg?.sameTokenLossCooldownReasons)) return false;
  const fig = sameTokenLossFigure(deploy);
  if (!fig) return false;       // fail-safe inverse: unknown pnl → no cooldown
  return fig.value < 0;         // winner-exempt: >= 0 never arms
}

/**
 * Find the most-recent PRIOR qualifying loss of the same base_mint (CROSS-POOL) that
 * closed within `sameTokenLossCooldownHours` before this re-deploy OPENED. Returns the
 * matched context (for shadow-log outcome records) or null. This is the keying lubang
 * the census surfaced: we key per BASE_MINT, not per pool.
 */
export function findPriorLossForRedeploy(db, baseMint, redeployDeployedAtMs, cfg) {
  if (!baseMint || !Number.isFinite(redeployDeployedAtMs)) return null;
  const hours = Number(cfg?.sameTokenLossCooldownHours ?? 6);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const windowMs = hours * 60 * 60 * 1000;
  let best = null;
  for (const entry of Object.values(db || {})) {
    if (entry?.base_mint !== baseMint) continue;
    for (const d of entry.deploys || []) {
      if (!sameTokenLossQualifiesTrigger(d, cfg)) continue;
      const closedMs = Date.parse(d.closed_at);
      if (!Number.isFinite(closedMs)) continue;
      if (closedMs >= redeployDeployedAtMs) continue;   // must PRECEDE the re-deploy open
      const gapMs = redeployDeployedAtMs - closedMs;
      if (gapMs > windowMs) continue;                    // outside cooldown window
      if (!best || closedMs > best._closedMs) {
        best = {
          _closedMs: closedMs,
          gapHours: Math.round((gapMs / 3_600_000) * 100) / 100,
          priorLoss: sameTokenLossFigure(d),
          priorReason: d.close_reason || null,
          priorPool: entry?.name || null,
        };
      }
    }
  }
  return best;
}

function appendSameTokenCooldownShadowLog(record) {
  try {
    fs.appendFileSync(SAME_TOKEN_COOLDOWN_SHADOW_FILE, JSON.stringify(record) + "\n");
  } catch (e) {
    log("pool-memory", `same-token cooldown shadow-log write failed: ${e?.message || e}`);
  }
}

/**
 * Same-token loss re-deploy cooldown — instrumentation + shadow/enforce.
 * Called from recordPoolDeploy AFTER the current deploy is pushed, BEFORE save().
 * Mutates `db` (shadow markers always; the SHARED base_mint cooldown only in enforce).
 * Writes shadow-log records (outcome + armed) in BOTH shadow and enforce modes.
 * Returns a structured result for tests/telemetry.
 *
 * MODES: "off" → no-op. "shadow" (default) → NEVER touches base_mint_cooldown_until
 * (funnel byte-unchanged) — only markers + logs. "enforce" → reuses setBaseMintCooldown
 * so the EXISTING screening gate (isBaseMintOnCooldown) rejects the token. No new gate.
 */
export function applySameTokenLossCooldown({ db, poolAddress, deployData, cfg, now = Date.now() }) {
  const mode = String(cfg?.sameTokenLossCooldownMode || "shadow").toLowerCase();
  const result = { mode, armed: false, wouldBlock: false, redeployObserved: false, reason: null };
  if (mode === "off") return result;

  const entry = db?.[poolAddress];
  if (!entry) return result;
  const baseMint = deployData?.base_mint || entry?.base_mint || null;
  const hours = Number(cfg?.sameTokenLossCooldownHours ?? 6);

  // (1) OUTCOME OBSERVATION — was THIS closing deploy itself a revenge re-deploy
  // (opened within the cooldown window of a prior qualifying loss of the same token)?
  // If so, record its realized outcome so Lyra can judge whether the would-block set
  // skews loser or winner. FAIL-SAFE INVERSE: missing base_mint / open-time → skip.
  const openMs = Date.parse(deployData?.deployed_at);
  if (baseMint && Number.isFinite(openMs) && Number.isFinite(hours) && hours > 0) {
    const prior = findPriorLossForRedeploy(db, baseMint, openMs, cfg);
    if (prior) {
      result.redeployObserved = true;
      const fig = sameTokenLossFigure(deployData);
      const outcome = fig ? (fig.value >= 0 ? "win" : "loss") : "unknown";
      appendSameTokenCooldownShadowLog({
        kind: "redeploy_outcome",
        mode,
        ts: new Date(now).toISOString(),
        base_mint: baseMint,
        pool: poolAddress,
        pool_name: entry?.name || null,
        gap_hours: prior.gapHours,
        cooldown_hours: hours,
        prior_loss: prior.priorLoss,          // {value, unit} | null
        prior_reason: prior.priorReason,
        prior_pool: prior.priorPool,
        redeploy_close_reason: deployData?.close_reason || null,
        redeploy_result: outcome,             // "win" | "loss" | "unknown"
        redeploy_pnl: fig,                    // {value, unit} | null
      });
      log("pool-memory",
        `[same-token-cooldown/${mode}] revenge re-deploy OUTCOME for ${baseMint.slice(0, 8)}: ${outcome} ` +
        `(${fig ? fig.value.toFixed(4) + " " + fig.unit : "unknown"}), gap ${prior.gapHours}h from prior loss`);
    }
  }

  // (2) ARMING — does THIS close arm the cooldown for FUTURE re-deploys?
  if (baseMint && Number.isFinite(hours) && hours > 0 && sameTokenLossQualifiesTrigger(deployData, cfg)) {
    const fig = sameTokenLossFigure(deployData);
    const armReason = `same-token loss cooldown (${deployData.close_reason})`;
    const cooldownUntil = new Date(now + hours * 3_600_000).toISOString();
    result.reason = armReason;

    // Shadow markers (both modes) — fields the screening gate NEVER reads, so shadow
    // mode leaves base_mint_cooldown_until (and thus the funnel) byte-for-byte unchanged.
    entry.same_token_loss_shadow_until = cooldownUntil;
    entry.same_token_loss_figure = fig || null;
    entry.same_token_loss_prior_sol = fig && fig.unit === "SOL" ? fig.value : null;
    entry.same_token_loss_reason = deployData.close_reason || null;
    entry.same_token_loss_armed_at = new Date(now).toISOString();
    entry.same_token_loss_mode = mode;

    if (mode === "enforce") {
      // REUSE the existing base_mint cooldown field → the existing screening gate
      // (isBaseMintOnCooldown) rejects it. No new gate, no new plumbing.
      setBaseMintCooldown(db, baseMint, hours, armReason);
      result.armed = true;
      log("pool-memory",
        `[same-token-cooldown/enforce] base_mint ${baseMint.slice(0, 8)} BLOCKED until ${cooldownUntil} ` +
        `(prior loss ${fig ? fig.value.toFixed(4) + " " + fig.unit : "unknown"}, reason ${deployData.close_reason})`);
    } else {
      // shadow — WOULD-BLOCK log only; NO real cooldown set (funnel untouched).
      result.wouldBlock = true;
      log("pool-memory",
        `[same-token-cooldown/shadow] WOULD-BLOCK base_mint ${baseMint.slice(0, 8)} ` +
        `(prior loss ${fig ? fig.value.toFixed(4) + " " + fig.unit : "unknown"}, window ${hours}h, reason ${deployData.close_reason})`);
    }

    appendSameTokenCooldownShadowLog({
      kind: "armed",
      mode,
      ts: new Date(now).toISOString(),
      base_mint: baseMint,
      pool: poolAddress,
      pool_name: entry?.name || null,
      cooldown_hours: hours,
      cooldown_until: cooldownUntil,
      close_reason: deployData.close_reason || null,
      prior_loss: fig,                        // {value, unit} | null
      enforced: mode === "enforce",
    });
  }

  return result;
}

export function setPoolAndTokenCooldown({ poolAddress, baseMint = null, hours = 12, reason = "manual cooldown" }) {
  if (!poolAddress) return null;
  const db = load();
  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: poolAddress.slice(0, 8),
      base_mint: baseMint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  const entry = db[poolAddress];
  if (baseMint && !entry.base_mint) entry.base_mint = baseMint;

  const poolCooldownUntil = setPoolCooldown(entry, hours, reason);
  const tokenCooldownUntil = setBaseMintCooldown(db, baseMint || entry.base_mint, hours, reason);
  save(db);
  log("pool-memory", `Manual cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
  if (tokenCooldownUntil && (baseMint || entry.base_mint)) {
    log("pool-memory", `Manual base mint cooldown set for ${(baseMint || entry.base_mint).slice(0, 8)} until ${tokenCooldownUntil} (${reason})`);
  }
  return { poolCooldownUntil, tokenCooldownUntil };
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Phase G — multi-source cross-validation provenance.
 * Append a signal sighting {source, ts} to the pool entry's
 * signal_source_history array (created if absent). Additive; no migration.
 * Called per-sighting from the screening merge block.
 *
 * @param {string} poolAddress
 * @param {string} source  e.g. "meteora", "discord", "solscan"
 */
export function recordSignalSighting(poolAddress, source) {
  if (!poolAddress || !source) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  const entry = db[poolAddress];
  if (!Array.isArray(entry.signal_source_history)) entry.signal_source_history = [];
  entry.signal_source_history.push({ source: String(source), ts: Date.now() });
  entry.signal_source_history = entry.signal_source_history.slice(-50);

  save(db);
  return entry.signal_source_history.length;
}

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    // Cassiopeia — persist the TRUE realized SOL delta so cross-pool prior-loss scans
    // (findPriorLossForRedeploy) can classify historical losses in real SOL terms.
    realized_sol_delta: deployData.realized_sol_delta ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  // Cassiopeia — same-token loss re-deploy cooldown (instrumentation + shadow/enforce).
  // Runs on EVERY close; mode-gated internally. Shadow (default) never touches the
  // funnel; enforce reuses the existing base_mint cooldown gate. Mutates db in place.
  try {
    applySameTokenLossCooldown({
      db,
      poolAddress,
      deployData: {
        base_mint: deployData.base_mint || entry.base_mint || null,
        deployed_at: deployData.deployed_at || null,
        close_reason: deployData.close_reason || null,
        realized_sol_delta: deployData.realized_sol_delta ?? null,
        pnl_usd: deployData.pnl_usd ?? null,
        pnl_pct: deployData.pnl_pct ?? null,
      },
      cfg: config.management,
    });
  } catch (e) {
    // Instrumentation must never break the close/record path.
    log("pool-memory", `same-token loss cooldown eval failed: ${e?.message || e}`);
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
