// Backtest Cost Estimator — Lyra
//
// Pre-flight cost preview. NEVER makes LLM calls. Loads the same input
// source as backtest-harness.js, counts candidates, applies an
// average-token-per-candidate heuristic, and prints estimated USD spend
// at the current Orion model tier.
//
// CLI:
//   node scripts/backtest-cost-estimator.js --source signal-results --limit 50
//   node scripts/backtest-cost-estimator.js --source jsonl-file --path ./x.jsonl --limit 200

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// Per-candidate token heuristic — derived from observed Orion calls
// (see llm-usage.json baseline: ~705 prompt + 172 completion = 877 tokens
// for a real Orion judge of a typical signal). Synthetic tests show 100/30.
// We use the realistic figure since this is an upper-bound estimator.
const AVG_PROMPT_TOKENS = 750;
const AVG_COMPLETION_TOKENS = 180;

// Model pricing (USD per million tokens). Update if model routing changes.
const PRICING = {
  "moonshotai/kimi-k2":         { in: 0.60, out: 2.50 },
  "deepseek/deepseek-v4-flash": { in: 0.07, out: 0.27 },
  "openrouter/healer-alpha":    { in: 0.00, out: 0.00 }, // free tier
};

function parseArgs(argv) {
  const args = { source: "signal-results", limit: 50, path: null, model: "moonshotai/kimi-k2" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source": args.source = argv[++i]; break;
      case "--path":   args.path = argv[++i]; break;
      case "--limit":  args.limit = Number(argv[++i] || 50); break;
      case "--model":  args.model = argv[++i]; break;
    }
  }
  return args;
}

function countSource(args) {
  switch (args.source) {
    case "signal-results": {
      if (!fs.existsSync("./signal-results.jsonl")) return 0;
      const lines = fs.readFileSync("./signal-results.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
      return Math.min(lines.length, args.limit);
    }
    case "inbox":
    case "history": {
      const dir = `./signals/${args.source}`;
      if (!fs.existsSync(dir)) return 0;
      return Math.min(fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).length, args.limit);
    }
    case "jsonl-file": {
      if (!args.path || !fs.existsSync(args.path)) return 0;
      const lines = fs.readFileSync(args.path, "utf8").split(/\r?\n/).filter(Boolean);
      return Math.min(lines.length, args.limit);
    }
    default: return 0;
  }
}

function estimate(args) {
  const n = countSource(args);
  const price = PRICING[args.model] || PRICING["moonshotai/kimi-k2"];
  const inUsd  = (n * AVG_PROMPT_TOKENS     * price.in)  / 1_000_000;
  const outUsd = (n * AVG_COMPLETION_TOKENS * price.out) / 1_000_000;
  const total = inUsd + outUsd;
  return { candidates: n, inputTokens: n * AVG_PROMPT_TOKENS, outputTokens: n * AVG_COMPLETION_TOKENS, costUsd: total, model: args.model };
}

const invokedDirectly = process.argv[1].endsWith("backtest-cost-estimator.js");
if (invokedDirectly) {
  const args = parseArgs(process.argv);
  const r = estimate(args);
  console.log(`Cost estimate — source=${args.source} limit=${args.limit} model=${r.model}`);
  console.log(`  Candidates:      ${r.candidates}`);
  console.log(`  Input tokens:    ${r.inputTokens.toLocaleString()}`);
  console.log(`  Output tokens:   ${r.outputTokens.toLocaleString()}`);
  console.log(`  Estimated cost:  $${r.costUsd.toFixed(6)}`);
  if (r.costUsd > 1.0) console.log(`  WARNING: estimate > $1 — confirm before running harness.`);
}

export { estimate };
