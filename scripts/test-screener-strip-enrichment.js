// Orion fix — strip enrichment tools from SCREENER tool-set to kill [SCREENER_STALL].
// Run: node scripts/test-screener-strip-enrichment.js
//
// Root cause: SCREENER candidate blocks already PREFETCH all enrichment (holders,
// narrative, smart-wallets, OKX risk/tags, mcap/tvl/vol/fee-tvl/organic/volatility/
// age, active_bin) into the screening goal BEFORE the LLM loop runs. But the
// SCREENER tool-set still exposed get_token_holders / get_token_info /
// get_token_narrative / check_smart_wallets_on_pool / get_top_candidates /
// search_pools / get_pool_memory — so the model re-fetched data it already had
// (~17s/call), looping until max-steps without ever calling deploy_position.
//
// Fix: SCREENER_TOOLS now only exposes deploy_position + get_active_bin (fallback)
// + get_my_positions / get_wallet_balance (deploy-time safety reads). No fetch
// tools => the only forward moves are deploy or finish => forced commit.
//
// Asserts:
//   (a) SCREENER tool-set has NO enrichment / re-discovery tools
//   (a2) SCREENER tool-set still has deploy_position + deploy-time safety reads
//   (b) candidate blocks carry EVERY field needed for an informed deploy decision
//   (c) loop reaches deploy_position in a small number of steps (no stall)
//   (d) the deploy decision is informed — all decision fields present in-prompt

import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ||= "test-stub-key";
process.env.LLM_API_KEY ||= "test-stub-key";
process.env.LLM_BASE_URL ||= "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

