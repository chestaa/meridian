// Test for agents/orion.js bluechip-aware judge prompt (Orion).
// Run: node scripts/test-orion-bluechip.js
// Does NOT spend real LLM tokens — captures the system prompt + user payload the
// judge would send via a fake OpenAI client, with bluechipModeEnabled toggled.
//
// Proves the LLM-judge prompt MIRRORS the deterministic code carve-out:
//   - bluechip mode ON  → SOL-USDC (bin_step=1, fee/TVL 0.0562) gets a bluechip
//     candidate flag (is_bluechip=true) AND a system prompt that tells the judge
//     to ACCEPT small bin_step / low vol / lower fee/TVL (so Orion CAN enter).
//   - bluechip mode OFF → memecoin prompt unchanged, is_bluechip=false, no
//     bluechip block (memecoin path byte-for-byte unchanged).
//   - a non-whitelisted (memecoin) pool in bluechip mode → is_bluechip=false,
//     standard memecoin rules apply.

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "MemeMemeMemeMemeMemeMemeMemeMemeMemeMeme111";

// Capture the exact messages the judge sends.
let captured = [];
const fakeClient = {
  chat: { completions: { create: async (payload) => {
    captured.push(payload);
    const userMsg = payload.messages?.find?.((m) => m.role === "user")?.content || "{}";
    const poolAddr = JSON.parse(userMsg)?.candidate?.pool_address || "UNKNOWN";
    return {
      id: "chatcmpl-test", model: payload.model || "test-model",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "judge_candidate",
          arguments: JSON.stringify({ pool_address: poolAddr, decision: "enter", confidence: 70, reason: "ok", recommended_bins_below: 200 }) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    };
  } } },
};

const { config } = await import("../config.js");
const { judgeCandidates, __setClientForTests } = await import("../agents/orion.js");
__setClientForTests(fakeClient);

// SOL-USDC: bin_step=1, fee/TVL 0.0562 (the exact blocker pool from the soak), deep TVL.
const solUsdc = {
  pool: {
    pool: "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR", name: "SOL-USDC",
    bin_step: 1, fee_pct: 0.01, fee_active_tvl_ratio: 0.0562, volume_window: 800000,
    tvl: 2_500_000, volatility: 0.1, organic_score: null, mcap: 40_000_000_000, token_age_hours: 9999,
    base: { mint: WSOL }, quote: { mint: USDC },
  },
  sw: { in_pool: [] }, n: { narrative: null }, ti: { audit: {}, global_fees_sol: null, launchpad: null }, mem: null,
};
// A memecoin pool (non-whitelisted base) — must STAY in the memecoin lane even in bluechip mode.
const memePool = {
  pool: {
    pool: "MemePoolXXX", name: "MEME-SOL",
    bin_step: 100, fee_pct: 1, fee_active_tvl_ratio: 0.08, volume_window: 12000,
    tvl: 50000, volatility: 3.2, organic_score: 75, mcap: 800000, token_age_hours: 24,
    base: { mint: MEME }, quote: { mint: WSOL },
  },
  sw: { in_pool: [] }, n: { narrative: "meme" }, ti: { audit: {}, global_fees_sol: 80, launchpad: null }, mem: null,
};

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}
const sysOf = (i) => captured[i].messages.find(m => m.role === "system").content;
const userOf = (i) => JSON.parse(captured[i].messages.find(m => m.role === "user").content);

