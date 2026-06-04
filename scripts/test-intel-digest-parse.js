// Test for scripts/intel-digest.js — ROBUST PARSE suite.
// Run: node scripts/test-intel-digest-parse.js
//
// Orion 🏹 — guards the intermittent-empty-digest bug (3/5 days returned [] while
// the crawl + LLM call succeeded). Root cause: `response_format: json_object` is
// JSON-MODE — it guarantees valid JSON but NOT the schema, so the model could
// return valid JSON with no `suggestions` key → silent []. Fix: structured
// outputs (json_schema) on attempt #1 + a robust extractor + 1 retry + raw-log
// on failure (never silent). This suite proves the extractor + retry path.
//
// Fixtures cover:
//   (a) clean JSON
//   (b) JSON wrapped in ```json ... ``` fences
//   (c) JSON with prose before AND after the object
//   (d) alternate top-level key (recommendations / overview) → normalized
//   (e) valid JSON, WRONG shape (missing suggestions key) → ok:false
//   (f) no JSON at all → ok:false, graceful (no throw)
//   (g) empty intel landscape: { suggestions: [], summary } → ok:true (valid)
//   + runDigest retry: attempt#1 garbage → attempt#2 good → recovered, 2 attempts
//   + runDigest both-fail → parse_failed:true, raw_preview logged, NO crash

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const mod = await import("./intel-digest.js");
const { extractDigestJson, runDigest, RESPONSE_JSON_SCHEMA, __setClientForTests } = mod;

const GOOD = {
  suggestions: [
    { category: "tech_tooling", title: "Eval model X", detail: "d", evidence: "e", confidence: 0.6, advisory_action: "a" },
  ],
  summary: "landscape overview",
};

// ── (a) clean JSON. ──────────────────────────────────────────────────────────
{
  const r = extractDigestJson(JSON.stringify(GOOD));
  check("(a) clean JSON parses ok", r.ok === true && r.source === "clean");
  check("(a) clean JSON keeps suggestion", r.obj.suggestions.length === 1);
  check("(a) clean JSON keeps summary", r.obj.summary === "landscape overview");
}

// ── (b) fenced ```json block. ────────────────────────────────────────────────
{
  const fenced = "```json\n" + JSON.stringify(GOOD, null, 2) + "\n```";
  const r = extractDigestJson(fenced);
  check("(b) fenced ```json parses ok", r.ok === true && r.source === "fenced");
  check("(b) fenced extracts suggestion", r.obj.suggestions.length === 1);
}
{
  // bare fence with no language tag.
  const fenced = "```\n" + JSON.stringify(GOOD) + "\n```";
  const r = extractDigestJson(fenced);
  check("(b2) bare ``` fence parses ok", r.ok === true && r.obj.suggestions.length === 1);
}

// ── (c) prose before AND after. ──────────────────────────────────────────────
{
  const prosed = "Sure! Here is the analysis you asked for:\n\n"
    + JSON.stringify(GOOD)
    + "\n\nLet me know if you'd like more detail.";
  const r = extractDigestJson(prosed);
  check("(c) prose-wrapped JSON parses ok", r.ok === true);
  check("(c) prose-wrapped extracts suggestion", r.obj.suggestions.length === 1 && r.obj.summary === "landscape overview");
}

// ── (d) alternate key names normalized. ──────────────────────────────────────
{
  const alt = JSON.stringify({ recommendations: GOOD.suggestions, overview: "alt summary" });
  const r = extractDigestJson(alt);
  check("(d) 'recommendations' normalized to suggestions", r.ok === true && r.obj.suggestions.length === 1);
  check("(d) 'overview' normalized to summary", r.obj.summary === "alt summary");
}

// ── (e) valid JSON, WRONG shape (the actual production bug). ─────────────────
{
  // This is what JSON-mode could legitimately emit that silently produced [].
  const wrong = JSON.stringify({ result: "ok", data: { foo: 1 } });
  const r = extractDigestJson(wrong);
  check("(e) valid-JSON-wrong-shape → ok:false (not silent [])", r.ok === false);
}

// ── (f) no JSON at all → graceful. ───────────────────────────────────────────
{
  const r = extractDigestJson("I'm sorry, I cannot help with that request.");
  check("(f) non-JSON prose → ok:false, no throw", r.ok === false && r.source === "unparseable");
  const r2 = extractDigestJson("");
  check("(f2) empty string → ok:false source=empty", r2.ok === false && r2.source === "empty");
  const r3 = extractDigestJson(null);
  check("(f3) null content → ok:false, no throw", r3.ok === false);
}

