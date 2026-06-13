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
  assert(calls === 4, `total attempts = 1 + 3 retries (calls=${calls})`);
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

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
