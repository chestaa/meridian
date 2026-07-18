// Test for prompt.js buildSystemPrompt("SCREENER", ...) — per-lane prompt-bleed guard.
// Run: node scripts/test-screener-prompt-lane.js
// Does NOT spend LLM tokens — builds the SCREENER system prompt string directly with
// config.screening.bluechipModeEnabled toggled, and asserts the max-TVL / mcap-band
// EXEMPTION appears ONLY in the bluechip lane.
//
// Root cause fixed (S2 two-sided bluechip paper soak, 2026-07-18): the fat SCREENER
// prompt carried NO explicit "bluechip has no max-TVL cap" statement, so the judge
// applied the memecoin $150K max-TVL ceiling (and the 150k-10M mcap band) to the
// $2.8M JitoSOL-SOL / $2.5M SOL-USDC pools → 53/100 cycles refused on maxTvl. The gate
// (screening.js) already DROPS maxTvl + treats mcap as a FLOOR for the bluechip lane;
// this proves the prompt now MIRRORS the code per lane.

import assert from "node:assert/strict";

process.env.DRY_RUN = "true";

const { config } = await import("../config.js");
const { buildSystemPrompt } = await import("../prompt.js");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const buildScreener = () => buildSystemPrompt("SCREENER", { sol: 2.5 }, { total_positions: 0 });

// Preserve original flag so the test never mutates shared config permanently.
const originalFlag = config.screening.bluechipModeEnabled;

try {
  // ── Lane A: MEMECOIN (bluechip mode OFF) — byte-for-byte legacy behaviour ──────
  config.screening.bluechipModeEnabled = false;
  const memePrompt = buildScreener();
  check("OFF: NO bluechip income-engine block", !/BLUECHIP INCOME-ENGINE MODE — ACTIVE/.test(memePrompt));
  check("OFF: memecoin bin-step rule present ([80-125])", /Bin steps must be \[80-125\]\./.test(memePrompt));
  check("OFF: NO max-TVL-cap exemption leaks into memecoin lane", !/NO maximum-TVL cap for a bluechip/.test(memePrompt));
  check("OFF: NO $150K-does-not-apply text in memecoin lane", !/\$150K/.test(memePrompt));
  check("OFF: NO mcap-band exemption in memecoin lane", !/mcap band \(150k-10M\) does NOT apply/.test(memePrompt));

  // ── Lane B: BLUECHIP (bluechip mode ON) — the exemption MUST appear ───────────
  config.screening.bluechipModeEnabled = true;
  config.screening.bluechipMaxBinStep = config.screening.bluechipMaxBinStep ?? 200;
  config.screening.bluechipMinFeeTvlRatio = config.screening.bluechipMinFeeTvlRatio ?? 0.03;
  config.screening.bluechipMaxVolatility = config.screening.bluechipMaxVolatility ?? 1.5;
  config.screening.bluechipMinTvl = config.screening.bluechipMinTvl ?? 200_000;
  const bcPrompt = buildScreener();
  check("ON: bluechip income-engine block present", /BLUECHIP INCOME-ENGINE MODE — ACTIVE/.test(bcPrompt));
  check("ON: prompt states NO maximum-TVL cap for bluechip", /NO maximum-TVL cap for a bluechip/.test(bcPrompt));
  check("ON: prompt says the $150K memecoin max-TVL ceiling does NOT apply", /\$150K\) does\s+NOT\s+apply/.test(bcPrompt.replace(/\n/g, " ")));
  check("ON: prompt exempts bluechip from the memecoin mcap band (150k-10M)", /mcap band \(150k-10M\) does NOT apply/.test(bcPrompt.replace(/\n/g, " ")));
  check("ON: 'DO NOT apply' list now includes HIGH TVL / above the max-TVL cap", /above the max-TVL cap/.test(bcPrompt));
  check("ON: 'DO NOT apply' list now includes outside the mcap band", /outside the mcap band/.test(bcPrompt));
  check("ON: memecoin bin-step still enforced for non-bluechip pools", /MEMECOIN pool \(anything else\) → bin_step must be \[80-125\]/.test(bcPrompt));
} finally {
  // Restore — never leave the shared config object mutated for later tests.
  config.screening.bluechipModeEnabled = originalFlag;
}

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
