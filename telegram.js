import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserIdNum = msg.from?.id != null ? Number(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) {
    log("telegram_warn", `Rejected incoming msg from unauthorized chat user_id=${senderUserIdNum} chat_id=${incomingChatId}`);
    return false;
  }

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (senderUserIdNum == null || !Number.isFinite(senderUserIdNum) || !ALLOWED_USER_IDS.has(senderUserIdNum)) {
      log("telegram_warn", `Rejected incoming msg from unauthorized user_id=${senderUserIdNum} chat_id=${incomingChatId}`);
      return false;
    }
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

// ─── Executive Notification Mode (Sirius) ────────────────────────
// When executiveMode = true, gated call sites stay silent. Surfaces ONLY:
//   - daily boss-report (boss-report.js)
//   - morning briefing (briefing.js)
//   - circuit breaker (notifyCircuitBreaker)
//   - big PnL paper closes (|PnL| >= bigPnlThresholdPct via isBigPnl)
//   - live (non-paper) deploys/closes
// Flip flag false → all legacy notifs return immediately. No code removal.
export function isExecutiveMode() {
  return config?.telegram?.executiveMode === true;
}
export function isBigPnl(pnlPct) {
  const threshold = config?.telegram?.bigPnlThresholdPct ?? 15;
  const v = Number(pnlPct);
  return Number.isFinite(v) && Math.abs(v) >= threshold;
}

