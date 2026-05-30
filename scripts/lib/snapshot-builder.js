/**
 * snapshot-builder.js — Sirius 🐺
 *
 * Pure file-read + raw RPC builder for status snapshot.
 * STRICT: zero imports of executor/wallet/dlmm/state-write modules.
 * Strategy-leak fields STRIPPED per Lyra cond c.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, PublicKey } from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const BURNER_PUBKEY = process.env.SNAPSHOT_PUBKEY
  || 'DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu';

// Strict allowlist — default deny. Strategy-leak keys must NEVER appear here.
// Output keys (snake_case) for the snapshot consumer.
export const CONFIG_ALLOWLIST = new Set([
  'dryRun',
  'oor_wait_min',
  'oor_cooldown_h',
  'deploy_amount_sol',
  'max_positions',
  'max_bot_pct',
  'max_bundlers_pct',
  'max_top10_pct',
]);

function readJsonSafe(file, fallback = null) {
  try {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function pickSafe(userConfig) {
  const uc = userConfig || {};
  const live = uc.liveOverrides || {};
  // Explicit mapping: real user-config.json schema is FLAT (top-level keys).
  // liveOverrides takes precedence when present.
  const candidate = {
    dryRun: uc.dryRun ?? null,
    oor_wait_min: uc.outOfRangeWaitMinutes ?? null,
    oor_cooldown_h: uc.oorCooldownHours ?? null,
    deploy_amount_sol: uc.deployAmountSol ?? null,
    max_positions: uc.maxPositions ?? null,
    max_bot_pct: live.maxBotHoldersPct ?? uc.maxBotHoldersPct ?? null,
    max_bundlers_pct: live.maxBundlePct ?? uc.maxBundlePct ?? null,
    max_top10_pct: live.maxTop10Pct ?? uc.maxTop10Pct ?? null,
  };
  // Enforce allowlist (default deny).
  const out = {};
  for (const key of CONFIG_ALLOWLIST) {
    if (candidate[key] !== undefined) out[key] = candidate[key];
  }
  return out;
}

export function maskPubkey(pk) {
  if (!pk || pk.length < 10) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

async function fetchWalletSol(rpcUrl, pubkey) {
  if (!rpcUrl) return null;
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    const lamports = await conn.getBalance(new PublicKey(pubkey));
    return lamports / 1e9;
  } catch {
    return null;
  }
}

function summarizeOpenPositions(stateJson) {
  const positions = Array.isArray(stateJson?.positions) ? stateJson.positions : [];
  const open = positions.filter(p => !p.closed && !p.closed_at);
  let totalValueSol = 0;
  let pnlAccum = 0;
  let pnlSamples = 0;
  for (const p of open) {
    if (typeof p.current_value_sol === 'number') totalValueSol += p.current_value_sol;
    else if (typeof p.deployed_sol === 'number') totalValueSol += p.deployed_sol;
    if (typeof p.pnl_pct === 'number' && isFinite(p.pnl_pct)) {
      pnlAccum += p.pnl_pct; pnlSamples++;
    }
  }
  return {
    open_count: open.length,
    open_total_value_sol: Number(totalValueSol.toFixed(6)),
    open_aggregate_pnl_pct: pnlSamples > 0 ? Number((pnlAccum / pnlSamples).toFixed(2)) : 0,
  };
}

// Exported for unit tests. Pure: takes lessons-shaped object + windowMs + optional now.
export function summarizeClosed(lessonsJson, windowMs, nowMs = Date.now()) {
  // lessons.js writes to `performance` array. Keep `records`/`closed` as
  // defensive fallbacks for forward/back-compat.
  const records = Array.isArray(lessonsJson?.performance)
    ? lessonsJson.performance
    : (Array.isArray(lessonsJson?.records)
        ? lessonsJson.records
        : (Array.isArray(lessonsJson?.closed) ? lessonsJson.closed : []));

  const inWindow = records.filter(r => {
    const tRaw = r.closed_at || r.recorded_at || r.ts || r.timestamp || '';
    const t = Date.parse(tRaw);
    return isFinite(t) && (nowMs - t) <= windowMs && (nowMs - t) >= 0;
  });

  if (inWindow.length === 0) {
    return { count: 0, pnl_sum_sol: 0, realized_sol_sum: 0, win_rate: null };
  }

  let pnlSum = 0;
  // Vega fix #1 — TRUE economic sum (realized_sol_delta, incl. IL + slippage +
  // gas). Falls back to the price-only pnl_sol per-record when realized is absent
  // (old records / accounting disabled), so this is never less informative.
  let realizedSum = 0;
  let wins = 0;
  for (const r of inWindow) {
    // Prefer explicit SOL fields; otherwise convert pnl_pct × amount_sol.
    let pnlSol;
    if (typeof r.pnl_sol === 'number' && isFinite(r.pnl_sol)) {
      pnlSol = r.pnl_sol;
    } else if (typeof r.realized_pnl_sol === 'number' && isFinite(r.realized_pnl_sol)) {
      pnlSol = r.realized_pnl_sol;
    } else if (typeof r.pnl_pct === 'number' && isFinite(r.pnl_pct)
      && typeof r.amount_sol === 'number' && isFinite(r.amount_sol)) {
      pnlSol = (r.pnl_pct / 100) * r.amount_sol;
    } else {
      pnlSol = 0;
    }
    pnlSum += pnlSol;

    const realizedDelta = typeof r.realized_sol_delta === 'number' && isFinite(r.realized_sol_delta)
      ? r.realized_sol_delta
      : pnlSol;
    realizedSum += realizedDelta;

    // Win definition: pnl_pct > 0 primary; fallback pnl_sol > 0;
    // also count exits flagged with "Trailing TP" close_reason as wins.
    const reason = String(r.close_reason || '').toLowerCase();
    const isTrailingTP = reason.includes('trailing tp');
    let isWin = false;
    if (typeof r.pnl_pct === 'number' && isFinite(r.pnl_pct)) {
      isWin = r.pnl_pct > 0;
    } else {
      isWin = pnlSol > 0;
    }
    if (isWin || isTrailingTP) wins++;
  }

  return {
    count: inWindow.length,
    pnl_sum_sol: Number(pnlSum.toFixed(6)),
    realized_sol_sum: Number(realizedSum.toFixed(6)),
    win_rate: Number((wins / inWindow.length).toFixed(2)),
  };
}

function llmCost24h(usageJson) {
  const records = Array.isArray(usageJson?.records) ? usageJson.records : [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const r of records) {
    const t = Date.parse(r.ts || '');
    if (isFinite(t) && t >= cutoff && typeof r.cost_usd === 'number') sum += r.cost_usd;
  }
  return Number(sum.toFixed(4));
}

function detectServices(userConfig) {
  const all = ['meridian', 'signal-runner', 'telegram-userbot', 'auto-screener'];
  const disabled = new Set(userConfig?.services?.disabled || []);
  return all.filter(s => !disabled.has(s));
}

export async function buildSnapshot({ rpcUrl } = {}) {
  const userConfig = readJsonSafe('user-config.json', {});
  const state = readJsonSafe('state.json', {});
  const lessons = readJsonSafe('lessons.json', {});
  const circuit = readJsonSafe('circuit-breaker-state.json', {});
  const llmUsage = readJsonSafe('llm-usage.json', {});

  const solFree = await fetchWalletSol(rpcUrl || process.env.RPC_URL, BURNER_PUBKEY);

  const dust = Array.isArray(state?.wallet_dust)
    ? state.wallet_dust.map(t => ({ symbol: String(t.symbol || '?'), qty: Number(t.qty || 0) }))
    : [];

  const open = summarizeOpenPositions(state);
  const closed24 = summarizeClosed(lessons, 24 * 60 * 60 * 1000);
  const closed7 = summarizeClosed(lessons, 7 * 24 * 60 * 60 * 1000);

  return {
    ts: new Date().toISOString(),
    wallet: {
      pubkey: maskPubkey(BURNER_PUBKEY),
      sol_free: solFree == null ? null : Number(solFree.toFixed(6)),
      tokens: dust,
    },
    summary: {
      open_count: open.open_count,
      open_total_value_sol: open.open_total_value_sol,
      open_aggregate_pnl_pct: open.open_aggregate_pnl_pct,
      closed_24h_count: closed24.count,
      closed_24h_pnl_sum_sol: closed24.pnl_sum_sol,
      // Vega fix #1 — TRUE realized SOL (economic, incl. IL + slippage + gas).
      closed_24h_realized_sol_sum: closed24.realized_sol_sum,
      closed_7d_count: closed7.count,
      closed_7d_pnl_sum_sol: closed7.pnl_sum_sol,
      closed_7d_realized_sol_sum: closed7.realized_sol_sum,
      // null when no closes in window — avoids misleading "0%" win rate.
      win_rate_24h: closed24.win_rate,
      win_rate_7d: closed7.win_rate,
    },
    circuit_breaker: {
      halted: Boolean(circuit?.halted),
      realized_loss_sol: Number(circuit?.realized_loss_sol || 0),
    },
    llm_cost_24h_usd: llmCost24h(llmUsage),
    services_active: detectServices(userConfig),
    config_active: pickSafe(userConfig),
  };
}
