#!/usr/bin/env node
/**
 * test-snapshot-redact.js — Sirius 🐺
 * Builds snapshot, scans for leak markers. FAIL if any hit.
 */
import { buildSnapshot, pickSafe, CONFIG_ALLOWLIST } from './lib/snapshot-builder.js';

const LEAK_PATTERNS = [
  /sk-/i,
  /helius/i,
  /\bbot[_-]?token\b/i,
  /\bPRIVATE\b/,
  /RPC_URL/,
  // Telegram/Discord: only flag credential-like contexts, not the service-name "telegram-userbot"
  /TELEGRAM_(?:BOT_TOKEN|CHAT_ID|API)/i,
  /DISCORD_(?:TOKEN|WEBHOOK|BOT)/i,
  /[0-9]{8,12}:[A-Za-z0-9_-]{30,}/, // raw telegram bot-token shape
  /WALLET_PRIVATE/i,
  /pool_address/i,
  /base_mint/i,
  /tx_sig/i,
  /\bbin_range\b/i,
  /\bclose_reason\b/i,
];

(async () => {
  process.env.HELIUS_API_KEY = 'helius-leak-bait-xxxxx';
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-leak-bait';

  const snap = await buildSnapshot();
  const text = JSON.stringify(snap);

  const hits = [];
  for (const re of LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ pattern: re.toString(), match: m[0] });
  }

  if (hits.length > 0) {
    console.error('[redact-test] FAIL — leak markers detected:');
    for (const h of hits) console.error(`  ${h.pattern} → "${h.match}"`);
    process.exit(1);
  }

  console.log('[redact-test] PASS — no leak markers in snapshot payload');
  console.log(`[redact-test] payload size: ${text.length} bytes, keys: ${Object.keys(snap).join(',')}`);

  // --- config_active key-mapping assertions (bug fix verification) ---
  const mockUC = {
    dryRun: true,
    outOfRangeWaitMinutes: 20,
    oorCooldownHours: 6,
    deployAmountSol: 0.1,
    maxPositions: 1,
    maxBundlePct: 20,
    maxTop10Pct: 60,
    liveOverrides: { maxBotHoldersPct: 25, maxTop10Pct: 55 },
  };
  const active = pickSafe(mockUC);
  const expects = {
    dryRun: true,
    oor_wait_min: 20,
    oor_cooldown_h: 6,
    deploy_amount_sol: 0.1,
    max_positions: 1,
    max_bot_pct: 25,        // liveOverrides wins
    max_bundlers_pct: 20,
    max_top10_pct: 55,      // liveOverrides wins
  };
  const mismatches = [];
  for (const [k, v] of Object.entries(expects)) {
    if (active[k] !== v) mismatches.push(`${k}: got ${JSON.stringify(active[k])}, expected ${JSON.stringify(v)}`);
  }
  // Default-deny: no extra keys outside allowlist
  for (const k of Object.keys(active)) {
    if (!CONFIG_ALLOWLIST.has(k)) mismatches.push(`extra key leaked: ${k}`);
  }
  if (mismatches.length > 0) {
    console.error('[config-active-test] FAIL:');
    for (const m of mismatches) console.error('  ' + m);
    process.exit(1);
  }
  console.log(`[config-active-test] PASS — ${Object.keys(expects).length} keys mapped correctly`);
})().catch(err => {
  console.error('[redact-test] ERROR:', err);
  process.exit(2);
});
