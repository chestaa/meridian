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
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import "dotenv/config";

import { recordLlmUsage, computeCost } from "../llm-usage.js";
import { assertWithinBudget, BudgetExceededError, getBudgetStatus } from "../cost-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INTEL_DIR = path.join(ROOT, "intel");
const DIGEST_DIR = path.join(INTEL_DIR, "digests");

// Staleness guard: a crawl older than this is treated as STALE (dropped from the
// corpus) rather than silently re-fed day after day. This is the core fix for the
// "corpus identical across days, digest empty" bug — without it the digest would
// happily re-ingest a frozen 05-30 file forever if no fresh crawl ever landed.
const STALE_MAX_AGE_DAYS = parseFloat(process.env.INTEL_DIGEST_STALE_DAYS || "2");
const STALE_MAX_AGE_MS = STALE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

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
 * Pick the freshest crawl timestamp for a file. Prefers the ISO stamp embedded in
 * the filename / the crawl's `crawled_at` field over mtime, because mtime can be
 * bumped by a git checkout / scp / rsync without the data actually being newer.
 * Falls back to mtime, then 0.
 */
function crawlTimeMs(full, name) {
  // Filename stamp: <prefix>_2026-06-02T10-04-00-649Z.json → ISO.
  const m = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (m) {
    const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    const t = Date.parse(parsed?.crawled_at || "");
    if (Number.isFinite(t)) return t;
  } catch { /* ignore */ }
  try { return fs.statSync(full).mtimeMs; } catch { return 0; }
}

/**
 * Find the newest crawl JSON per platform. Skips research-*.json (those are
 * hand-curated reports, not raw crawls) — we want fresh machine crawls.
 *
 * Each returned entry is annotated with { ageMs, ageDays, stale }. STALE crawls
 * (older than STALE_MAX_AGE_DAYS) are still returned so callers can REPORT the
 * gap, but buildCorpus() will NOT feed their content to the model — preventing
 * the digest from re-chewing a frozen file day after day.
 *
 * @param {string} intelDir  override for tests
 * @param {number} now       injectable clock (tests)
 */
export function findLatestCrawls(intelDir = INTEL_DIR, now = Date.now()) {
  const out = {};
  for (const platform of PLATFORMS) {
    const dir = path.join(intelDir, platform);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("research"))
      .map((f) => {
        const full = path.join(dir, f);
        return { platform, file: full, name: f, time: crawlTimeMs(full, f) };
      })
      .sort((a, b) => b.time - a.time);
    if (files.length) {
      const top = files[0];
      const ageMs = Math.max(0, now - top.time);
      out[platform] = {
        ...top,
        ageMs,
        ageDays: +(ageMs / (24 * 60 * 60 * 1000)).toFixed(2),
        stale: ageMs > STALE_MAX_AGE_MS,
      };
    }
  }
  return out;
}

/**
 * Crawl-before-digest orchestration. Runs the existing intel-*.js crawlers as
 * CHILD PROCESSES (never imported) so this advisory pipeline keeps its hard
 * guarantee of importing nothing money/config-touching. Best-effort: a crawler
 * that fails/blocks (nitter down, no TG session) is logged and skipped — the
 * digest then runs on whatever fresh crawls DID land, plus the staleness guard
 * keeps any stale leftover out of the corpus.
 *
 * Returns a report array the caller can surface (NOT a throw on failure).
 * Opt-in: only runs when called (CLI --crawl / INTEL_DIGEST_CRAWL=1).
 */
