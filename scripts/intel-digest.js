/**
 * intel-digest.js — auto-learn intel pipeline (Build #5).
 *
 * Orion 🏹 — LLM Judge. DeepSeek V4 Flash (cheap) self-improvement digest.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  ⚠️  ADVISORY ONLY — THIS PIPELINE NEVER TOUCHES MONEY OR CONFIG.  ⚠️
 * ─────────────────────────────────────────────────────────────────────────
 * The bot reads crawled community intel (X / Telegram / Discord JSONs already
 * produced by Sirius's intel-*.js crawlers), sends a BOUNDED slice to DeepSeek
 * V4 Flash, and asks for actionable suggestions. The output is SUGGESTIONS for
 * a HUMAN to review. Hard guarantees, by construction:
 *
 *   • READS  only:  intel/x, intel/telegram, intel/discord  (crawl JSONs)
 *   • WRITES only:  intel/digests/digest-YYYY-MM-DD.json (+ .md summary)
 *   • DOES NOT import or call: config.js mutation, user-config.json, state.js,
 *     tools/executor.js, dlmm.js, wallet.js, or anything money/position-touching.
 *   • Suggestions CANNOT auto-apply. There is no code path from this file to a
 *     deploy, a swap, a config write, or a threshold change. Human-in-the-loop
 *     is the only way a suggestion ever becomes a change.
 *
 * Anti-pattern #8 discipline: any token/pool mentioned in intel is qualitative
 * landscape ONLY — never surfaced as a trade trigger.
 *
 * Cost control: DeepSeek V4 Flash via OpenRouter, input capped (~8k tokens),
 * single bounded output (~900 tokens), designed for 1 run/day (systemd timer).
 * Every call is logged to llm-usage.json and gated by cost-guard's daily cap.
 *
 * Run:
 *   node scripts/intel-digest.js              # real run (needs OPENROUTER_API_KEY)
 *   node scripts/intel-digest.js --dry-llm    # build prompt + write stub, NO LLM call
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import "dotenv/config";

import { recordLlmUsage, computeCost } from "../llm-usage.js";
import { assertWithinBudget, BudgetExceededError, getBudgetStatus } from "../cost-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INTEL_DIR = path.join(ROOT, "intel");
const DIGEST_DIR = path.join(INTEL_DIR, "digests");

// Cheap by mandate (Bro): DeepSeek V4 Flash. Override only via env for benchmarking.
const MODEL = process.env.INTEL_DIGEST_MODEL || "deepseek/deepseek-v4-flash";
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";

// Input cost cap. ~4 chars/token heuristic → 8k tokens ≈ 32k chars of intel text.
const MAX_INPUT_TOKENS = parseInt(process.env.INTEL_DIGEST_MAX_INPUT_TOKENS || "8000", 10);
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * 4;
const MAX_OUTPUT_TOKENS = parseInt(process.env.INTEL_DIGEST_MAX_OUTPUT_TOKENS || "900", 10);
const MAX_RECORDS_PER_PLATFORM = parseInt(process.env.INTEL_DIGEST_MAX_RECORDS || "60", 10);
const TIMEOUT_MS = 60_000;

const PLATFORMS = ["x", "telegram", "discord"];

// ── Read-only seam for tests: inject a fake OpenAI-shaped client. ────────────
let _injectedClient = null;
export function __setClientForTests(fakeClient) { _injectedClient = fakeClient; }
function getClient() {
  if (_injectedClient) return _injectedClient;
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY / LLM_API_KEY not set — cannot run digest");
  return new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL, timeout: TIMEOUT_MS });
}

/**
 * Find the newest crawl JSON per platform. Skips research-*.json (those are
 * hand-curated reports, not raw crawls) — we want fresh machine crawls.
 * @param {string} intelDir  override for tests
 */
export function findLatestCrawls(intelDir = INTEL_DIR) {
  const out = {};
  for (const platform of PLATFORMS) {
    const dir = path.join(intelDir, platform);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("research"))
      .map((f) => {
        const full = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        return { platform, file: full, name: f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) out[platform] = files[0];
  }
  return out;
}

/**
 * Load + compact records from a crawl file into terse intel lines.
 * Reads the `records` array shape produced by intel-extract.buildIntelRecord.
 * Returns { lines: string[], counts: {topic: n}, total: n }.
 */
export function compactCrawl(crawlPath, maxRecords = MAX_RECORDS_PER_PLATFORM) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(crawlPath, "utf8")); }
  catch { return { lines: [], counts: {}, total: 0 }; }

  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  // Prefer records that actually carry intel topics (signal over noise).
  const withTopics = records.filter((r) => Array.isArray(r?.topics) && r.topics.length);
  const pool = (withTopics.length ? withTopics : records).slice(0, maxRecords);

  const counts = {};
  const lines = [];
  for (const r of pool) {
    for (const t of (r.topics || [])) counts[t] = (counts[t] || 0) + 1;
    const author = (r.author || "?").slice(0, 24);
    const topics = (r.topics || []).join(",");
    // Strip URLs/addresses already captured as metadata; keep the human text.
    const text = String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (!text) continue;
    lines.push(`[${topics || "untagged"}] @${author}: ${text}`);
  }
  return { lines, counts, total: records.length };
}

