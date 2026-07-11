// Test for agents/orion.js — mocks OpenAI HTTP layer via global fetch stub.
// Run: node scripts/test-orion.js
// Does NOT spend real LLM tokens. Asserts verdict shape on 3 synthetic candidates.

import assert from "node:assert/strict";

// 1) Stub env BEFORE importing orion (so the OpenAI client is constructed).
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
process.env.DRY_RUN = "true";

// 2) Build a fake OpenAI-shaped client and inject via the test seam.
let fetchCallCount = 0;
const fakeClient = {
  chat: {
    completions: {
      create: async (payload) => {
        fetchCallCount += 1;
        const userMsg = payload.messages?.find?.((m) => m.role === "user")?.content || "";
        let parsedUser = {};
        try { parsedUser = JSON.parse(userMsg); } catch { /* ignore */ }
        const poolAddr = parsedUser?.candidate?.pool_address || "UNKNOWN_POOL";
        const decision = fetchCallCount % 2 === 0 ? "enter" : "skip";
        const args = {
          pool_address: poolAddr,
          decision,
          confidence: decision === "enter" ? 72 : 18,
          reason: decision === "enter" ? "good fee/tvl and smart wallets" : "low volatility and bots high",
          recommended_bins_below: 50,
        };
        return {
          id: "chatcmpl-test",
          model: payload.model || "test-model",
          choices: [{
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_test_" + fetchCallCount,
                type: "function",
                function: { name: "judge_candidate", arguments: JSON.stringify(args) },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        };
      },
    },
  },
};

// 3) Import orion AFTER env is set, then inject fake client.
const { judgeCandidates, formatOrionVerdicts, judgeCandidateSchema, flowHint, __setClientForTests } = await import("../agents/orion.js");
__setClientForTests(fakeClient);

// 4) Synthetic candidates matching index.js `passing` shape.
const candidates = [
  {
    pool: { pool: "PoolAAA111", name: "AAA-SOL", bin_step: 100, fee_pct: 1, fee_active_tvl_ratio: 0.08, volume_window: 12000, tvl: 50000, volatility: 3.2, organic_score: 75, mcap: 800000, token_age_hours: 24 },
    sw: { in_pool: [{ name: "kol1" }] },
    n: { narrative: "trending meme" },
    ti: { audit: { top_holders_pct: 40, bot_holders_pct: 12 }, global_fees_sol: 80, launchpad: null },
    mem: null,
  },
  {
    pool: { pool: "PoolBBB222", name: "BBB-SOL", bin_step: 100, fee_pct: 1, fee_active_tvl_ratio: 0.04, volume_window: 600, tvl: 12000, volatility: 1.1, organic_score: 62, mcap: 200000, token_age_hours: 10 },
    sw: { in_pool: [] },
    n: { narrative: null },
    ti: { audit: { top_holders_pct: 58, bot_holders_pct: 25 }, global_fees_sol: 35, launchpad: null },
    mem: "OOR twice last week",
  },
  {
    pool: { pool: "PoolCCC333", name: "CCC-SOL", bin_step: 80, fee_pct: 0.8, fee_active_tvl_ratio: 0.12, volume_window: 25000, tvl: 80000, volatility: 4.8, organic_score: 88, mcap: 1500000, token_age_hours: 48 },
    sw: { in_pool: [{ name: "alpha1" }, { name: "alpha2" }] },
    n: { narrative: "real product launch" },
    ti: { audit: { top_holders_pct: 35, bot_holders_pct: 8 }, global_fees_sol: 120, launchpad: null },
    mem: null,
  },
];

// 5) Assertions.
const verdicts = await judgeCandidates(candidates, { portfolio: { sol: 2.5 }, positions: { total_positions: 0 } });

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

check("schema export name", judgeCandidateSchema?.function?.name === "judge_candidate");
check("verdicts is array", Array.isArray(verdicts));
check("verdicts length matches candidates", verdicts.length === 3);
check("fetch was called once per candidate", fetchCallCount === 3);

for (let i = 0; i < verdicts.length; i++) {
  const v = verdicts[i];
  check(`verdict[${i}] has pool_address`, typeof v.pool_address === "string" && v.pool_address.length > 0);
  check(`verdict[${i}] decision is enter|skip`, v.decision === "enter" || v.decision === "skip");
  check(`verdict[${i}] confidence 0..100`, typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 100);
  check(`verdict[${i}] reason is string`, typeof v.reason === "string" && v.reason.length > 0);
  check(`verdict[${i}] pool_address matches candidate`, v.pool_address === candidates[i].pool.pool);
}

const formatted = formatOrionVerdicts(verdicts);
check("formatOrionVerdicts returns string", typeof formatted === "string" && formatted.includes("PoolAAA111"));
check("formatOrionVerdicts contains decision tag", /\((enter|skip),/.test(formatted));

// Empty input contract.
const empty = await judgeCandidates([], {});
check("empty input returns []", Array.isArray(empty) && empty.length === 0);

// ---- minTokenFeesSol floor recalibration (30→15) regression ----
// The HARD RULE (prompt.js L117 + index.js getLoneCandidateSkipReason +
// executor pre-deploy gate) rejects when global_fees_sol < config.screening.minTokenFeesSol.
// Floor was recalibrated 30→15 for the micro-cap target ($5-80k mcap can't
// structurally accumulate 30 SOL global priority fees). This locks the contract:
//   - 16 SOL → PASS the floor (>= 15)
//   - 14 SOL → SKIP (< 15)
//   - 9.81 SOL (PARQ-class) → STILL SKIP (< 15, genuinely dormant-ish — by design)
//   - missing fee data → must NOT silently pass the floor as "satisfied" (anti-pattern #2)
// Assert the CODE DEFAULT (config.js `?? 15`), independent of any gitignored
// user-config.json override on this machine. We re-load config.js with no
// user-config present by checking the default fallback directly via a fresh
// resolution against an empty override is not trivial here, so we assert the
// recalibrated floor as a fixed contract constant and verify the gate predicate.
const FLOOR = 15; // recalibrated default (config.js minTokenFeesSol ?? 15)

// Pure mirror of the index.js getLoneCandidateSkipReason fee gate.
// FAIL-CLOSED (anti-pattern #2): missing/null/NaN/non-finite fee data → SKIP
// (we cannot verify the floor → reject, never treat as pass). Returns a skip
// reason string when the candidate must be skipped, else null.
const feeSkipReason = (feesSol, floor = FLOOR) => {
  const n = Number(feesSol);
  if (!Number.isFinite(n)) return "token_fees_unknown: no valid global fee data to verify minimum";
  if (n < floor) return `token fees ${n} SOL below minimum ${floor} SOL`;
  return null;
};
// Valid-data contract is UNCHANGED by the fail-closed fix (>=15 pass, <15 skip).
check("fees 16 → above floor 15 (PASS gate)", feeSkipReason(16) === null);
check("fees 14 → below floor 15 (SKIP)", /below minimum/.test(feeSkipReason(14)));
check("fees 9.81 (PARQ-class) → still below floor 15 (SKIP, by design)", /below minimum/.test(feeSkipReason(9.81)));
check("fees exactly 15 → at floor, not below (PASS gate)", feeSkipReason(15) === null);
check("fees 30 (old floor) → above new floor 15 (PASS gate)", feeSkipReason(30) === null);
// Anti-pattern #2 fail-closed: NON-FINITE fee data (undefined/NaN/Infinity) → SKIP
// with token_fees_unknown. (This path was fail-OPEN — Orion flagged it; now fixed.)
// Either way the candidate is REJECTED — never silently treated as satisfying the floor.
check("fees NaN → SKIP token_fees_unknown (fail-closed)", /token_fees_unknown/.test(feeSkipReason(NaN)));
check("fees undefined → SKIP token_fees_unknown (fail-closed)", /token_fees_unknown/.test(feeSkipReason(undefined)));
check("fees Infinity → SKIP token_fees_unknown (non-finite, fail-closed)", /token_fees_unknown/.test(feeSkipReason(Infinity)));
// NOTE: literal null coerces via Number(null)=0 → a real "0 SOL fees" reading, which is
// genuinely below the floor → SKIP "below minimum". Still REJECTED (correct — 0 fees =
// dormant token), just not the unknown-data branch. The bug was never about a real 0.
check("fees null → Number(null)=0 → SKIP below minimum (still rejected, not a silent pass)", /below minimum/.test(feeSkipReason(null)));

// Verify config.js code default is 15 by parsing the source (override-proof).
const cfgSrc = await import("node:fs").then(fs => fs.readFileSync(new URL("../config.js", import.meta.url), "utf8"));
check("config.js default literal is `?? 15`", /minTokenFeesSol:\s*u\.minTokenFeesSol\s*\?\?\s*15\b/.test(cfgSrc));

// Lock the actual index.js fail-closed guard in source (mirror predicate above
// could drift; this asserts the real code rejects non-finite fee data first).
const idxSrc = await import("node:fs").then(fs => fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
check(
  "index.js getLoneCandidateSkipReason rejects non-finite fee BEFORE the floor check (fail-closed)",
  /if\s*\(!Number\.isFinite\(globalFeesSol\)\)\s*\{\s*\n?\s*return\s+["']token_fees_unknown/.test(idxSrc)
);

// ── Market-maker alignment: flowHint pure fn (short-gamma flow tier) ──────────
// balanced/buy-leaning flow = favorable (two-sided churn, price holds); sell-
// dominated flow = price dumping = the loser pattern. 0.40 boundary mirrors the
// direction gate's directionMinBuyShare so judge + gate speak the same language.
check("flowHint: buy-dominated → buy_leaning", flowHint(80, 20)?.tier === "buy_leaning");
check("flowHint: 50/50 → balanced", flowHint(50, 50)?.tier === "balanced");
check("flowHint: sell-dominated → sell_leaning", flowHint(20, 80)?.tier === "sell_leaning");
check("flowHint: 0.60 boundary → buy_leaning", flowHint(60, 40)?.tier === "buy_leaning");
check("flowHint: just under 0.60 → balanced", flowHint(59, 41)?.tier === "balanced");
check("flowHint: 0.40 boundary → balanced", flowHint(40, 60)?.tier === "balanced");
check("flowHint: just under 0.40 → sell_leaning", flowHint(39, 61)?.tier === "sell_leaning");
check("flowHint: buy_share_pct computed", flowHint(75, 25)?.buy_share_pct === 75);
// FAIL-SAFE (anti-pattern #2): bad/absent flow → null (neutral, never fabricate).
check("flowHint: null vols → null", flowHint(null, null) === null);
check("flowHint: zero total → null", flowHint(0, 0) === null);
check("flowHint: negative vol → null", flowHint(-1, 50) === null);
check("flowHint: NaN vol → null", flowHint(NaN, 50) === null);
check("flowHint: string garbage → null", flowHint("n/a", 50) === null);

// ── Two-fixture market-maker behavioral check (deterministic, ZERO live spend) ─
// Orion's job is signal EXTRACTION + prompt framing; the LLM does the weighting.
// So we (a) assert each fixture's compact payload carries the correct decision-
// weighting signals, and (b) run both through a faithful "thesis oracle" mock that
// applies the SAME market-maker rule the prompt documents, reading ONLY the payload
// orion built. This is NOT circular: if compactCandidate/flowHint dropped momentum,
// flow, or fee density, the oracle would see nulls and decide wrong — so the pair
// proves the payload is sufficient AND correctly structured for a thesis-following
// judge to reach the right call. No real LLM tokens spent.
let lastPayload = null;
const thesisOracle = {
  chat: { completions: { create: async (payload) => {
    const um = payload.messages?.find?.((m) => m.role === "user")?.content || "{}";
    try { lastPayload = JSON.parse(um); } catch { lastPayload = null; }
    const c = lastPayload?.candidate || {};
    const mom = c?.metrics?.price_change_pct;
    const feeTvl = c?.metrics?.fee_active_tvl_ratio;
    const tier = c?.flow?.tier;
    // Market-maker thesis (mirrors the SYSTEM_PROMPT): SKIP on negative momentum OR
    // sell-dominated flow OR thin fee density; ENTER only when fee density is healthy
    // AND flow is not sell-leaning AND momentum is not negative.
    const skip = (Number.isFinite(mom) && mom < 0) || tier === "sell_leaning" || !(feeTvl >= 0.10);
    const decision = skip ? "skip" : "enter";
    return {
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
        function: { name: "judge_candidate", arguments: JSON.stringify({
          pool_address: c?.pool_address || "X",
          decision,
          confidence: skip ? 20 : 74,
          reason: skip ? "negative momentum / sell flow / thin fees" : "high fee density, balanced flow, flat-to-up",
          recommended_bins_below: 45,
        }) },
      }] } }],
      usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
    };
  } } },
};
__setClientForTests(thesisOracle);

// FIXTURE 1 — DUMPING TOKEN (SKIP-weighted): -2.5% momentum sits in the -4..0 gray
// zone the direction gate does NOT catch, plus sell-dominated flow (buy 3k / sell 9k
// = 25% buy). Exactly the loser pattern a market-maker judge must reject.
const [dumpVerdict] = await judgeCandidates([{
  pool: { pool: "PoolDUMP", name: "DUMP-SOL", bin_step: 100, fee_active_tvl_ratio: 0.15,
    volume_window: 20000, tvl: 40000, volatility: 3, organic_score: 80, mcap: 700000,
    token_age_hours: 20, price_change_pct: -2.5, buy_vol: 3000, sell_vol: 9000 },
  sw: { in_pool: [] }, n: { narrative: "x" }, ti: { audit: {} }, mem: null,
}], { portfolio: { sol: 2 }, positions: { total_positions: 0 } });
check("DUMPING: payload carries negative momentum (-2.5)", lastPayload?.candidate?.metrics?.price_change_pct === -2.5);
check("DUMPING: payload carries sell_leaning flow", lastPayload?.candidate?.flow?.tier === "sell_leaning");
check("DUMPING fixture is SKIP-weighted → skip", dumpVerdict?.decision === "skip");

// FIXTURE 2 — HIGH FEE DENSITY + BALANCED FLOW (ENTER-weighted): fee/TVL 0.20 (the
// "king" line), balanced flow (buy 5k / sell 5k = 50%), flat-to-up momentum (+1.5%).
// Fee density + non-negative momentum + balanced flow all aligned = the ENTER case.
const [enterVerdict] = await judgeCandidates([{
  pool: { pool: "PoolFEE", name: "FEE-SOL", bin_step: 100, fee_active_tvl_ratio: 0.20,
    volume_window: 30000, tvl: 35000, volatility: 3.5, organic_score: 82, mcap: 900000,
    token_age_hours: 30, price_change_pct: 1.5, buy_vol: 5000, sell_vol: 5000 },
  sw: { in_pool: [] }, n: { narrative: "x" }, ti: { audit: {} }, mem: null,
}], { portfolio: { sol: 2 }, positions: { total_positions: 0 } });
check("ENTER: payload carries high fee density (>= 0.10)", lastPayload?.candidate?.metrics?.fee_active_tvl_ratio >= 0.10);
check("ENTER: payload carries balanced flow", lastPayload?.candidate?.flow?.tier === "balanced");
check("ENTER: payload carries non-negative momentum", lastPayload?.candidate?.metrics?.price_change_pct >= 0);
check("ENTER fixture is ENTER-weighted → enter", enterVerdict?.decision === "enter");

// The two fixtures reach OPPOSITE decisions under the same thesis → alignment holds.
check("SKIP-weighted and ENTER-weighted fixtures diverge", dumpVerdict?.decision !== enterVerdict?.decision);
__setClientForTests(fakeClient); // restore

// ── Prompt language: the market-maker alignment is actually in the prompt ─────
const fsMod = await import("node:fs");
const orionSrc2 = fsMod.readFileSync(new URL("../agents/orion.js", import.meta.url), "utf8");
check("prompt: SHORT-GAMMA instrument framing present", /SHORT-GAMMA/.test(orionSrc2));
check("prompt: 'might pump' is NOT an enter reason", /Might pump 50%' is NOT a reason to enter/i.test(orionSrc2));
check("prompt: negative momentum = strong skip", /NEGATIVE MOMENTUM = STRONG SKIP/.test(orionSrc2));
check("prompt: names the -4..0 gray zone the gate misses", /-4\.\.0 gray zone/.test(orionSrc2));
check("prompt: prizes fee density", /PRIZE FEE DENSITY/.test(orionSrc2));
check("prompt: flow tier factor present", /FLOW: flow\.tier/.test(orionSrc2));
// Confidence rubric anchored to the 0.1-SOL data-probe floor (55 is NOT junk).
check("rubric: 55-69 = 0.1-SOL data probe", /55-69 = worth a small 0\.1-SOL/.test(orionSrc2));
check("rubric: 55 explicitly NOT junk", /55 is NOT junk/.test(orionSrc2));
check("rubric: >=70 = solid", />=70 = SOLID setup/.test(orionSrc2));
// Cost invariant: still exactly one LLM call per judge (no new call site added).
check("still a single chat.completions.create per judge",
  (orionSrc2.match(/chat\.completions\.create/g) || []).length === 1);

console.log(`\n${passed} assertions passed.`);

if (process.exitCode) {
  console.error("\nTEST FAILED");
  process.exit(1);
}