export function runCrawlers({ node = process.execPath, root = ROOT } = {}) {
  // Discord crawler must resolve discord.js-selfbot-v13 from discord-listener/.
  const jobs = [
    { platform: "x", script: path.join(root, "scripts", "intel-x.js"), cwd: root },
    { platform: "telegram", script: path.join(root, "scripts", "intel-telegram.js"), cwd: root },
    { platform: "discord", script: path.join(root, "scripts", "intel-discord.js"), cwd: path.join(root, "discord-listener") },
  ];
  const report = [];
  for (const job of jobs) {
    if (!fs.existsSync(job.script)) { report.push({ platform: job.platform, ok: false, reason: "script missing" }); continue; }
    let r;
    try {
      r = spawnSync(node, [job.script], {
        cwd: job.cwd,
        env: process.env,
        timeout: parseInt(process.env.INTEL_DIGEST_CRAWL_TIMEOUT_MS || "180000", 10),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      report.push({ platform: job.platform, ok: false, reason: e.message });
      continue;
    }
    const ok = r.status === 0;
    report.push({
      platform: job.platform,
      ok,
      exit: r.status,
      reason: ok ? null : (r.error?.message || `exit ${r.status}` + (r.stderr ? `: ${r.stderr.slice(-200)}` : "")),
    });
  }
  return report;
}

/**
 * Dedup-vs-existing: drop/flag suggestions that re-propose something Meridian
 * ALREADY has, by matching the suggestion text against KNOWN config flags +
 * known-implemented features. READ-ONLY on user-config.json (stat+parse, never
 * write). The #1/#2 suggestions that kept recurring (Fees/MC gate, TVL/MC gate,
 * partial TP, trailing TP, velocity exit) are already live — so they should be
 * filtered, not re-surfaced as "new".
 *
 * Returns { kept: [...], dropped: [{...suggestion, dedup_reason}] }.
 */
export function dedupVsExisting(suggestions, { configPath = path.join(ROOT, "user-config.json") } = {}) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { /* no config → dedup nothing */ }
  const merged = { ...cfg, ...(cfg.liveOverrides || {}), ...(cfg.internalAgents || {}) };

  // Map of human-phrase → predicate(merged) that returns true if ALREADY implemented.
  // Each entry: regexes that, if they hit the suggestion text, mean "we have this".
  const KNOWN = [
    { id: "tvl_mcap_gate", re: /tvl\s*[\/\-_ ]?\s*mc(ap)?|tvl_?mcap/i, has: (c) => c.tvlMcapGateEnabled === true || c.maxTvlMcapRatio != null },
    { id: "fees_mc_gate", re: /fee.{0,12}(mc|market\s*cap|active\s*tvl)|fees?\s*[\/]\s*mc|minFeeActiveTvl/i, has: (c) => c.minFeeActiveTvlRatio != null },
    { id: "partial_tp", re: /partial\s*(take[\s-]?profit|tp)/i, has: (c) => c.partialTpEnabled === true },
    { id: "trailing_tp", re: /trailing\s*(take[\s-]?profit|tp|stop)/i, has: (c) => c.trailingTakeProfit === true },
    { id: "velocity_exit", re: /velocity\s*(exit|drop)/i, has: (c) => c.velocityExitEnabled === true },
    { id: "stop_loss", re: /stop[\s-]?loss/i, has: (c) => c.stopLossPct != null },
    { id: "bin_step_filter", re: /bin\s*step\s*(filter|range|gate)/i, has: (c) => c.minBinStep != null && c.maxBinStep != null },
    { id: "rug_gate_mint_freeze", re: /(mint|freeze)\s*authority|renounce/i, has: (c) => c.requireMintRenounced === true || c.requireFreezeRenounced === true },
    { id: "bundler_top10", re: /bundle|top\s*10|holder\s*concentration/i, has: (c) => c.maxBundlePct != null || c.maxTop10Pct != null },
    { id: "dynamic_sizing", re: /dynamic\s*sizing|position\s*size\s*by\s*confidence|conviction\s*sizing/i, has: (c) => c.dynamicSizingEnabled === true },
    { id: "rebalance_oor", re: /rebalance\s*(on\s*)?(oor|out[\s-]?of[\s-]?range)/i, has: (c) => "rebalanceOnOorEnabled" in c },
    // Only fire when the suggestion is literally "adopt/switch to <the model we
    // already run>". A suggestion to evaluate a DIFFERENT cheaper model (e.g.
    // MiMo) is genuinely new and must NOT be filtered just because it name-drops
    // our current model as the baseline to beat.
    { id: "cheap_llm", re: /(switch|migrate|move|adopt|use)\s+(to\s+)?deepseek/i, has: (c) => /deepseek/i.test(String(c.llmModel || c.screeningModel || "")) },
  ];

  const kept = [];
  const dropped = [];
  for (const s of suggestions) {
    const hay = `${s.title || ""} ${s.detail || ""} ${s.advisory_action || ""}`;
    const match = KNOWN.find((k) => k.re.test(hay) && k.has(merged));
    if (match) dropped.push({ ...s, dedup_reason: `already_implemented:${match.id}` });
    else kept.push(s);
  }
  return { kept, dropped };
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
    if (!c) {
      sources.push({ platform, file: null, records: 0, stale: false, age_days: null, fed: false, note: "no crawl file" });
      continue;
    }
    // STALENESS GUARD: a crawl older than the window is reported but its content
    // is NOT fed to the model — this is what stops the digest re-chewing a frozen
    // file day after day and emitting an empty/identical result.
    if (c.stale) {
      sources.push({
        platform, file: path.relative(ROOT, c.file), records: 0,
        stale: true, age_days: c.ageDays, fed: false,
        note: `stale (> ${STALE_MAX_AGE_DAYS}d old) — excluded from corpus`,
      });
      continue;
    }
    const { lines, counts, total } = compactCrawl(c.file);
    perPlatform[platform] = lines;
    sources.push({
      platform, file: path.relative(ROOT, c.file), records: total,
      stale: false, age_days: c.ageDays, fed: lines.length > 0, topic_counts: counts,
    });
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
  "Respond with ONLY a single JSON object — no markdown code fences, no prose",
  "before or after, no ```json wrapper. The object MUST have exactly these two",
  'top-level keys: "suggestions" (an array, may be empty) and "summary" (a string).',
  "Each item in suggestions MUST have ALL of these keys:",
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
  "Example of a VALID response (shape only — do not copy the content):",
  '{"suggestions":[{"category":"tech_tooling","title":"Evaluate model X",'
    + '"detail":"Builders report X is cheaper for agent loops.","evidence":"\\"switched to X, cheaper\\"",'
    + '"confidence":0.6,"advisory_action":"Benchmark X vs current model"}],'
    + '"summary":"Builder cluster discusses cheaper tooling and onboarding friction."}',
  "",
  "If the intel contains nothing actionable, still return the object with an EMPTY",
  'suggestions array and a summary explaining why — NEVER return prose or an empty reply.',
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

// JSON-schema for OpenRouter structured outputs. DeepSeek V4 Flash advertises
// `structured_outputs` support (verified via OpenRouter /models), which GUARANTEES
// the response shape — strictly stronger than `json_object` JSON-mode (which only
// guarantees *valid* JSON, not the right keys). This is the core fix for the
// intermittent-empty bug: the model could previously return valid JSON with no
// `suggestions` key, silently yielding []. With a schema, the key is enforced.
const RESPONSE_JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "intel_digest",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["suggestions", "summary"],
      properties: {
        summary: { type: "string" },
        suggestions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["category", "title", "detail", "evidence", "confidence", "advisory_action"],
            properties: {
              category: { type: "string", enum: ["tech_tooling", "strategy", "preempt_bug", "competitor_move"] },
              title: { type: "string" },
              detail: { type: "string" },
              evidence: { type: "string" },
              confidence: { type: "number" },
              advisory_action: { type: "string" },
            },
          },
        },
      },
    },
  },
};

