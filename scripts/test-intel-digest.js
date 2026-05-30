// Test for scripts/intel-digest.js — auto-learn intel digest pipeline (Build #5).
// Run: node scripts/test-intel-digest.js
//
// Verifies:
//   - latest crawl discovery + corpus building (bounded, multi-platform)
//   - prompt structure (advisory framing, 4 extraction categories)
//   - DeepSeek call mocked (no real tokens spent), structured output parsed
//   - Telegram render is advisory-framed
//   - GUARDRAIL: pipeline is READ-ONLY — it writes ONLY under intel/digests/
//     and mutates NO config/state/user-config/executor file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

// ── 1. Build a temp intel/ tree with mock crawl files. ───────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intel-digest-test-"));
const intelDir = path.join(tmp, "intel");
function writeCrawl(platform, name, records) {
  const dir = path.join(intelDir, platform);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ crawled_at: new Date().toISOString(), records }, null, 2));
  return file;
}

writeCrawl("x", "old_2026-05-29.json", [
  { author: "stale", text: "should be ignored — older mtime", topics: ["llm"] },
]);
// Newer file (written second → higher mtime) should win.
const newestX = writeCrawl("x", "new_2026-05-30.json", [
  { author: "0xyunss", text: "switched to Xiaomi MiMo v2.5 for agentic coding, way cheaper than claude", topics: ["llm", "technical"] },
  { author: "builder", text: "setup awal ribet banget, onboarding friction is real", topics: ["complaint"] },
]);
writeCrawl("telegram", "tg_2026-05-30.json", [
  { author: "meteoraIDN", text: "Total Fees/MC >= 0.1 filter + TVL/MC < 0.2 gate is what works for spot LP", topics: ["strategy", "dlmm"] },
]);
writeCrawl("discord", "dc_2026-05-30.json", [
  { author: "dev", text: "hit a rate limit bug on RPC during deploy bursts, watch for that", topics: ["issue", "technical"] },
]);
// Snapshot the intel tree so we can prove the pipeline never mutates inputs.
function snapshotTree(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshotTree(full));
    else out[full] = fs.readFileSync(full, "utf8");
  }
  return out;
}
const intelSnapshotBefore = snapshotTree(intelDir);

// ── 2. Snapshot guarded project files (must NOT change). ─────────────────────
const guardedFiles = [
  "user-config.json", "state.json", "config.js",
  path.join("tools", "executor.js"), "strategy-library.json",
].map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p));
const guardedBefore = Object.fromEntries(guardedFiles.map((p) => [p, fs.statSync(p).mtimeMs + ":" + fs.statSync(p).size]));

// ── 3. Mock DeepSeek client (no real tokens). Capture the payload. ───────────
let capturedPayload = null;
const fakeClient = {
  chat: {
    completions: {
      create: async (payload) => {
        capturedPayload = payload;
        return {
          id: "chatcmpl-test",
          model: payload.model,
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Indonesian DLMM builder cluster; cheap-LLM migration + onboarding friction themes.",
                suggestions: [
                  { category: "tech_tooling", title: "Evaluate Xiaomi MiMo v2.5", detail: "Community migrating off pricier models for agentic coding.", evidence: "switched to Xiaomi MiMo v2.5 ... way cheaper", confidence: 0.6, advisory_action: "Benchmark MiMo vs DeepSeek V4 for dev loop" },
                  { category: "strategy", title: "Tighten Fees/MC gate", detail: "Fees/MC>=0.1 + TVL/MC<0.2 reported as the working spot-LP filter.", evidence: "Total Fees/MC >= 0.1 ... TVL/MC < 0.2", confidence: 0.7, advisory_action: "Human review of minFeeActiveTvlRatio" },
                  { category: "preempt_bug", title: "RPC rate-limit on deploy bursts", detail: "Others hit rate limits during burst deploys.", evidence: "rate limit bug on RPC during deploy bursts", confidence: 0.5, advisory_action: "Add backoff" },
                ],
              }),
            },
          }],
          usage: { prompt_tokens: 1800, completion_tokens: 220, total_tokens: 2020 },
        };
      },
    },
  },
};

const digestMod = await import("./intel-digest.js");
const {
  findLatestCrawls, compactCrawl, buildCorpus, runDigest, writeDigest,
  SYSTEM_PROMPT, topSuggestionsForTelegram, __setClientForTests, MAX_INPUT_CHARS,
} = digestMod;

__setClientForTests(fakeClient);

// ── 4. Crawl discovery picks newest per platform, skips research-*. ──────────
const crawls = findLatestCrawls(intelDir);
check("found x crawl", !!crawls.x);
check("picked NEWEST x crawl (not stale)", crawls.x && crawls.x.file === newestX);
check("found telegram crawl", !!crawls.telegram);
check("found discord crawl", !!crawls.discord);

// ── 5. compactCrawl prefers topic-tagged records, bounds text. ───────────────
const compacted = compactCrawl(newestX);
check("compactCrawl returns lines", Array.isArray(compacted.lines) && compacted.lines.length === 2);
check("compactCrawl counts topics", compacted.counts.llm === 1);

