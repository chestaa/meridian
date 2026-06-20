/**
 * Vega — pre-deploy snapshot fetch retry-with-backoff tests.
 *
 * Money-path: validateDeployPoolThresholds() re-fetches live pool metrics right
 * before deploy_position. A transient 429 burst (Draco restart-3 thundering herd)
 * used to fail-close and block a VALID deploy. Fix = bounded retry-with-backoff
 * on transient errors (429/502/503/504/timeout) BEFORE fail-close.
 *
 * Asserts:
 *   (a) 429 once then 200 → ride-through, detail returned (deploy proceeds)
 *   (b) 429 every attempt → retries exhausted → THROWS → caller fail-closes
 *   (c) non-transient (404) → throws immediately, NO retry
 *   (d) deploy_position is NOT retried — only the snapshot fetch is (structural)
 *   (e) transient classifier matrix (429/5xx/timeout transient; 4xx/400 not)
 */
import {
  isTransientFetchError,
  __setSnapshotFetchForTests,
  __resetSnapshotFetchForTests,
  __fetchFreshPoolDetailForTests,
  buildReuseDetailFromSnapshot,
  __validateDeployPoolThresholdsForTests,
} from "../tools/executor.js";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const POOL = "PoolAddr11111111111111111111111111111111111";

function okResponse(detail) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data: detail ? [detail] : [] }),
  };
}
function errResponse(status, statusText = "") {
  return { ok: false, status, statusText };
}

console.log("=== Vega snapshot-fetch retry-with-backoff tests ===\n");

// ── (a) 429 once → then 200 → ride-through ───────────────────────────────
console.log("[a] 429 once then 200 → ride-through (detail returned, deploy proceeds)");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    if (calls === 1) return errResponse(429, "Too Many Requests");
    return okResponse({ pool_address: POOL, volatility: 5 });
  }, [0, 0, 0]); // zero backoff for fast test

  let detail = null, threw = false;
  try { detail = await __fetchFreshPoolDetailForTests(POOL); }
  catch (_e) { threw = true; }

  assert(!threw, "did not throw (transient ride-through)");
  assert(calls === 2, `retried exactly once then succeeded (calls=${calls})`);
  assert(detail && detail.pool_address === POOL, "fresh detail returned to caller");
  __resetSnapshotFetchForTests();
}

// ── (b) 429 every attempt → retries exhausted → fail-close ───────────────
console.log("\n[b] 429 every attempt → retries exhausted → THROWS → caller fail-closes");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    return errResponse(429, "Too Many Requests");
  }, [0, 0, 0]);

  let threw = false, msg = "";
  try { await __fetchFreshPoolDetailForTests(POOL); }
  catch (e) { threw = true; msg = e.message; }

  assert(threw, "threw after exhausting retries (fail-closed PRESERVED)");
  assert(calls === 6, `total attempts = 1 + 5 retries (calls=${calls})`);
  assert(msg.includes("429") || msg.toLowerCase().includes("api error"), `error propagated (${msg})`);
  __resetSnapshotFetchForTests();
}

// ── (c) non-transient (404) → throws immediately, NO retry ───────────────
console.log("\n[c] non-transient 404 → throws immediately, NO retry");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    return errResponse(404, "Not Found");
  }, [0, 0, 0]);

  let threw = false;
  try { await __fetchFreshPoolDetailForTests(POOL); }
  catch (_e) { threw = true; }

  assert(threw, "threw on non-transient error (fail-close)");
  assert(calls === 1, `did NOT retry permanent error (calls=${calls})`);
  __resetSnapshotFetchForTests();
}

// ── (c2) non-transient 400 → no retry ────────────────────────────────────
console.log("\n[c2] non-transient 400 → throws immediately, NO retry");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => { calls += 1; return errResponse(400, "Bad Request"); }, [0, 0, 0]);
  let threw = false;
  try { await __fetchFreshPoolDetailForTests(POOL); } catch (_e) { threw = true; }
  assert(threw && calls === 1, `400 fail-close, no retry (calls=${calls})`);
  __resetSnapshotFetchForTests();
}

// ── (d) transient 503 ride-through (5xx burst) ───────────────────────────
console.log("\n[d] 503 twice then 200 → ride-through within retry budget");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    if (calls <= 2) return errResponse(503, "Service Unavailable");
    return okResponse({ pool_address: POOL });
  }, [0, 0, 0]);
  let detail = null, threw = false;
  try { detail = await __fetchFreshPoolDetailForTests(POOL); } catch (_e) { threw = true; }
  assert(!threw && calls === 3 && detail, `503 burst ride-through (calls=${calls})`);
  __resetSnapshotFetchForTests();
}