/**
 * Robust extractor: turn a raw model `content` string into an object with a
 * `suggestions` array + `summary`, tolerating the ways a model strays from the
 * contract even under structured outputs / JSON mode:
 *   (a) clean JSON                                  → parse directly
 *   (b) JSON wrapped in ```json ... ``` fences      → strip the fence, parse
 *   (c) prose before/after a JSON object            → extract the {...} block
 *   (d) alternate key names (recommendations/items) → normalize to suggestions
 *   (e) no JSON at all                              → { ok:false } so caller can
 *       retry once / log raw (NEVER silent []).
 *
 * Pure + exported for TDD. Returns { ok, obj, source } where source describes
 * which path succeeded (for debug logging).
 */
export function extractDigestJson(content) {
  const raw = String(content ?? "");
  if (!raw.trim()) return { ok: false, obj: null, source: "empty" };

  const tryParse = (str, source) => {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === "object" && !Array.isArray(o)) return { ok: true, obj: o, source };
    } catch { /* fall through */ }
    return null;
  };

  // (a) clean parse.
  let r = tryParse(raw.trim(), "clean");
  if (r) return normalizeDigestObj(r);

  // (b) strip a fenced block: ```json\n{...}\n``` or ```\n{...}\n```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    r = tryParse(fence[1].trim(), "fenced");
    if (r) return normalizeDigestObj(r);
  }

  // (c) first balanced {...} block anywhere in prose. Greedy match to the LAST
  // closing brace catches a complete top-level object even with trailing prose.
  const block = raw.match(/\{[\s\S]*\}/);
  if (block) {
    r = tryParse(block[0], "block");
    if (r) return normalizeDigestObj(r);
  }

  return { ok: false, obj: null, source: "unparseable" };
}