/**
 * Build the bounded intel corpus string fed to the model. Interleaves platforms
 * round-robin so a single chatty platform can't crowd out the others, then hard
 * caps to MAX_INPUT_CHARS. Returns { corpus, used, sources }.
 */
export function buildCorpus(crawls) {
  const perPlatform = {};
  const sources = [];
  for (const platform of PLATFORMS) {
    const c = crawls[platform];
    if (!c) continue;
    const { lines, counts, total } = compactCrawl(c.file);
    perPlatform[platform] = lines;
    sources.push({ platform, file: path.relative(ROOT, c.file), records: total, topic_counts: counts });
  }

  // Round-robin interleave, then char-cap.
  const interleaved = [];
  let i = 0;
  let added = true;
  while (added) {
    added = false;
    for (const platform of PLATFORMS) {
      const arr = perPlatform[platform];
      if (arr && i < arr.length) {
        interleaved.push(`(${platform}) ${arr[i]}`);
        added = true;
      }
    }
    i++;
  }

  let corpus = "";
  let used = 0;
  for (const line of interleaved) {
    if (corpus.length + line.length + 1 > MAX_INPUT_CHARS) break;
    corpus += line + "\n";
    used++;
  }
  return { corpus: corpus.trim(), used, sources };
}

const SYSTEM_PROMPT = [
  "You are Orion, the LLM Judge for Meridian — an autonomous Solana DLMM",
  "liquidity-farming agent. You are reading CRAWLED COMMUNITY INTEL (builder",
  "chatter, complaints, strategy talk, tech-stack mentions) from X, Telegram,",
  "and Discord. Your job is to extract ADVISORY suggestions for the human",
  "operator to review. You do NOT make changes; you only suggest.",
  "",
  "Output ONLY valid JSON matching this schema:",
  "{",
  '  "suggestions": [',
  "    {",
  '      "category": "tech_tooling" | "strategy" | "preempt_bug" | "competitor_move",',
  '      "title": "<short>",',
  '      "detail": "<2-3 sentences, specific and actionable>",',
  '      "evidence": "<paraphrase / quote from the intel that supports this>",',
  '      "confidence": 0.0-1.0,',
  '      "advisory_action": "<what a human MIGHT do — never auto-applied>"',
  "    }",
  "  ],",
  '  "summary": "<3-4 sentence overview of the intel landscape>"',
  "}",
  "",
  "Rules:",
  "- Extract: (1) new tech/tooling worth adopting, (2) strategy improvements",
  "  validated by the community, (3) bugs/pain others hit that we should preempt,",
  "  (4) competitor moves.",
  "- Any token/pool ticker is QUALITATIVE landscape only — NEVER a trade trigger.",
  "- Be skeptical: self-reported PnL is not verified. Lower confidence accordingly.",
  "- Prefer fewer, high-signal suggestions over many weak ones (max ~6).",
  "- Every suggestion is advisory. A human decides. You never apply anything.",
].join("\n");

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function renderMarkdown(digest) {
  const lines = [];
  lines.push(`# Intel Digest — ${digest.date}`);
  lines.push("");
  lines.push(`> ADVISORY ONLY. Suggestions for human review. No auto-apply, no money/config change.`);
  lines.push("");
  lines.push(`Model: \`${digest.model}\` · cost: $${digest.cost_usd.toFixed(6)} · `
    + `corpus: ${digest.corpus_lines_used} lines · sources: ${digest.sources.length}`);
  lines.push("");
  if (digest.summary) {
    lines.push("## Landscape");
    lines.push(digest.summary);
    lines.push("");
  }
  lines.push("## Suggestions");
  if (!digest.suggestions.length) {
    lines.push("_(none extracted)_");
  } else {
    digest.suggestions.forEach((s, i) => {
      lines.push(`### ${i + 1}. [${s.category}] ${s.title}  (conf ${Math.round((s.confidence ?? 0) * 100)}%)`);
      lines.push(s.detail || "");
      if (s.evidence) lines.push(`- Evidence: ${s.evidence}`);
      if (s.advisory_action) lines.push(`- Advisory action (human decides): ${s.advisory_action}`);
      lines.push("");
    });
  }
  lines.push("---");
  lines.push("— Orion 🏹 (advisory)");
  return lines.join("\n");
}

function topSuggestionsForTelegram(digest, n = 3) {
  const ranked = [...digest.suggestions]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, n);
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = [`🏹 <b>Intel Digest — ${digest.date}</b> <i>(ADVISORY)</i>`];
  if (!ranked.length) {
    out.push("No actionable suggestions today.");
  } else {
    ranked.forEach((s, i) => {
      out.push(`\n<b>${i + 1}. [${esc(s.category)}] ${esc(s.title)}</b> (${Math.round((s.confidence ?? 0) * 100)}%)`);
      out.push(esc(s.detail));
    });
  }
  out.push(`\n<i>Suggestions only — human reviews, nothing auto-applies.</i>`);
  return out.join("\n");
}