// ── (e) network timeout (AbortError) is transient ────────────────────────
console.log("\n[e] network timeout (AbortError) once then 200 → ride-through");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    if (calls === 1) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    return okResponse({ pool_address: POOL });
  }, [0, 0, 0]);
  let detail = null, threw = false;
  try { detail = await __fetchFreshPoolDetailForTests(POOL); } catch (_e) { threw = true; }
  assert(!threw && calls === 2 && detail, `timeout treated as transient (calls=${calls})`);
  __resetSnapshotFetchForTests();
}

// ── (f) transient classifier matrix ──────────────────────────────────────
console.log("\n[f] isTransientFetchError classifier matrix");
{
  const t = (s) => { const e = new Error("x"); e.status = s; return e; };
  assert(isTransientFetchError(t(429)) === true, "429 transient");
  assert(isTransientFetchError(t(502)) === true, "502 transient");
  assert(isTransientFetchError(t(503)) === true, "503 transient");
  assert(isTransientFetchError(t(504)) === true, "504 transient");
  assert(isTransientFetchError(t(404)) === false, "404 NOT transient");
  assert(isTransientFetchError(t(400)) === false, "400 NOT transient");
  assert(isTransientFetchError(t(401)) === false, "401 NOT transient");
  const ab = new Error("aborted"); ab.name = "AbortError";
  assert(isTransientFetchError(ab) === true, "AbortError (timeout) transient");
  const te = new TypeError("fetch failed");
  assert(isTransientFetchError(te) === true, "fetch TypeError transient");
  assert(isTransientFetchError(new Error("bad json")) === false, "generic error NOT transient");
  assert(isTransientFetchError(null) === false, "null NOT transient");
}

// ── (g) deploy_position single-attempt invariant (structural assertion) ──
console.log("\n[g] deploy_position is NOT wrapped in retry (anti-pattern #4 guard)");
{
  // The retry seam only intercepts the snapshot READ fetch. deploy_position TX
  // runs once after safety checks pass; a failed safety check returns
  // {blocked:true} and the TX never fires. We assert the seam is read-only by
  // confirming the injected fetch is consulted ONLY for the snapshot URL shape.
  let urls = [];
  __setSnapshotFetchForTests(async (url) => {
    urls.push(url);
    return okResponse({ pool_address: POOL });
  }, [0, 0, 0]);
  await __fetchFreshPoolDetailForTests(POOL);
  assert(urls.length === 1, `snapshot fetch hit once (read-only, no deploy retry) (urls=${urls.length})`);
  assert(urls[0].includes("/pools") && urls[0].includes(POOL), "fetched the pool-discovery snapshot URL only");
  __resetSnapshotFetchForTests();
}

// ── (h) raised budget: 429 burst recovers at attempt 5 (was IMPOSSIBLE @3) ─
console.log("\n[h] 429 x4 then 200 → ride-through within RAISED 5-retry budget (Lyra 06-20 longer burst)");
{
  let calls = 0;
  __setSnapshotFetchForTests(async () => {
    calls += 1;
    if (calls <= 4) return errResponse(429, "Too Many Requests");
    return okResponse({ pool_address: POOL, volatility: 5 });
  }, [0, 0, 0, 0, 0]);
  let detail = null, threw = false;
  try { detail = await __fetchFreshPoolDetailForTests(POOL); } catch (_e) { threw = true; }
  assert(!threw && calls === 5 && detail, `4x429 burst rode through to attempt 5 (calls=${calls}) — would have fail-closed at old budget`);
  __resetSnapshotFetchForTests();
}

