// Test for scripts/intel-digest.js — FRESH-INGEST regression suite.
// Run: node scripts/test-intel-digest-fresh.js
//
// Guards the bug fixed 2026-06-02: the digest was re-ingesting a frozen 05-30
// crawl day after day (empty/identical output). Verifies:
//   - findLatestCrawls picks the freshest file by EMBEDDED TIMESTAMP, not mtime
//     (mtime lies after a git checkout / scp; the ISO stamp in the filename / the
//     crawled_at field is authoritative).
//   - staleness guard: a crawl older than STALE_MAX_AGE_DAYS is annotated stale
//     and EXCLUDED from the corpus (not silently re-fed).
//   - empty-corpus / all-stale is handled with an explicit stale_blocked verdict.
//   - dedup-vs-existing drops suggestions that re-propose already-live features,
//     while keeping genuinely-new ones.
//   - GUARDRAIL: runCrawlers shells out to child processes (no money/config import).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-stub-key";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-stub-key";
// Pin the staleness window so the test is deterministic regardless of env.
process.env.INTEL_DIGEST_STALE_DAYS = "2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
function check(label, cond) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); process.exitCode = 1; }
}

const DAY = 24 * 60 * 60 * 1000;

// ── Helpers to build a temp intel tree with timestamped crawl files. ─────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intel-fresh-test-"));
const intelDir = path.join(tmp, "intel");

