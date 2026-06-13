// Andromeda — Deploy Report Formatter (PR 2 of internal multi-agent refactor)
//
// Pure, deterministic Telegram report formatter. NO LLM call. Replaces the
// ~70-line `STEPS:` template that previously forced the SCREENER LLM to
// hand-render the Telegram message. Removing this surface:
//   - eliminates the #1 hallucination risk in the screening cycle (LLM
//     inventing pool stats, OKX fields, or "DEPLOYED" lines without a tool
//     call)
//   - shrinks the SCREENER system + goal prompts by ~2-3 KB per step,
//     pushing more screens into the compact/workhorse routing tiers
//
// Feature-flag gated by `config.internalAgents.andromedaEnabled`. When the
// flag is OFF, index.js falls through to the legacy LLM-rendered report path
// — the formatter is dormant and behavior is bit-equivalent to pre-PR-2.
//
// Inputs:
//   - deployResult: the raw tool result returned by tools/dlmm.js:deploy_position
//     (either dry-run shape: { dry_run, would_deploy, message }
//      or live shape:    { success, position, pool, pool_name, bin_range,
//                          price_range, range_coverage, bin_step, base_fee,
//                          strategy, amount_y, txs })
//   - candidate:    the pre-fetched `{ pool, sw, n, ti, mem }` block as
//     built by index.js runScreeningCycle (NOT a hallucinated subset)
//
// Outputs: a single string, Telegram-ready, matching the legacy template
// exactly (allowing for input-shape differences only — see formatRange).

const NOT_AVAILABLE = "n/a";

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(v, digits = 2) {
  const n = num(v);
  return n == null ? NOT_AVAILABLE : `${n.toFixed(digits)}%`;
}