// ── (i) buildReuseDetailFromSnapshot — TTL + fail-closed completeness matrix ─
console.log("\n[i] buildReuseDetailFromSnapshot — reuse-discovery TTL + fail-closed matrix");
{
  const now = 1_000_000_000_000;
  const fresh = { discovered_at: now - 1000, tvl: 50000, fee_active_tvl_ratio: 0.15, volatility: 5, bin_step: 100 };
  const r = buildReuseDetailFromSnapshot(fresh, now);
  assert(r && r.tvl === 50000 && r._reused_from_discovery === true, "fresh complete snapshot → reusable detail built");
  assert(r && r.dlmm_params.bin_step === 100, "bin_step carried into dlmm_params shape");

  const stale = { ...fresh, discovered_at: now - (6 * 60 * 1000) }; // 6min > 5min TTL
  assert(buildReuseDetailFromSnapshot(stale, now) === null, "stale snapshot (>5min TTL) → null (fail-close)");

  assert(buildReuseDetailFromSnapshot({ ...fresh, tvl: null }, now) === null, "missing tvl → null (fail-closed, anti-pattern #2)");
  assert(buildReuseDetailFromSnapshot({ ...fresh, fee_active_tvl_ratio: null }, now) === null, "missing fee/TVL → null (fail-closed)");
  assert(buildReuseDetailFromSnapshot({ ...fresh, volatility: null }, now) === null, "missing volatility → null (fail-closed)");
  assert(buildReuseDetailFromSnapshot({ ...fresh, discovered_at: null }, now) === null, "missing discovered_at → null (fail-closed)");
  assert(buildReuseDetailFromSnapshot(null, now) === null, "null snapshot → null");
  assert(buildReuseDetailFromSnapshot({ discovered_at: now + 99999, tvl: 1, fee_active_tvl_ratio: 1, volatility: 1 }, now) === null, "future timestamp (negative age) → null");
}

// ── (j) 429-EXHAUST + fresh discovery snapshot → REUSE → deploy verify PASSES ─
console.log("\n[j] re-fetch 429-exhausts BUT fresh discovery snapshot present → reuse → PASS (income unblock)");
{
  __setSnapshotFetchForTests(async () => errResponse(429, "Too Many Requests"), [0, 0, 0, 0, 0]);
  const res = await __validateDeployPoolThresholdsForTests({
    pool_address: POOL,
    fee_tvl_ratio: 0.15,
    candidate_snapshot: {
      discovered_at: Date.now(),
      tvl: 50000,
      fee_active_tvl_ratio: 0.15,
      volatility: 5,
      bin_step: 100,
    },
  });
  assert(res.pass === true, `deploy verify PASSED via discovery-snapshot reuse despite total 429 (reason=${res.reason || "n/a"})`);
  __resetSnapshotFetchForTests();
}

// ── (k) 429-EXHAUST + NO reusable snapshot → FAIL-CLOSE (preserved) ──────────
console.log("\n[k] re-fetch 429-exhausts + NO fresh snapshot → fail-close snapshot_verify_failed (preserved)");
{
  __setSnapshotFetchForTests(async () => errResponse(429, "Too Many Requests"), [0, 0, 0, 0, 0]);
  const res = await __validateDeployPoolThresholdsForTests({
    pool_address: POOL,
    // no candidate_snapshot → no fallback possible
  });
  assert(res.pass === false, "fail-closed when no reusable snapshot");
  assert(String(res.reason).includes("snapshot_verify_failed"), `reason marks snapshot_verify_failed (${res.reason})`);
  __resetSnapshotFetchForTests();
}

// ── (l) 429-EXHAUST + STALE snapshot → FAIL-CLOSE (TTL guards staleness) ─────
console.log("\n[l] re-fetch 429-exhausts + STALE snapshot (>TTL) → fail-close (no stale-data deploy)");
{
  __setSnapshotFetchForTests(async () => errResponse(429, "Too Many Requests"), [0, 0, 0, 0, 0]);
  const res = await __validateDeployPoolThresholdsForTests({
    pool_address: POOL,
    fee_tvl_ratio: 0.15,
    candidate_snapshot: {
      discovered_at: Date.now() - (10 * 60 * 1000), // 10min stale
      tvl: 50000, fee_active_tvl_ratio: 0.15, volatility: 5, bin_step: 100,
    },
  });
  assert(res.pass === false && String(res.reason).includes("snapshot_verify_failed"), `stale snapshot NOT reused → fail-close (${res.reason})`);
  __resetSnapshotFetchForTests();
}

// ── (m) NON-transient (404) exhaust → NO reuse even with fresh snapshot ──────
console.log("\n[m] non-transient 404 → NO reuse even with fresh snapshot (reuse is 429-only ride-through)");
{
  __setSnapshotFetchForTests(async () => errResponse(404, "Not Found"), [0, 0, 0, 0, 0]);
  const res = await __validateDeployPoolThresholdsForTests({
    pool_address: POOL,
    fee_tvl_ratio: 0.15,
    candidate_snapshot: { discovered_at: Date.now(), tvl: 50000, fee_active_tvl_ratio: 0.15, volatility: 5, bin_step: 100 },
  });
  assert(res.pass === false && String(res.reason).includes("snapshot_verify_failed"), `404 fail-closes regardless of snapshot (reuse gated on transient only) (${res.reason})`);
  __resetSnapshotFetchForTests();
}

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