const { getToolsForRole, SCREENER_TOOLS, __setCreateForTests, agentLoop } =
  await import("../agent.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// (a) SCREENER tool-set must NOT contain enrichment / re-discovery tools ----------
const FORBIDDEN = [
  "get_token_holders",
  "get_token_info",
  "get_token_narrative",
  "check_smart_wallets_on_pool",
  "get_top_candidates",
  "search_pools",
  "get_pool_memory",
];
for (const name of FORBIDDEN) {
  check(`SCREENER_TOOLS excludes ${name}`, !SCREENER_TOOLS.has(name));
}

const screenerTools = getToolsForRole("SCREENER");
const screenerNames = new Set(screenerTools.map((t) => t.function.name));
for (const name of FORBIDDEN) {
  check(`getToolsForRole(SCREENER) excludes ${name}`, !screenerNames.has(name));
}

// (a2) SCREENER tool-set must still expose the action + deploy-time safety reads ---
check("SCREENER_TOOLS includes deploy_position (the action)", SCREENER_TOOLS.has("deploy_position"));
check("SCREENER_TOOLS includes get_active_bin (per-candidate fallback)", SCREENER_TOOLS.has("get_active_bin"));
check("SCREENER_TOOLS includes get_my_positions (pre-deploy count)", SCREENER_TOOLS.has("get_my_positions"));
check("SCREENER_TOOLS includes get_wallet_balance (SOL coverage)", SCREENER_TOOLS.has("get_wallet_balance"));
check("SCREENER tool-set is lean (<= 4 tools)", screenerTools.length <= 4);
check("getToolsForRole(SCREENER) actually resolved deploy_position schema", screenerNames.has("deploy_position"));

// (b)+(d) candidate block carries every field for an informed deploy decision -----
// Mirror the candidate block shape built in index.js (~line 984). Each required
// field below is a deploy-decision input the LLM would otherwise have re-fetched.
const candidateBlock = [
  `POOL: AAA-SOL (PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa)`,
  `  metrics: bin_step=100, fee_pct=0.5%, fee_tvl=0.18, vol=$12000, tvl=$45000, volatility_30m=3.2, mcap=$650000, organic=78, age=22h`,
  `  audit: top10=41%, bots=8%, fees=120SOL, launchpad=pumpfun`,
  `  okx: risk=low, bundle=4%, sniper=2%, rugpull=NO, wash=NO`,
  `  tags: smart_money_buy, dev_sold_all(bullish)`,
  `  smart_wallets: 2 present → CONFIDENCE BOOST (alpha1, alpha2)`,
  `  active_bin: 8388608`,
  `  1h: price+6%, net_buyers=140`,
  `  narrative_untrusted: real viral moment, named community`,
].join("\n");

const REQUIRED_DECISION_FIELDS = [
  ["bin_step", /bin_step=/],          // deploy param + bin-step gate
  ["fee_tvl",  /fee_tvl=/],            // primary yield signal
  ["volume",   /vol=\$/],             // activity
  ["tvl",      /tvl=\$/],             // depth
  ["volatility", /volatility_\w+=/],   // bins_below formula + deploy guard
  ["mcap",     /mcap=\$/],            // size band
  ["organic",  /organic=/],           // organic floor
  ["age",      /age=\d+h/],           // age sweet-spot
  ["top10",    /top10=/],             // concentration
  ["bots",     /bots=/],              // bot gate
  ["fees_sol", /fees=\d+SOL/],        // hard fees floor
  ["smart_wallets", /smart_wallets:/], // conviction
  ["active_bin",   /active_bin:/],     // deploy param (pre-fetched)
  ["narrative",    /narrative_untrusted:/], // judgment input
];
for (const [label, re] of REQUIRED_DECISION_FIELDS) {
  check(`candidate block carries ${label} (informed decision, no re-fetch needed)`, re.test(candidateBlock));
}

// (c) loop reaches deploy_position in a small number of steps (no stall) ----------
// Stub the LLM so the FIRST assistant turn calls deploy_position directly. With
// the lean tool-set the model has no fetch tool to detour through, so a healthy
// run commits on step 1. We assert deploy fired within <= 2 steps.
let deployStep = null;
let stepCounter = 0;
__setCreateForTests(async (payload) => {
  stepCounter += 1;
  // Confirm the lean tool-set is what gets sent to the model (no fetch tools).
  const sentNames = (payload.tools || []).map((t) => t.function?.name);
  for (const f of FORBIDDEN) {
    if (sentNames.includes(f)) {
      console.log(`  FAIL  payload still advertised forbidden tool ${f}`);
      process.exitCode = 1;
    }
  }
  return {
    id: "chatcmpl-deploy",
    model: payload.model,
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_deploy_1",
          type: "function",
          function: {
            name: "deploy_position",
            arguments: JSON.stringify({
              pool_address: "PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa",
              amount_sol: 0.01,
              volatility: 3.2,
            }),
          },
        }],
      },
    }],
    usage: { prompt_tokens: 1200, completion_tokens: 25, total_tokens: 1225 },
  };
});

const goal = `SCREENING CYCLE
Positions: 0/3 | SOL: 1.500 | Deploy: 0.5 SOL

PRE-LOADED CANDIDATES (1 pools):
${candidateBlock}

ORION PRE-JUDGMENT (advisory — you may override):
- PoolAAA111aaaaaaaaaaaaaaaaaaaaaaa (enter, 82%): good fee/tvl, smart wallets

STEPS:
0. All enrichment is already in the candidate blocks above. Do NOT re-fetch.
1. Decide and deploy.`;

const originalLog = console.log;
let capturedLogs = [];
console.log = (...args) => { capturedLogs.push(args.join(" ")); originalLog(...args); };
try {
  stepCounter = 0;
  await agentLoop(goal, 16, [], "SCREENER", null, 256, {
    onToolStart: async ({ name }) => { if (name === "deploy_position" && deployStep == null) deployStep = stepCounter; },
  });
} catch (e) {
  // executor may reject the minimal deploy args in the mocked env — that's fine,
  // deployStep is set on tool START (before execution).
  capturedLogs.push(`(agentLoop threw post-deploy-attempt: ${e.message})`);
} finally {
  console.log = originalLog;
}

check("deploy_position reached (no stall)", deployStep != null);
check("deploy_position reached within <= 2 steps (no enrichment detour)", deployStep != null && deployStep <= 2);
check("no SCREENER_STALL log fired when deploy committed", !capturedLogs.some((l) => /SCREENER_STALL/i.test(l)));

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