function fmtUsd(v) {
  const n = num(v);
  if (n == null) return NOT_AVAILABLE;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtSol(v, digits = 3) {
  const n = num(v);
  return n == null ? NOT_AVAILABLE : `${n.toFixed(digits)} SOL`;
}

function fmtPlain(v) {
  const n = num(v);
  return n == null ? NOT_AVAILABLE : String(n);
}

function fmtPrice(v) {
  const n = num(v);
  if (n == null) return NOT_AVAILABLE;
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(3);
}

export function formatRange(priceRange) {
  if (!priceRange) return NOT_AVAILABLE;
  const min = fmtPrice(priceRange.min);
  const max = fmtPrice(priceRange.max);
  return `${min} → ${max}`;
}

export function formatPnL(pct) {
  const n = num(pct);
  if (n == null) return NOT_AVAILABLE;
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatProgressBar(pct, width = 20) {
  const n = Math.max(0, Math.min(100, num(pct) ?? 0));
  const filled = Math.round((n / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(n)}%`;
}

function pickSmartWalletNames(candidate) {
  const sw = candidate?.sw || {};
  if (Array.isArray(sw.in_pool) && sw.in_pool.length > 0) {
    return sw.in_pool.map((w) => w.name || w.address?.slice(0, 6) || "?").join(", ");
  }
  return "none";
}

function buildRiskBlock(pool) {
  if (!pool) return "OKX: unavailable";
  const lines = [];
  if (pool.risk_level != null) lines.push(`Risk level: ${pool.risk_level}`);
  if (pool.bundle_pct != null) lines.push(`Bundle: ${fmtPct(pool.bundle_pct)}`);
  if (pool.sniper_pct != null) lines.push(`Sniper: ${fmtPct(pool.sniper_pct)}`);
  if (pool.suspicious_pct != null) lines.push(`Suspicious: ${fmtPct(pool.suspicious_pct)}`);
  if (pool.price_vs_ath_pct != null) lines.push(`ATH distance: ${fmtPct(pool.price_vs_ath_pct)}`);
  if (pool.is_rugpull != null) lines.push(`Rugpull: ${pool.is_rugpull ? "YES" : "NO"}`);
  if (pool.is_wash != null) lines.push(`Wash: ${pool.is_wash ? "YES" : "NO"}`);
  if (lines.length === 0) return "OKX: unavailable";
  return lines.join("\n");
}

/**
 * Format the success-path deploy report for Telegram.
 *
 * Returns a string. Never throws; missing fields render as "n/a" rather
 * than blowing up the cron cycle.
 */
export function formatDeployReport({ deployResult, candidate, orionVerdict = null, sessionContext = null } = {}) {
  if (!deployResult) return "🚀 DEPLOYED\n\n(no deploy result available)";

  const isDryRun = deployResult.dry_run === true || !!deployResult.would_deploy;
  const header = isDryRun ? "🚀 SIMULATED DEPLOY" : "🚀 DEPLOYED";

  const pool = candidate?.pool || {};
  const ti = candidate?.ti || {};

  // Resolve fields with priority: real tool result > dry-run would_deploy > candidate
  const wd = deployResult.would_deploy || {};
  const poolAddress = deployResult.pool || wd.pool_address || pool.pool || NOT_AVAILABLE;
  const poolName = deployResult.pool_name || pool.name || poolAddress;
  const amountY = deployResult.amount_y ?? wd.amount_y ?? wd.amount_sol;
  const strategy = deployResult.strategy || wd.strategy || NOT_AVAILABLE;
  const activeBin = deployResult.bin_range?.active ?? pool.active_bin ?? NOT_AVAILABLE;
  const rc = deployResult.range_coverage || {};
  const downside = rc.downside_pct ?? wd.downside_pct;
  const upside = rc.upside_pct ?? wd.upside_pct;
  const width = rc.width_pct;
  const priceRange = deployResult.price_range || null;

  const lines = [];
  lines.push(header);
  lines.push("");
  lines.push(poolName);
  lines.push(poolAddress);
  lines.push("");
  lines.push(`◎ ${fmtSol(amountY)} | ${strategy} | bin ${activeBin}`);
  lines.push(`Range: ${formatRange(priceRange)}`);
  lines.push(`Range cover: ${fmtPct(downside)} downside | ${fmtPct(upside)} upside | ${fmtPct(width)} total`);
  lines.push("");
  lines.push("MARKET");
  lines.push(`Fee/TVL: ${fmtPct(pool.fee_active_tvl_ratio)}`);
  lines.push(`Volume: ${fmtUsd(pool.volume_window)}`);
  lines.push(`TVL: ${fmtUsd(pool.tvl ?? pool.active_tvl)}`);
  lines.push(`Volatility: ${fmtPlain(pool.volatility)}`);
  lines.push(`Organic: ${fmtPlain(pool.organic_score)}`);
  lines.push(`Mcap: ${fmtUsd(pool.mcap)}`);
  if (pool.token_age_hours != null) lines.push(`Age: ${fmtPlain(pool.token_age_hours)}h`);
  lines.push("");
  lines.push("AUDIT");
  lines.push(`Top10: ${fmtPct(ti?.audit?.top_holders_pct)}`);
  lines.push(`Bots: ${fmtPct(ti?.audit?.bot_holders_pct)}`);
  lines.push(`Fees paid: ${fmtSol(ti?.global_fees_sol)}`);
  lines.push(`Smart wallets: ${pickSmartWalletNames(candidate)}`);
  lines.push("");
  lines.push("RISK");
  lines.push(buildRiskBlock(pool));

  if (orionVerdict?.reason) {
    lines.push("");
    lines.push("WHY THIS WON");
    lines.push(`Orion (${Math.round(orionVerdict.confidence ?? 0)}%): ${orionVerdict.reason}`);
  }

  if (sessionContext?.note) {
    lines.push("");
    lines.push(`note: ${sessionContext.note}`);
  }

  return lines.join("\n");
}

/**
 * Format the no-deploy report (reject path).
 *
 * `rejectedCandidates` accepts either:
 *   - the same `passing` shape used in index.js: [{ pool, ... }]
 *   - or an enriched shape with .reason — e.g. Orion verdicts:
 *       [{ pool_address, name, reason }]
 */
export function formatNoDeployReport({ rejectedCandidates = [], reason = null } = {}) {
  const lines = [];
  lines.push("⛔ NO DEPLOY");
  lines.push("");
  lines.push("Cycle finished with no valid entry.");
  lines.push("");

  const list = Array.isArray(rejectedCandidates) ? rejectedCandidates : [];
  const best = list[0];
  const bestName = best?.pool?.name || best?.name || (list.length === 0 ? "none" : "unknown");
  lines.push("BEST LOOKING CANDIDATE");
  lines.push(bestName);
  lines.push("");
  lines.push("WHY SKIPPED");
  lines.push(reason || "No candidate met the deploy bar this cycle.");

  if (list.length > 0) {
    lines.push("");
    lines.push("REJECTED");
    for (const c of list) {
      const name = c?.pool?.name || c?.name || c?.pool_address || "?";
      const why = c?.reason || c?.skip_reason || "did not qualify";
      lines.push(`- ${name}: ${why}`);
    }
  }

  return lines.join("\n");
}

// ─── Sirius: terse per-cycle screening notif (2–5 lines, plain language) ──────
//
// Bro Dikta does not read long/verbose cycle reports. The Telegram notif for
// each screening cycle is collapsed to 2–5 lines:
//   line 1: 🔍 Screening <HH:MM> WIB
//   line 2: funnel — "<N> pool → <M> lolos filter → judge"  (numbers only)
//   line 3: outcome — DEPLOY (pool + size) OR NO DEPLOY (short plain reason)
//
// The full verbose report (formatDeployReport / formatNoDeployReport) is STILL
// written to the decision-log + daily log files for Lyra's audit — only the
// Telegram message to Bro is shrunk. Plain language: no raw jargon
// (bin_step / fee_active_tvl_ratio etc.) — those are translated to human phrases.

function wibTime(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return "--:--";
  }
}

// Translate a raw/technical no-deploy reason into a short plain-language phrase.
// Pattern-match on the substance, fall back to a generic phrase — NEVER leak
// raw gate names or metric keys to Bro.
export function plainReason(raw) {
  if (!raw) return "ga ada kandidat lolos";
  const s = String(raw).toLowerCase();

  // Infra / fetch failures
  if (/\b429\b|rate.?limit|too many requests/.test(s)) return "API rate-limit (429)";
  if (/\b(403|forbidden|waf)\b/.test(s)) return "API ditolak (403)";
  if (/\b5\d\d\b|timeout|timed out|econn|fetch fail|network/.test(s)) return "API error";
  if (/balance unreadable|wallet balance/.test(s)) return "saldo wallet ga kebaca";
  if (/insufficient sol/.test(s)) return "SOL kurang buat deploy";
  if (/max positions/.test(s)) return "posisi udah penuh";

  // No-candidate funnel outcomes
  if (/no candidates?|all filtered|did not qualify|no candidate met/.test(s)) return "ga ada kandidat lolos";

  // Pool-quality reasons (translate jargon → human)
  if (/fee.?(active.?)?tvl|fee\/tvl|fee.?gen|fee.*(low|kecil|below)/.test(s)) return "fee kekecilan";
  if (/tvl.*(low|thin|below|tipis|min)/.test(s)) return "pool TVL tipis";
  if (/tvl.*(high|above|max)/.test(s)) return "pool TVL kegedean";
  if (/volume|sepi|illiquid/.test(s)) return "pool sepi";
  if (/volatil/.test(s)) return "volatilitas ga sehat";
  if (/rug|liquidity removal/.test(s)) return "kandidat berisiko rug";
  if (/bot|sniper|bundle/.test(s)) return "holder mencurigakan";
  if (/top.?10|concentrat|whale/.test(s)) return "holder kepusat di whale";
  if (/mint|freeze|authority/.test(s)) return "authority belum di-renounce";
  if (/mcap|market.?cap/.test(s)) return "mcap di luar band";
  if (/age|too (young|new|old)/.test(s)) return "umur token ga pas";
  if (/non.?sol|usdc|undeployable|quote/.test(s)) return "pool bukan pair SOL";
  if (/organic/.test(s)) return "aktivitas pool ga organik";
  if (/cooldown/.test(s)) return "pool lagi cooldown";

  // LLM judge verdicts
  if (/\bwatch\b/.test(s)) return "judge WATCH (belum ENTER)";
  if (/no enter|did not enter|skip/.test(s)) return "judge ga ENTER";

  // Generic fallback — short, no jargon
  return "ga ada yang lolos bar deploy";
}

function fmtSolShort(v) {
  const n = num(v);
  return n == null ? "?" : `${n.toFixed(2)} SOL`;
}

/**
 * Build the terse 2–5 line Telegram screening notif.
 *
 * @param {object} funnel
 *   - universe:   raw pool count scanned (number)
 *   - passed:     candidates that reached the judge (number)
 *   - deployed:   boolean
 *   - poolName:   string (deploy path)
 *   - amountSol:  number (deploy path)
 *   - reason:     raw reason string (no-deploy path) — translated via plainReason
 *   - skipped:    boolean — cycle never reached the funnel (pre-check skip)
 *   - skipReason: raw reason for a pre-check skip
 *   - at:         optional Date (defaults to now)
 *
 * Always returns 2–5 lines. Never throws.
 */
export function formatScreeningTerse(funnel = {}) {
  const at = funnel.at instanceof Date ? funnel.at : new Date();
  const lines = [`🔍 Screening ${wibTime(at)} WIB`];

  // Pre-check skip (no funnel ran): 2 lines, plain reason.
  if (funnel.skipped) {
    lines.push(`Skip cycle: ${plainReason(funnel.skipReason)}`);
    return lines.join("\n");
  }

  const universe = num(funnel.universe);
  const passed = num(funnel.passed) ?? 0;
  const universeStr = universe != null ? String(universe) : "?";

  if (funnel.deployed) {
    lines.push(`${universeStr} pool → ${passed} lolos → judge ENTER`);
    const name = funnel.poolName || "?";
    lines.push(`✅ DEPLOY: ${name} ${fmtSolShort(funnel.amountSol)}`);
    return lines.join("\n");
  }

  lines.push(`${universeStr} pool → ${passed} lolos filter → judge`);
  lines.push(`Hasil: NO DEPLOY (${plainReason(funnel.reason)})`);
  return lines.join("\n");
}

// Convenience: detect whether Andromeda formatting is active. Lets callers
// (index.js) keep a single source of truth for the flag check.
export function andromedaEnabled(config) {
  return Boolean(config?.internalAgents?.andromedaEnabled);
}