// ── 6. buildCorpus interleaves platforms + stays under char cap. ─────────────
const { corpus, used, sources } = buildCorpus(crawls);
check("corpus non-empty", corpus.length > 0);
check("corpus under input char cap", corpus.length <= MAX_INPUT_CHARS);
check("corpus interleaves all 3 platforms", /\(x\)/.test(corpus) && /\(telegram\)/.test(corpus) && /\(discord\)/.test(corpus));
check("sources lists 3 platforms", sources.length === 3);
check("corpus omits the stale older file content", !/should be ignored/.test(corpus));

// ── 7. Prompt structure: advisory framing + 4 categories. ────────────────────
check("prompt declares advisory-only", /advisory/i.test(SYSTEM_PROMPT) && /only suggest/i.test(SYSTEM_PROMPT));
check("prompt has tech_tooling category", /tech_tooling/.test(SYSTEM_PROMPT));
check("prompt has strategy category", /"strategy"/.test(SYSTEM_PROMPT));
check("prompt has preempt_bug category", /preempt_bug/.test(SYSTEM_PROMPT));
check("prompt has competitor_move category", /competitor_move/.test(SYSTEM_PROMPT));
check("prompt forbids trade triggers (anti-pattern #8)", /never a trade trigger/i.test(SYSTEM_PROMPT));

// ── 8. runDigest with mocked LLM → structured output. ────────────────────────
const digest = await runDigest({ intelDir });
check("LLM was called exactly once", capturedPayload !== null);
check("model is DeepSeek V4 Flash", capturedPayload.model === "deepseek/deepseek-v4-flash");
check("output capped (max_tokens set)", typeof capturedPayload.max_tokens === "number" && capturedPayload.max_tokens <= 1200);
check("requests json_object format", capturedPayload.response_format?.type === "json_object");
check("digest advisory_only flag true", digest.advisory_only === true);
check("digest has 3 suggestions", digest.suggestions.length === 3);
check("suggestion has category+confidence", digest.suggestions[0].category === "tech_tooling" && digest.suggestions[0].confidence === 0.6);
check("digest summary populated", digest.summary.length > 0);
check("digest cost computed (>0)", digest.cost_usd > 0);
check("digest cost is cheap (< $0.01)", digest.cost_usd < 0.01);
check("digest date is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(digest.date));

// ── 9. Telegram render is advisory + escapes HTML. ───────────────────────────
const tg = topSuggestionsForTelegram(digest, 3);
check("telegram render advisory-framed", /ADVISORY/i.test(tg) && /nothing auto-applies/i.test(tg));
check("telegram render includes top suggestion", /Tighten Fees\/MC gate|Evaluate Xiaomi MiMo/.test(tg));

// ── 10. writeDigest writes ONLY under intel/digests/ (temp). ─────────────────
const digestDir = path.join(intelDir, "digests");
const { jsonPath, mdPath } = writeDigest(digest, digestDir);
check("wrote digest JSON under intel/digests", fs.existsSync(jsonPath) && jsonPath.startsWith(digestDir));
check("wrote digest MD under intel/digests", fs.existsSync(mdPath) && mdPath.startsWith(digestDir));
const writtenJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
check("written JSON marks advisory_only", writtenJson.advisory_only === true);
check("written MD has advisory banner", /ADVISORY ONLY/.test(fs.readFileSync(mdPath, "utf8")));

// ── 11. GUARDRAIL: dry-llm path makes NO LLM call. ───────────────────────────
capturedPayload = null;
const dry = await runDigest({ intelDir, dryLlm: true });
check("dry-llm makes NO LLM call", capturedPayload === null);
check("dry-llm still bounds prompt", dry.dry_llm === true && dry.prompt_chars > 0);
check("dry-llm cost is 0", dry.cost_usd === 0);

// ── 12. GUARDRAIL: source intel files NOT mutated. ───────────────────────────
const intelSnapshotAfter = snapshotTree(intelDir);
let inputsUntouched = true;
for (const [f, content] of Object.entries(intelSnapshotBefore)) {
  if (intelSnapshotAfter[f] !== content) inputsUntouched = false;
}
check("source crawl files unchanged (read-only inputs)", inputsUntouched);

// ── 13. GUARDRAIL: NO config/state/executor mutation. ────────────────────────
let guardedUntouched = true;
for (const [p, sig] of Object.entries(guardedBefore)) {
  const now = fs.statSync(p).mtimeMs + ":" + fs.statSync(p).size;
  if (now !== sig) { guardedUntouched = false; console.log(`  FAIL  guarded file mutated: ${p}`); }
}
check("config/state/executor/user-config NOT mutated", guardedUntouched);

// ── 14. GUARDRAIL: source does not import money/config-mutation modules. ──────
const src = fs.readFileSync(path.join(ROOT, "scripts", "intel-digest.js"), "utf8");
const importLines = src.split("\n").filter((l) => /^\s*import\s/.test(l) || /import\(/.test(l));
const forbidden = ["executor", "dlmm.js", "wallet.js", "update_config", "state.js", "user-config.json", "deploy_position"];
let cleanImports = true;
for (const f of forbidden) {
  if (importLines.some((l) => l.includes(f))) { cleanImports = false; console.log(`  FAIL  forbidden import of ${f}`); }
}
check("no import of money/config-mutation modules", cleanImports);
check("source declares ADVISORY ONLY in header", /ADVISORY ONLY/.test(src));

// ── Cleanup. ─────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