// ── Scenario A: bluechip mode OFF (memecoin path — must be unchanged) ──────────
config.screening.bluechipModeEnabled = false;
captured = [];
await judgeCandidates([solUsdc], { portfolio: { sol: 2.5 }, positions: { total_positions: 0 } });
check("OFF: system prompt has NO bluechip block", !/BLUECHIP INCOME-ENGINE MODE IS ON/.test(sysOf(0)));
check("OFF: system prompt keeps memecoin bins range [35,69]", /\[35,69\]/.test(sysOf(0)));
check("OFF: candidate.is_bluechip is false (flag off)", userOf(0).candidate.is_bluechip === false);
// Prompt-bleed guard: the max-TVL / mcap-band EXEMPTION must NOT leak into the
// memecoin lane — memecoins DO respect the TVL band + mcap band (base SYSTEM_PROMPT).
check("OFF: NO max-TVL-cap exemption in memecoin prompt", !/NO maximum-TVL cap for a bluechip/.test(sysOf(0)));
check("OFF: NO $150K-does-not-apply exemption in memecoin prompt", !/\$150K/.test(sysOf(0)));
check("OFF: memecoin base prompt still lists TVL band + mcap band as criteria", /TVL band/.test(sysOf(0)) && /mcap band/.test(sysOf(0)));

// ── Scenario B: bluechip mode ON + SOL-USDC (the soak blocker) ─────────────────
config.screening.bluechipModeEnabled = true;
config.screening.bluechipMaxBinStep = config.screening.bluechipMaxBinStep ?? 200;
config.screening.bluechipMinFeeTvlRatio = config.screening.bluechipMinFeeTvlRatio ?? 0.03;
config.screening.bluechipMaxVolatility = config.screening.bluechipMaxVolatility ?? 1.5;
captured = [];
await judgeCandidates([solUsdc], { portfolio: { sol: 2.5 }, positions: { total_positions: 0 } });
const sysB = sysOf(0);
check("ON: system prompt HAS bluechip block", /BLUECHIP INCOME-ENGINE MODE IS ON/.test(sysB));
check("ON: prompt tells judge to accept small bin_step", /NEVER skip a bluechip for a small bin_step/.test(sysB));
check("ON: prompt says low volatility is GOOD for bluechip", /LOW \/ near-zero volatility is GOOD/.test(sysB));
check("ON: prompt states bluechip fee/TVL bar 0.03 (not memecoin 0.10)", /income fee\/TVL bar is 0\.03/.test(sysB));
check("ON: prompt allows wide bins_below up to 250", /up to 250/.test(sysB));
// Prompt-bleed FIX (the soak blocker): bluechip prompt must EXPLICITLY exempt the
// $150K max-TVL ceiling AND the memecoin mcap band, so the judge stops refusing
// the $2.5M SOL-USDC / $2.8M JitoSOL-SOL pools for "TVL/mcap too high".
check("ON: prompt states NO maximum-TVL cap for bluechip", /NO maximum-TVL cap for a bluechip/.test(sysB));
check("ON: prompt says the $150K memecoin max-TVL ceiling does NOT apply", /\$150K/.test(sysB) && /do NOT apply/.test(sysB));
check("ON: prompt exempts bluechip from the memecoin mcap band (150k-10M)", /mcap band \(150k-10M\)/.test(sysB));
check("ON: prompt says billions-size mcap is a GREEN flag, not a skip", /GREEN flag/.test(sysB));
check("ON: SOL-USDC candidate is_bluechip=true (mirrors code carve-out)", userOf(0).candidate.is_bluechip === true);
check("ON: SOL-USDC bin_step=1 still passed through to judge", userOf(0).candidate.metrics.bin_step === 1);
check("ON: SOL-USDC $2.5M TVL + $40B mcap still passed through (judge sees real size)",
  userOf(0).candidate.metrics.tvl === 2_500_000 && userOf(0).candidate.metrics.mcap === 40_000_000_000);

// ── Scenario C: bluechip mode ON + a memecoin pool (must stay memecoin lane) ───
captured = [];
await judgeCandidates([memePool], { portfolio: { sol: 2.5 }, positions: { total_positions: 0 } });
check("ON: memecoin pool is_bluechip=false (non-whitelisted legs)", userOf(0).candidate.is_bluechip === false);
check("ON: bluechip block still present but tells judge to fall back for non-bluechip",
  /candidate.is_bluechip is false\/absent, apply the standard \(memecoin\) rules/.test(sysOf(0)));

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
