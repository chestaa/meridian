// scripts/test-btc-price-oracle.js — independent cbBTC price resolution.
// Proves: Jupiter price v3 primary, cached BTC close fallback, FAIL-CLOSED when
// neither is usable. Fetch + history loader injected — NO network. Run:
//   node scripts/test-btc-price-oracle.js

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const O = await import("../tsmom/btc-price-oracle.js");
const { CBBTC_MINT } = await import("../tsmom/btc-guards.js");

const jResp = (price) => ({ ok: true, json: async () => ({ [CBBTC_MINT]: { usdPrice: price } }) });
const jBad = () => ({ ok: false, json: async () => ({}) });
const jThrow = () => { throw new Error("network down"); };
const hist = (close) => () => ({ rows: [{ date: "d1", close: close * 0.99 }, { date: "d2", close }, { date: "d3-partial", close: close * 1.5 }] });

// ── PRIMARY: Jupiter price v3 ────────────────────────────────────────────────────
ok((await O.fetchJupiterCbbtcPrice({ fetchFn: async () => jResp(61000) })) === 61000, "Jupiter v3 returns usdPrice");
ok((await O.fetchJupiterCbbtcPrice({ fetchFn: async () => jResp(0) })) === null, "Jupiter v3 zero price => null (strict positive)");
ok((await O.fetchJupiterCbbtcPrice({ fetchFn: async () => jBad() })) === null, "Jupiter v3 non-ok HTTP => null");
ok((await O.fetchJupiterCbbtcPrice({ fetchFn: async () => jThrow() })) === null, "Jupiter v3 throw => null (caught)");

// ── FALLBACK: cached BTC close uses second-to-last (closed) bar, not partial last ─
ok(O.fetchCachedBtcClose({ loadHistoryFn: hist(60000) }) === 60000, "cached close = latest CLOSED bar (not partial live)");
ok(O.fetchCachedBtcClose({ loadHistoryFn: () => ({ rows: [{ close: 1 }] }) }) === null, "cached <2 rows => null");
ok(O.fetchCachedBtcClose({ loadHistoryFn: () => null }) === null, "cached no history => null");

// ── resolve: primary wins ─────────────────────────────────────────────────────
let r = await O.resolveCbbtcPrice({ fetchFn: async () => jResp(62000), loadHistoryFn: hist(60000) });
ok(r.ok && r.price === 62000 && r.source === "jupiter_price_v3", "resolve prefers live Jupiter price");

// ── resolve: falls back to cache when live unavailable ──────────────────────────
r = await O.resolveCbbtcPrice({ fetchFn: async () => jBad(), loadHistoryFn: hist(59000) });
ok(r.ok && r.price === 59000 && r.source === "cached_btc_close_fallback", "resolve falls back to cached close");

// ── resolve: FAIL-CLOSED when both unavailable ──────────────────────────────────
r = await O.resolveCbbtcPrice({ fetchFn: async () => jThrow(), loadHistoryFn: () => null });
ok(!r.ok && r.price === null && r.reason === "no_independent_price_fail_closed", "resolve fail-closed when both sources dead");

console.log(`\nbtc-price-oracle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