/**
 * Core pipeline. Pure-ish: returns the digest object; writing + notifying are
 * the caller's concern (so tests can run the LLM step without side effects).
 * @param {object} opts
 * @param {string} opts.intelDir   override intel dir (tests)
 * @param {boolean} opts.dryLlm    skip the LLM call, return a stub digest
 */
export async function runDigest({ intelDir = INTEL_DIR, dryLlm = false } = {}) {
  const crawls = findLatestCrawls(intelDir);
  const { corpus, used, sources } = buildCorpus(crawls);

  const base = {
    date: todayStamp(),
    generated_at: new Date().toISOString(),
    model: MODEL,
    advisory_only: true,
    note: "Suggestions for human review. This pipeline never edits config, state, or money paths.",
    sources,
    corpus_lines_used: used,
    suggestions: [],
    summary: "",
    cost_usd: 0,
    usage: null,
  };

  if (!corpus) {
    base.summary = "No intel crawl data found to analyze.";
    return base;
  }

  if (dryLlm) {
    base.summary = "[--dry-llm] LLM call skipped; prompt built and corpus bounded successfully.";
    base.dry_llm = true;
    base.prompt_chars = SYSTEM_PROMPT.length + corpus.length;
    return base;
  }

  // Budget gate BEFORE any spend (Lyra coordination point).
  assertWithinBudget();

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `# Crawled intel (bounded)\n${corpus}` },
  ];

  const response = await getClient().chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
  });

  const usage = response.usage || {};
  recordLlmUsage({
    agentType: "ORION_INTEL_DIGEST",
    model: MODEL,
    step: 1,
    finishReason: response.choices?.[0]?.finish_reason || null,
    toolCalls: 0,
    usage,
  });
  base.usage = usage;
  base.cost_usd = computeCost(MODEL, usage);

  const content = response.choices?.[0]?.message?.content || "";
  let parsed = {};
  try { parsed = JSON.parse(content); }
  catch {
    // One lenient salvage attempt: pull the first {...} block.
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
  }

  base.suggestions = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions.slice(0, 8).map((s) => ({
        category: String(s?.category || "strategy"),
        title: String(s?.title || "").slice(0, 120),
        detail: String(s?.detail || "").slice(0, 600),
        evidence: String(s?.evidence || "").slice(0, 400),
        confidence: Math.max(0, Math.min(1, Number(s?.confidence ?? 0))),
        advisory_action: String(s?.advisory_action || "").slice(0, 300),
      }))
    : [];
  base.summary = String(parsed?.summary || "").slice(0, 1000);
  if (!base.suggestions.length && !base.summary) {
    base.summary = "Model returned no parseable suggestions.";
    base.raw_preview = content.slice(0, 500);
  }
  return base;
}

/** Persist digest JSON + human-readable .md. Writes ONLY under intel/digests/. */
export function writeDigest(digest, digestDir = DIGEST_DIR) {
  fs.mkdirSync(digestDir, { recursive: true });
  const jsonPath = path.join(digestDir, `digest-${digest.date}.json`);
  const mdPath = path.join(digestDir, `digest-${digest.date}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(digest, null, 2), "utf8");
  fs.writeFileSync(mdPath, renderMarkdown(digest), "utf8");
  return { jsonPath, mdPath };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dryLlm = process.argv.includes("--dry-llm");
  (async () => {
    try {
      const digest = await runDigest({ dryLlm });
      const { jsonPath, mdPath } = writeDigest(digest);

      console.log(`\n=== INTEL DIGEST ${digest.date} (ADVISORY ONLY) ===`);
      console.log(`  model: ${digest.model}`);
      console.log(`  sources: ${digest.sources.map((s) => `${s.platform}(${s.records})`).join(", ") || "none"}`);
      console.log(`  corpus lines: ${digest.corpus_lines_used}`);
      console.log(`  suggestions: ${digest.suggestions.length}`);
      console.log(`  cost: $${digest.cost_usd.toFixed(6)}`);
      console.log(`  → ${jsonPath}`);
      console.log(`  → ${mdPath}`);

      // Telegram notify (top 3) — best-effort, never fatal. Imported lazily so
      // a missing/unconfigured telegram module can't break the digest run.
      if (!dryLlm && digest.suggestions.length) {
        try {
          const { sendHTML } = await import("../telegram.js");
          await sendHTML(topSuggestionsForTelegram(digest, 3));
          console.log("  telegram: top-3 suggestions sent");
        } catch (e) {
          console.warn(`  telegram: skipped (${e.message})`);
        }
      }
      process.exit(0);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        console.error(`[intel-digest] budget cap reached: ${e.message}`);
        try {
          const { notifyBudgetExceeded } = await import("../telegram.js");
          await notifyBudgetExceeded({ status: getBudgetStatus(), caller: "scripts/intel-digest.js" });
        } catch { /* ignore */ }
        process.exit(2);
      }
      console.error(`[intel-digest fatal] ${e.message}`);
      process.exit(1);
    }
  })();
}

export { SYSTEM_PROMPT, renderMarkdown, topSuggestionsForTelegram, MODEL, MAX_INPUT_CHARS };