function isoStamp(d) {
  // 2026-06-02T10-04-00-649Z (the crawler naming convention).
  return d.toISOString().replace(/[:.]/g, "-");
}
function writeCrawl(platform, dateObj, records, { crawledAt } = {}) {
  const dir = path.join(intelDir, platform);
  fs.mkdirSync(dir, { recursive: true });
  const prefix = platform === "x" ? "0xyunss" : "meridian";
  const name = `${prefix}_${isoStamp(dateObj)}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    crawled_at: (crawledAt || dateObj).toISOString(),
    records,
  }, null, 2));
  // Force mtime to "now" to PROVE selection is by embedded timestamp, not mtime.
  const now = new Date();
  fs.utimesSync(file, now, now);
  return file;
}

const NOW = Date.now();

// Two telegram crawls: an OLD one (stamp 05-30, ~3d ago) and a FRESH one
// (stamp = today). The fresh one must win even though both have "now" mtime.
const staleTg = writeCrawl("telegram", new Date(NOW - 3 * DAY), [
  { author: "stale", text: "old 05-30 chatter that must NOT be re-ingested", topics: ["complaint"] },
]);
const freshTg = writeCrawl("telegram", new Date(NOW - 1 * 60 * 60 * 1000), [
  { author: "0xyunss", text: "switched to a new cheaper agentic coding model today", topics: ["llm", "technical"] },
]);
// X: ONLY a stale crawl (3 days old) → should be flagged stale & excluded.
const staleX = writeCrawl("x", new Date(NOW - 3 * DAY), [
  { author: "0xyunss", text: "ancient post, do not feed", topics: ["alpha"] },
]);

const digestMod = await import("./intel-digest.js");
const {
  findLatestCrawls, buildCorpus, runDigest, dedupVsExisting, runCrawlers,
  __setClientForTests,
} = digestMod;

// ── 1. findLatestCrawls picks freshest by EMBEDDED TIMESTAMP (not mtime). ────
const crawls = findLatestCrawls(intelDir, NOW);
check("telegram crawl resolved", !!crawls.telegram);
check("picked FRESH telegram crawl (timestamp wins over equal mtime)",
  crawls.telegram && crawls.telegram.file === freshTg);
check("fresh telegram crawl NOT flagged stale", crawls.telegram && crawls.telegram.stale === false);
check("fresh telegram crawl has small ageDays", crawls.telegram && crawls.telegram.ageDays < 1);

check("x crawl resolved (stale-only)", !!crawls.x);
check("x crawl flagged STALE (3d > 2d window)", crawls.x && crawls.x.stale === true);
check("x crawl ageDays ~3", crawls.x && crawls.x.ageDays >= 2.9 && crawls.x.ageDays <= 3.1);

// ── 2. buildCorpus feeds fresh, EXCLUDES stale, reports both. ────────────────
const { corpus, sources } = buildCorpus(crawls);
check("corpus includes fresh telegram content", /cheaper agentic coding model today/.test(corpus));
check("corpus EXCLUDES stale telegram content", !/must NOT be re-ingested/.test(corpus));
check("corpus EXCLUDES stale x content", !/ancient post/.test(corpus));
const xSrc = sources.find((s) => s.platform === "x");
check("x source reported as stale + not fed", xSrc && xSrc.stale === true && xSrc.fed === false);
const tgSrc = sources.find((s) => s.platform === "telegram");
check("telegram source reported fed=true", tgSrc && tgSrc.fed === true);
const dcSrc = sources.find((s) => s.platform === "discord");
check("missing discord source reported (no crawl file)", dcSrc && dcSrc.fed === false && dcSrc.file === null);

// ── 3. ALL-STALE corpus → stale_blocked verdict, no LLM call. ────────────────
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "intel-allstale-"));
const intelDir2 = path.join(tmp2, "intel");
(function buildAllStale() {
  for (const p of ["x", "telegram", "discord"]) {
    const dir = path.join(intelDir2, p);
    fs.mkdirSync(dir, { recursive: true });
    const prefix = p === "x" ? "0xyunss" : "meridian";
    const old = new Date(NOW - 5 * DAY);
    const file = path.join(dir, `${prefix}_${isoStamp(old)}.json`);
    fs.writeFileSync(file, JSON.stringify({ crawled_at: old.toISOString(), records: [{ author: "x", text: "5d old", topics: ["llm"] }] }));
    fs.utimesSync(file, new Date(), new Date()); // mtime now, but stamp is 5d old
  }
})();
let llmCalled = false;
__setClientForTests({ chat: { completions: { create: async () => { llmCalled = true; return { choices: [{ message: { content: "{}" } }], usage: {} }; } } } });
const allStale = await runDigest({ intelDir: intelDir2 });
check("all-stale → no LLM call (corpus empty)", llmCalled === false);
check("all-stale → stale_blocked verdict", allStale.stale_blocked === true);
check("all-stale → summary explains staleness", /STALE/i.test(allStale.summary));
check("all-stale → zero suggestions", allStale.suggestions.length === 0);

// ── 4. Empty intel dir → plain 'no data' (not stale_blocked). ────────────────
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "intel-empty-"));
const emptyDigest = await runDigest({ intelDir: path.join(tmp3, "intel") });
check("empty dir → no suggestions", emptyDigest.suggestions.length === 0);
check("empty dir → NOT stale_blocked", emptyDigest.stale_blocked !== true);
check("empty dir → 'no data' summary", /no intel crawl data/i.test(emptyDigest.summary));

// ── 5. dedup-vs-existing: drops already-live, keeps genuinely-new. ───────────
const dd = dedupVsExisting([
  { title: "Adopt TVL/MC gate", detail: "Use TVL/MC < 0.2 gate", advisory_action: "" },
  { title: "Enable partial take-profit", detail: "Partial TP at +15%", advisory_action: "" },
  { title: "Add trailing take-profit", detail: "trailing TP ladder", advisory_action: "" },
  { title: "Add velocity exit", detail: "velocity drop exit", advisory_action: "" },
  { title: "Evaluate Xiaomi MiMo v2.5", detail: "Try MiMo, cheaper than our current model", advisory_action: "Benchmark vs DeepSeek V4" },
  { title: "Add per-pool dynamic fee oracle", detail: "novel idea we do not have", advisory_action: "" },
]);
check("dedup drops TVL/MC gate (already live)", dd.dropped.some((d) => /tvl_mcap_gate/.test(d.dedup_reason)));
check("dedup drops partial TP (already live)", dd.dropped.some((d) => /partial_tp/.test(d.dedup_reason)));
check("dedup drops trailing TP (already live)", dd.dropped.some((d) => /trailing_tp/.test(d.dedup_reason)));
check("dedup drops velocity exit (already live)", dd.dropped.some((d) => /velocity_exit/.test(d.dedup_reason)));
check("dedup KEEPS MiMo eval (new tool, only name-drops baseline)",
  dd.kept.some((s) => /MiMo/.test(s.title)));
check("dedup KEEPS genuinely-novel suggestion",
  dd.kept.some((s) => /dynamic fee oracle/.test(s.title)));
check("dedup dropped reasons are advisory-only (no auto-apply)",
  dd.dropped.every((d) => typeof d.dedup_reason === "string" && d.dedup_reason.startsWith("already_implemented:")));

// ── 6. GUARDRAIL: runCrawlers shells out (no money/config import) + best-effort. ──
const src = fs.readFileSync(path.join(ROOT, "scripts", "intel-digest.js"), "utf8");
check("runCrawlers uses child_process (no in-process import of crawlers)",
  /spawnSync/.test(src) && /child_process/.test(src));
const forbidden = ["executor", "dlmm.js", "wallet.js", "update_config", "state.js"];
check("no money/config-mutation import added",
  !src.split("\n").filter((l) => /^\s*import\s/.test(l)).some((l) => forbidden.some((f) => l.includes(f))));
// runCrawlers must NOT throw even when a crawler is absent — point it at an empty root.
const reportTmp = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-root-"));
let crawlThrew = false;
let report;
try { report = runCrawlers({ root: reportTmp }); } catch { crawlThrew = true; }
check("runCrawlers never throws on missing crawlers (best-effort)", crawlThrew === false);
check("runCrawlers returns a per-platform report", Array.isArray(report) && report.length === 3);
check("runCrawlers reports missing scripts as not-ok", report.every((r) => r.ok === false));

// ── Cleanup. ─────────────────────────────────────────────────────────────────
for (const d of [tmp, tmp2, tmp3, reportTmp]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) { console.error("\nTEST FAILED"); process.exit(1); }