// ─── HOTFIX-5: Meaningful cycle report detector (Sirius) ─────────────
// Executive mode silences cycle-header noise + tool-step echoes but MUST
// preserve Orion's actual verdict text (DEPLOY/NO DEPLOY analysis with
// rationale — that's the executive-grade content Bro Dikta wants).
//
// Returns true iff text carries Orion-verdict signal worth surfacing.
// Boilerplate ("no open positions", "screening already running", empty,
// just-the-header) returns false → stays silent in exec mode.
export function isMeaningfulReport(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (s.length < 40) return false;
  // Case-insensitive normalization — actual Telegram messages use capital-N
  // "No open positions" but boilerplate regex was missing /i in one spot and
  // any future case-variant (ALL CAPS, TitleCase) would slip the gate.
  const sLower = s.toLowerCase();

  // Explicit boilerplate from runManagementCycle / runScreeningCycle
  // Patterns operate on sLower → no /i flag needed.
  const boilerplate = [
    /^no open positions\.?\s*(triggering screening cycle|screening already running)/,
    /^screening (skipped|pre-check failed)/,
    /^no candidates? (available|found|to evaluate)/,
    /^management cycle failed:/,
    /^screening cycle failed:/,
  ];
  if (boilerplate.some((re) => re.test(sLower))) return false;

  // Verdict / decision markers — Orion analysis surface
  const verdictMarkers = [
    /\bDEPLOY\b/i,        // covers DEPLOY and NO DEPLOY
    /\bNO[- ]DEPLOY\b/i,
    /\bBEST LOOKING CANDIDATE\b/i,
    /\bVERDICT\b/i,
    /\bRECOMMEND(ATION|ED)?\b/i,
    /\bRATIONALE\b/i,
    /\bdev sold\b/i,
    /\brug\b/i,
    /\bdump\b/i,
    /\bclose\b.*\bposition\b/i,   // mgmt close decisions
    /\bhold\b.*\bposition\b/i,
  ];
  return verdictMarkers.some((re) => re.test(s));
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

// Test-only capture hook. Production code never sets this; only test scripts do.
// When set, notify* helpers call this instead of hitting Telegram. Lets us
// assert formatting/fields without monkey-patching the module.
let _testSender = null;
export function __setTestSender(fn) {
  _testSender = typeof fn === "function" ? fn : null;
}

export async function sendHTML(html) {
  if (_testSender) {
    try { await _testSender({ kind: "html", text: html }); } catch (_) {}
    return;
  }
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    // Sirius: collapse the ENTIRE live message to a terse final text. Unlike
    // finalize() (which keeps title + intro + tool-step lines above the footer),
    // this REPLACES the whole body so Bro sees only the 2–5 line summary — no
    // tool-step echo ("✅ get pool memory done"), no candidate dump. The verbose
    // detail stays in the log files for Lyra.
    async finalizeTerse(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.title = "";
      state.intro = "";
      state.toolLines = [];
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

// ─── Bot command menu registration (Sirius) ──────────────────────
// Registers the slash-command autocomplete menu visible in Telegram clients.
// Idempotent — safe to call on every startup. Never throws; Telegram API
// outages must not block bot polling.
// Executive menu only (Sirius declutter 2026-06-21). Bro-facing commands that
// have real reporting/control value. Technical/ops commands (/config, /setcfg,
// /screen, /candidates, /deploy, /circuit, /hive, /pause, /resume, /details,
// /briefing) still WORK if typed — they're just removed from the autocomplete
// menu so Bro's command bar stays clean. See /help for the full advanced list.
const BOT_COMMANDS = [
  { command: "menu",        description: "📋 Buka menu utama" },
  { command: "positions",   description: "📊 Posisi terbuka" },
  { command: "journal",     description: "📒 Riwayat trade (untung/rugi)" },
  { command: "digest",      description: "📋 Ringkasan hari ini" },
  { command: "wallet",      description: "💰 Saldo wallet" },
  { command: "close",       description: "❌ Tutup posisi by index" },
  { command: "closeall",    description: "❌ Tutup semua posisi" },
  { command: "set",         description: "📝 Set catatan posisi" },
  { command: "log",         description: "📜 50 baris log terakhir" },
  { command: "about",       description: "ℹ️ Tentang bot" },
];

export async function registerBotCommands() {
  if (!TOKEN) return false;
  try {
    const res = await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log("telegram_warn", `setMyCommands ${res.status}: ${errText.slice(0, 200)}`);
      return false;
    }
    log("telegram", `Bot commands registered (${BOT_COMMANDS.length} entries)`);
    return true;
  } catch (e) {
    log("telegram_warn", `setMyCommands failed: ${e.message}`);
    return false;
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  // Fire-and-forget command menu registration; never blocks polling.
  registerBotCommands().catch((e) => log("telegram_warn", `registerBotCommands error: ${e.message}`));
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── HTML escape (Vega fix #3) ───────────────────────────────────
// Telegram HTML parse mode 400-errors on unescaped <, >, & in user-controlled
// strings (pair/token names from on-chain metadata can contain anything).
// Apply to any user-controlled interpolation; leave intentional tags alone.
export function htmlEscape(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Close-outcome win/loss sign (Lyra money-honesty, single source of truth) ──
// The win/loss/breakeven marker for a CLOSE must key on the number that actually
// moved the wallet — NOT the flattering price-only pnl%. A trade whose LP-PnL
// reads +0.5% but whose realized SOL delta is negative (slippage+gas ate the thin
// win) MUST read as a loss (🔴), never a fake win (✅). Preference chain:
//   realized SOL delta → price-only pnlSol → pnlPct → neutral (⚪).
// Kept pure + exported so /journal, /close and notifyClose all decide the sign
// identically (no drift between the three surfaces). FAIL-SAFE (anti-pattern #2):
// when NO honest basis is finite, returns ⚪ — never fabricates a win/loss.
export function closeOutcomeEmoji({ realizedSolDelta, pnlSol, pnlPct } = {}) {
  // Check finiteness on the RAW values (NOT Number(x)) — Number(null)===0 and
  // Number("")===0 are finite, which would fabricate a breakeven ⚪ instead of
  // falling through to the next honest basis (anti-pattern #2). Number.isFinite
  // (no coercion) is false for null/undefined/NaN/strings, so a missing realized
  // figure correctly falls through to pnlSol → pnlPct.
  const basis = Number.isFinite(realizedSolDelta)
    ? realizedSolDelta
    : Number.isFinite(pnlSol)
      ? pnlSol
      : Number.isFinite(pnlPct)
        ? pnlPct
        : NaN;
  const sign = Number.isFinite(basis) ? Math.sign(basis) : 0;
  return sign > 0 ? "✅" : sign < 0 ? "🔴" : "⚪";
}

// ─── OOR cooldown state (Vega fix #4) ────────────────────────────
// Per-position cooldown so notifyOutOfRange doesn't spam every mgmt tick.
const OOR_ALERT_COOLDOWN_MS = (config.management?.oorCooldownHours ?? 6) * 60 * 60 * 1000; // driven by config, was hardcoded 6h
const _oorLastAlertedAt = new Map(); // positionId -> timestamp

// ─── Manual-close dedupe state (Vega fix #4) ─────────────────────
// /close handler in index.js already emits an inline "✅ Closed ..." message.
// If a future refactor routes manual close through executeTool (which calls
// notifyClose), we'd double-alert. Mark the position as manually closed and
// have notifyClose skip it for a short window.
const MANUAL_CLOSE_SKIP_MS = 60 * 1000; // 60s
const _manualClosedAt = new Map(); // positionAddress -> timestamp

export function markManualClose(positionAddress) {
  if (!positionAddress) return;
  _manualClosedAt.set(positionAddress, Date.now());
}

// ─── Budget alert throttle (Vega fix #1) ─────────────────────────
const BUDGET_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h
let _lastBudgetAlertAt = 0;

// ─── Burner balance-drain alert throttle (Sirius Pillar B fix #4) ─
// Fires when wallet balance drops >drainThresholdPct (default 20%) within
// the sampling window. 1h cooldown so a sustained drain doesn't carpet-bomb
// Telegram. Read-only — does not touch tools/wallet.js (Vega VETO).
const BALANCE_DRAIN_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h
let _lastBalanceDrainAlertAt = 0;

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee, dryRun = false }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  // DRY_RUN marker — Bro wants live PnL pulse even in paper mode.
  // No tx/position in paper deploys, so render those lines conditionally.
  const header = dryRun ? `🔵 <b>SIMULATION — Paper Deploy</b>` : `✅ <b>Deployed</b>`;
  const positionLine = position
    ? `Position: <code>${htmlEscape(String(position).slice(0, 8))}...</code>\n`
    : (dryRun ? `Position: <i>[PAPER — not on-chain]</i>\n` : "");
  const txLine = tx
    ? `Tx: <code>${htmlEscape(String(tx).slice(0, 16))}...</code>`
    : (dryRun ? `Tx: <i>[PAPER — no transaction]</i>` : "");
  await sendHTML(
    `${header} ${htmlEscape(pair)}\n` +
    `Amount: ${htmlEscape(amountSol)} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    positionLine +
    txLine
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, pnlSol, feesSol, durationMin, feeInclusivePnlPct, lpPnlPct, realizedSolDelta, realizedSolDeltaPct, realizedSolEstimate = false, positionAddress = null, dryRun = false }) {
  if (hasActiveLiveMessage()) return;
  // Skip if the user just closed this manually via /close (inline echo already sent)
  if (positionAddress) {
    const t = _manualClosedAt.get(positionAddress);
    if (t && Date.now() - t < MANUAL_CLOSE_SKIP_MS) {
      _manualClosedAt.delete(positionAddress);
      return;
    }
  }

  // ── Outcome sign — keyed to WALLET-TRUTH realized SOL, NOT the flattering
  // price-only pnl% (Lyra money-honesty fix, Bro complaint 2026-07-11). A trade
  // whose LP-PnL reads +0.5% but whose wallet delta is negative (slippage+gas ate
  // the thin win) must READ as a loss. Emoji follows the number that actually
  // moved the wallet, via the shared closeOutcomeEmoji() single-source-of-truth.
  const hasRealized = Number.isFinite(realizedSolDelta);
  const resultEmoji = closeOutcomeEmoji({ realizedSolDelta, pnlSol, pnlPct });

  const header = dryRun
    ? `🔵 <b>SIMULATION — Paper Close</b> ${resultEmoji}`
    : `${resultEmoji} <b>Closed</b>`;

  // ── LEAD LINE — Realized SOL (wallet truth): big, first, bold. This is the
  // number the wallet actually moved by (net IL + close-swap slippage + gas).
  // ⚠️est flags a formula/paper estimate vs a measured wallet delta.
  let realizedLead;
  if (hasRealized) {
    const estTag = realizedSolEstimate ? " ⚠️est" : "";
    const pctTag = Number.isFinite(realizedSolDeltaPct)
      ? ` (${realizedSolDeltaPct >= 0 ? "+" : ""}${Number(realizedSolDeltaPct).toFixed(2)}%)`
      : "";
    realizedLead =
      `💰 <b>Realized SOL: ${realizedSolDelta >= 0 ? "+" : ""}${Number(realizedSolDelta).toFixed(4)} SOL${pctTag}${estTag}</b>\n` +
      `<i>(uang bersih masuk wallet — sudah dikurangi IL + slippage + gas close)</i>`;
  } else {
    // No ledger figure (legacy record / paper without sim delta). Be honest —
    // NEVER claim a wallet-truth number we don't have (anti-pattern #2).
    realizedLead = `💰 <b>Realized SOL: belum tersedia</b>\n<i>(pakai angka harga di bawah — belum ada catatan ledger)</i>`;
  }

  // ── SECONDARY — price-only LP-PnL, clearly demoted + labelled so it is NEVER
  // read as the net SOL outcome. This was the misleading headline Bro flagged.
  const lpLabelPct = Number.isFinite(lpPnlPct) ? lpPnlPct : pnlPct;
  const lpUsdStr = Number.isFinite(pnlUsd)
    ? `${pnlUsd >= 0 ? "+" : ""}$${Number(pnlUsd).toFixed(2)} `
    : "";
  const lpPnlLine = `\nLP-PnL (harga saja, bukan SOL bersih): ${lpUsdStr}(${(lpLabelPct ?? 0) >= 0 ? "+" : ""}${(lpLabelPct ?? 0).toFixed(2)}%)`;

  const feesLine = Number.isFinite(feesSol) && feesSol > 0
    ? `\nFees collected: ${Number(feesSol).toFixed(4)} SOL`
    : "";
  const feeInclusiveLine = Number.isFinite(feeInclusivePnlPct)
    ? `\nFee-inclusive PnL: ${feeInclusivePnlPct >= 0 ? "+" : ""}${Number(feeInclusivePnlPct).toFixed(2)}%`
    : "";
  const durationLine = Number.isFinite(durationMin) && durationMin >= 0
    ? `\nDuration: ${formatDuration(durationMin)}`
    : "";

  // ── "received < sent" explainer — shown ONCE, only on a LIVE loss (the
  // confusing case where less SOL comes back than went in). One short line so
  // Bro stops being puzzled by the raw explorer view.
  const explainerLine = (!dryRun && hasRealized && Number(realizedSolDelta) < 0)
    ? `\n<i>ℹ️ "Diterima &lt; dikirim" itu wajar: rent akun posisi balik pas close &amp; sisa token di-swap ke SOL di tx terpisah — patokan = Realized SOL di atas, bukan 1 baris di explorer.</i>`
    : "";

  await sendHTML(
    `${header} ${htmlEscape(pair)}\n` +
    realizedLead +
    lpPnlLine +
    feesLine +
    feeInclusiveLine +
    durationLine +
    explainerLine
  );
}

function formatDuration(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${htmlEscape(inputSymbol)} → ${htmlEscape(outputSymbol)}\n` +
    `In: ${htmlEscape(amountIn ?? "?")} | Out: ${htmlEscape(amountOut ?? "?")}\n` +
    `Tx: <code>${htmlEscape(tx?.slice(0, 16))}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR, positionId = null }) {
  if (hasActiveLiveMessage()) return;
  // Per-position 6h cooldown to avoid mgmt-tick spam
  const key = positionId || pair;
  if (key) {
    const last = _oorLastAlertedAt.get(key) || 0;
    if (Date.now() - last < OOR_ALERT_COOLDOWN_MS) return;
    _oorLastAlertedAt.set(key, Date.now());
  }
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${htmlEscape(pair)}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

// Structured deploy-failure alert (Vega fix #2). No retry — operator-only signal.
export async function notifyDeployFailure({ pool, error, walletBalance } = {}) {
  if (!TOKEN || !chatId) return;
  const reason = String(error?.message || error || "unknown error").slice(0, 200);
  const poolLabel = pool?.symbol || pool?.pair || pool?.name || "unknown";
  const poolAddr = pool?.address || pool?.pool_address || pool?.pool || "";
  const addrShort = poolAddr ? `${String(poolAddr).slice(0, 8)}...` : "n/a";
  const balStr = walletBalance != null ? `${walletBalance} SOL` : "unknown";
  try {
    await sendHTML(
      `❌ <b>Deploy FAILED</b>\n` +
      `Pool: ${htmlEscape(poolLabel)} (<code>${htmlEscape(addrShort)}</code>)\n` +
      `Reason: ${htmlEscape(reason)}\n` +
      `Wallet: ${htmlEscape(balStr)}\n` +
      `Action required: manual on-chain verification before any retry`
    );
  } catch (e) {
    log("telegram_error", `notifyDeployFailure failed: ${e.message}`);
  }
}

// Circuit breaker alert. Fires once on halted=false→true; suppressed rest of UTC day.
export async function notifyCircuitBreaker(state = {}) {
  if (!TOKEN || !chatId) return;
  try {
    const lossSol = Number(state.realized_loss_sol ?? 0).toFixed(4);
    const lossPct = Number(state.realized_loss_pct ?? 0).toFixed(1);
    const closed = state.positions_closed_today ?? 0;
    const reason = htmlEscape(state.halt_reason || "cap reached");
    await sendHTML(
      `🚨 <b>CIRCUIT BREAKER TRIPPED</b>\n` +
      `Reason: ${reason}\n` +
      `Realized loss today: ${lossSol} SOL (${lossPct}% of starting balance)\n` +
      `Positions closed today: ${closed}\n` +
      `New deploys: <b>BLOCKED</b> until UTC midnight\n` +
      `Manual override: set <code>CIRCUIT_BREAKER_OVERRIDE=true</code> in .env (single-shot)`
    );
  } catch (e) {
    log("telegram_error", `notifyCircuitBreaker failed: ${e.message}`);
  }
}

// Budget-cap alert (Vega fix #1). 12h throttle, never escalates failures.
export async function notifyBudgetExceeded({ status, caller } = {}) {
  if (!TOKEN || !chatId) return;
  const now = Date.now();
  if (now - _lastBudgetAlertAt < BUDGET_ALERT_COOLDOWN_MS) return;
  _lastBudgetAlertAt = now;
  try {
    const daily = status?.daily || {};
    const weekly = status?.weekly || {};
    const dSpent = Number(daily.spent ?? 0).toFixed(2);
    const dCap = Number(daily.cap ?? 0).toFixed(2);
    const wSpent = Number(weekly.spent ?? 0).toFixed(2);
    const wCap = Number(weekly.cap ?? 0).toFixed(2);
    await sendMessage(
      `🚨 LLM cost cap hit\n` +
      `Spent today: $${dSpent} / $${dCap}\n` +
      `This week: $${wSpent} / $${wCap}\n` +
      `Caller: ${caller || "unknown"}\n` +
      `Halting LLM calls until reset.`
    );
  } catch (e) {
    log("telegram_error", `notifyBudgetExceeded failed: ${e.message}`);
  }
}

// Burner balance-drain alert (Sirius Pillar B fix #4).
// Emits a structured Telegram alert when SOL balance drops by >dropPct since
// the last sample. Operator-only signal — no auto-action taken.
//   beforeSol — SOL balance at previous sample (last management cycle start)
//   afterSol  — SOL balance now
//   dropPct   — observed drop in % (positive number, e.g. 22.5 for 22.5% drop)
// Throttled by BALANCE_DRAIN_ALERT_COOLDOWN_MS (1h).
export async function notifyBalanceDrain(beforeSol, afterSol, dropPct) {
  if (!TOKEN || !chatId) return;
  const now = Date.now();
  if (now - _lastBalanceDrainAlertAt < BALANCE_DRAIN_ALERT_COOLDOWN_MS) return;
  _lastBalanceDrainAlertAt = now;
  try {
    const before = Number.isFinite(beforeSol) ? Number(beforeSol).toFixed(4) : "?";
    const after = Number.isFinite(afterSol) ? Number(afterSol).toFixed(4) : "?";
    const drop = Number.isFinite(dropPct) ? Number(dropPct).toFixed(2) : "?";
    const deltaSol = (Number.isFinite(beforeSol) && Number.isFinite(afterSol))
      ? (Number(afterSol) - Number(beforeSol)).toFixed(4)
      : "?";
    await sendHTML(
      `🚨 <b>BURNER BALANCE DRAIN</b>\n` +
      `Before: ${htmlEscape(before)} SOL\n` +
      `After: ${htmlEscape(after)} SOL\n` +
      `Delta: ${htmlEscape(deltaSol)} SOL (${htmlEscape(drop)}% drop)\n` +
      `Action required: verify wallet — possible drain, leak, or unexpected close`
    );
  } catch (e) {
    log("telegram_error", `notifyBalanceDrain failed: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