// ── (g) empty intel landscape is VALID (model found nothing → empty array). ──
{
  const empty = JSON.stringify({ suggestions: [], summary: "Quiet day, nothing actionable." });
  const r = extractDigestJson(empty);
  check("(g) empty suggestions array is VALID ok:true", r.ok === true && r.obj.suggestions.length === 0);
  check("(g) empty-landscape summary preserved", /Quiet day/.test(r.obj.summary));
}

// ── runDigest retry: attempt#1 garbage, attempt#2 good → recovered. ──────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intel-parse-test-"));
const intelDir = path.join(tmp, "intel");
function writeCrawl(platform, name, records) {
  const dir = path.join(intelDir, platform);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ crawled_at: new Date().toISOString(), records }, null, 2));
}
writeCrawl("x", "x_now.json", [
  { author: "builder", text: "tried a new cheaper agent model this week, big savings", topics: ["llm", "technical"] },
]);

{
  let n = 0;
  const calls = [];
  const flakyClient = {
    chat: { completions: { create: async (payload) => {
      n += 1;
      calls.push({ attempt: n, response_format: payload.response_format?.type, temperature: payload.temperature });
      const content = n === 1
        ? "I think you should consider some options." // attempt #1: no JSON → miss
        : JSON.stringify(GOOD);                         // attempt #2: good
      return { choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } };
    } } },
  };
  __setClientForTests(flakyClient);
  const d = await runDigest({ intelDir });
  check("retry: attempt#1 used json_schema", calls[0]?.response_format === "json_schema");
  check("retry: attempt#2 fell back to json_object", calls[1]?.response_format === "json_object");
  check("retry: exactly 2 attempts (1 retry, no loop)", n === 2 && d.parse_attempts === 2);
  check("retry: recovered a suggestion on attempt#2", d.suggestions.length === 1);
  check("retry: usage accumulated across both attempts", d.usage.total_tokens === 2200);
  check("retry: not flagged parse_failed (recovered)", !d.parse_failed);
}

// ── runDigest both attempts fail → parse_failed, raw logged, NO crash. ───────
{
  let n = 0;
  const deadClient = {
    chat: { completions: { create: async () => {
      n += 1;
      return { choices: [{ finish_reason: "stop", message: { content: "no json here, sorry — attempt " + n } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } };
    } } },
  };
  __setClientForTests(deadClient);
  const d = await runDigest({ intelDir });
  check("both-fail: tried exactly 2 attempts", n === 2 && d.parse_attempts === 2);
  check("both-fail: parse_failed flag set (NOT silent [])", d.parse_failed === true);
  check("both-fail: summary explains the failure", /could not be parsed/i.test(d.summary));
  check("both-fail: raw_preview logged for debug (both attempts)", typeof d.raw_preview === "string" && /attempt1/.test(d.raw_preview) && /attempt2/.test(d.raw_preview));
  check("both-fail: suggestions is empty array (no crash)", Array.isArray(d.suggestions) && d.suggestions.length === 0);
  check("both-fail: cost still recorded (real spend audited)", d.cost_usd > 0);
}

// ── First-attempt schema REJECTION (400) → falls straight to json_object. ────
{
  let n = 0;
  const calls = [];
  const rejectSchemaClient = {
    chat: { completions: { create: async (payload) => {
      n += 1;
      calls.push(payload.response_format?.type);
      if (n === 1) { const e = new Error("response_format json_schema not supported"); throw e; }
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(GOOD) } }],
        usage: { prompt_tokens: 900, completion_tokens: 90, total_tokens: 990 } };
    } } },
  };
  __setClientForTests(rejectSchemaClient);
  const d = await runDigest({ intelDir });
  check("schema-reject: attempt#1 threw (json_schema), attempt#2 json_object", calls[0] === "json_schema" && calls[1] === "json_object");
  check("schema-reject: recovered on json_object fallback", d.suggestions.length === 1 && !d.parse_failed);
}

// Sanity: exported schema is well-formed structured-output spec.
check("RESPONSE_JSON_SCHEMA is json_schema type", RESPONSE_JSON_SCHEMA.type === "json_schema");
check("RESPONSE_JSON_SCHEMA requires suggestions+summary",
  RESPONSE_JSON_SCHEMA.json_schema.schema.required.includes("suggestions")
  && RESPONSE_JSON_SCHEMA.json_schema.schema.required.includes("summary"));
check("RESPONSE_JSON_SCHEMA is strict", RESPONSE_JSON_SCHEMA.json_schema.strict === true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