/** Normalize alternate shapes onto { suggestions:[], summary:"" }. */
function normalizeDigestObj({ obj, source }) {
  const sug = obj.suggestions
    ?? obj.recommendations
    ?? obj.items
    ?? obj.results
    ?? null;
  const out = {
    suggestions: Array.isArray(sug) ? sug : [],
    summary: typeof obj.summary === "string" ? obj.summary
      : (typeof obj.overview === "string" ? obj.overview : ""),
  };
  // ok only if we actually recovered the contractual shape (an array present,
  // even if empty IS valid — the model legitimately found nothing). A wholly
  // foreign object with neither key present is treated as a miss → retry/log.
  const hadKey = Array.isArray(sug) || typeof obj.summary === "string" || typeof obj.overview === "string";
  return { ok: hadKey, obj: out, source };
}

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
  // Source freshness table — makes stale data visible at a glance.
  if (Array.isArray(digest.sources) && digest.sources.length) {
    lines.push("| Platform | File | Records | Age (d) | Fed? |");
    lines.push("|---|---|---|---|---|");
    for (const s of digest.sources) {
      const fed = s.fed ? "yes" : (s.stale ? "STALE" : "no");
      lines.push(`| ${s.platform} | ${s.file ? path.basename(s.file) : "—"} | ${s.records ?? 0} | ${s.age_days ?? "—"} | ${fed} |`);
    }
    lines.push("");
  }
  if (digest.stale_blocked) {
    lines.push("> ⚠️ All crawls STALE — digest could not analyze fresh intel. Run crawlers (or `--crawl`).");
    lines.push("");
  }
  if (Array.isArray(digest.deduped_suggestions) && digest.deduped_suggestions.length) {
    lines.push(`> Filtered ${digest.deduped_suggestions.length} suggestion(s) as already-implemented: `
      + digest.deduped_suggestions.map((d) => d.dedup_reason?.replace("already_implemented:", "")).join(", "));
    lines.push("");
  }
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
export async function runDigest({ intelDir = INTEL_DIR, dryLlm = false, crawl = false } = {}) {
  // Optional: refresh crawls BEFORE reading, so the digest ingests fresh data
  // instead of whatever stale file happens to be on disk. Best-effort.
  let crawlReport = null;
  if (crawl) crawlReport = runCrawlers();

  const crawls = findLatestCrawls(intelDir);
  const { corpus, used, sources } = buildCorpus(crawls);

  const anyFresh = sources.some((s) => s.fed);
  const anyStale = sources.some((s) => s.stale);

  const base = {
    date: todayStamp(),
    generated_at: new Date().toISOString(),
    model: MODEL,
    advisory_only: true,
    note: "Suggestions for human review. This pipeline never edits config, state, or money paths.",
    crawl_report: crawlReport,
    stale_max_age_days: STALE_MAX_AGE_DAYS,
    sources,
    corpus_lines_used: used,
    suggestions: [],
    deduped_suggestions: [],
    summary: "",
    cost_usd: 0,
    usage: null,
  };

  if (!corpus) {
    base.summary = anyStale && !anyFresh
      ? `All available crawls are STALE (> ${STALE_MAX_AGE_DAYS}d old) — no fresh intel to analyze. `
        + `Run crawlers (intel-x/telegram/discord.js) or invoke digest with --crawl.`
      : "No intel crawl data found to analyze.";
    base.stale_blocked = anyStale && !anyFresh;
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

  // One bounded call + at most ONE retry on a parse/shape miss (Lyra cost note:
  // digest runs 1x/day; a single retry on the rare miss is ~$0.0015 extra, NOT
  // a loop). Attempt #1 uses structured outputs (schema-enforced); the retry
  // falls back to json_object JSON-mode in case a transient schema rejection /
  // provider quirk is what poisoned the first response.
  let usage = {};
  let finishReason = null;
  let content = "";
  let extracted = { ok: false, obj: null, source: "no_call" };
  let attempts = 0;
  const rawPreviews = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const useSchema = attempt === 1; // strong first, lenient fallback
    let response;
    try {
      response = await getClient().chat.completions.create({
        model: MODEL,
        messages,
        temperature: attempt === 1 ? 0.2 : 0.0, // tighter on retry
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: useSchema ? RESPONSE_JSON_SCHEMA : { type: "json_object" },
      });
    } catch (e) {
      // A 400 "response_format not supported" (or any schema rejection) on the
      // FIRST attempt should not waste the run — fall straight to the lenient
      // json_object retry rather than aborting.
      rawPreviews.push(`attempt${attempt} request_error: ${String(e?.message || e).slice(0, 200)}`);
      if (attempt === 1) continue;
      throw e;
    }

    const u = response.usage || {};
    // Accumulate usage across attempts so cost/audit reflects the real spend.
    usage = {
      prompt_tokens: (usage.prompt_tokens || 0) + (u.prompt_tokens || 0),
      completion_tokens: (usage.completion_tokens || 0) + (u.completion_tokens || 0),
      total_tokens: (usage.total_tokens || 0) + (u.total_tokens || 0),
    };
    finishReason = response.choices?.[0]?.finish_reason || finishReason;
    content = response.choices?.[0]?.message?.content || "";

    extracted = extractDigestJson(content);
    if (extracted.ok) break; // got the contractual shape → stop, no extra spend
    rawPreviews.push(`attempt${attempt}(${extracted.source}): ${content.slice(0, 200)}`);
  }

  recordLlmUsage({
    agentType: "ORION_INTEL_DIGEST",
    model: MODEL,
    step: attempts,
    finishReason,
    toolCalls: 0,
    usage,
  });
  base.usage = usage;
  base.cost_usd = computeCost(MODEL, usage);
  base.parse_attempts = attempts;
  base.parse_source = extracted.source;

  const parsed = extracted.obj || {};

  const rawSuggestions = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions.slice(0, 8).map((s) => ({
        category: String(s?.category || "strategy"),
        title: String(s?.title || "").slice(0, 120),
        detail: String(s?.detail || "").slice(0, 600),
        evidence: String(s?.evidence || "").slice(0, 400),
        confidence: Math.max(0, Math.min(1, Number(s?.confidence ?? 0))),
        advisory_action: String(s?.advisory_action || "").slice(0, 300),
      }))
    : [];

  // Dedup-vs-existing: filter out suggestions that re-propose already-live
  // features (the recurring #1/#2 Fees-MC / TVL-MC / partial-TP noise).
  const { kept, dropped } = dedupVsExisting(rawSuggestions);
  base.suggestions = kept;
  base.deduped_suggestions = dropped; // surfaced for audit (Lyra), not shown to operator as "new"

  base.summary = String(parsed?.summary || "").slice(0, 1000);
  if (!base.suggestions.length && !base.summary) {
    if (!extracted.ok) {
      // Genuine parse/shape failure after retry — NEVER silent. Surface that the
      // model output was unparseable + keep the raw previews so Orion/Lyra can
      // debug the next morning instead of staring at an empty [].
      base.summary = `Model output could not be parsed into the required schema after `
        + `${attempts} attempt(s) (last source: ${extracted.source}). Raw response logged for debug.`;
      base.parse_failed = true;
    } else {
      base.summary = dropped.length
        ? `Model returned ${dropped.length} suggestion(s) but all duplicate features Meridian already has.`
        : "Model parsed cleanly but extracted no actionable suggestions (empty intel landscape).";
    }
    base.raw_preview = (rawPreviews.length ? rawPreviews.join("\n---\n") : content).slice(0, 1000);
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
  // Crawl-before-digest: refresh source crawls first so the digest ingests fresh
  // data. Enabled by --crawl OR INTEL_DIGEST_CRAWL=1 (the systemd unit sets the env).
  const crawl = process.argv.includes("--crawl") || process.env.INTEL_DIGEST_CRAWL === "1";
  (async () => {
    try {
      if (crawl) console.log("[intel-digest] --crawl: refreshing source crawls before digest...");
      const digest = await runDigest({ dryLlm, crawl });
      const { jsonPath, mdPath } = writeDigest(digest);

      console.log(`\n=== INTEL DIGEST ${digest.date} (ADVISORY ONLY) ===`);
      console.log(`  model: ${digest.model}`);
      if (digest.crawl_report) {
        console.log(`  crawl: ${digest.crawl_report.map((c) => `${c.platform}=${c.ok ? "ok" : "FAIL"}`).join(", ")}`);
      }
      console.log(`  sources: ${digest.sources.map((s) => `${s.platform}(${s.records}${s.stale ? ",STALE" : ""}${s.age_days != null ? `,${s.age_days}d` : ""})`).join(", ") || "none"}`);
      console.log(`  corpus lines: ${digest.corpus_lines_used}`);
      console.log(`  suggestions: ${digest.suggestions.length}` + (digest.deduped_suggestions?.length ? ` (filtered ${digest.deduped_suggestions.length} already-implemented)` : ""));
      if (digest.stale_blocked) console.log(`  ⚠️ ALL CRAWLS STALE — no fresh intel analyzed`);
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

export { SYSTEM_PROMPT, renderMarkdown, topSuggestionsForTelegram, MODEL, MAX_INPUT_CHARS, RESPONSE_JSON_SCHEMA };
