/**
 * Test: auto-screener candidate field-mapping + null-token-address guard.
 *
 * Sirius signal-collector forensic harness.
 *
 * THE LAST WALL (Draco empirical 2026-06-11, post 24e2ab5): candidates cleared
 * every Cassiopeia gate but saveToInbox skipped them all ("0 candidates, skipped
 * N with no token address"). Root cause = field-name mismatch. getTopCandidates
 * returns the `condensePool` shape { pool, name, base:{symbol,mint}, ... }, but
 * saveToInbox read flat names condensePool never emits (base_mint / token_address
 * / pool_address / symbol). The mint was ALWAYS present at base.mint.
 *
 * These tests now use the REAL condensed candidate shape as the primary case
 * (the old tests used a fictional flat shape, which is why the bug shipped green),
 * plus flat-alias back-compat, and the parser wall-10 regression.
 */
process.env.AUTO_SCREENER_NO_AUTOSTART = "1";

const { saveToInbox } = await import("./auto-screener.js");
const { parseSignalMessage } = await import("../signal-parser.js");

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("=== auto-screener candidate field-mapping + guard tests ===\n");

// --- Test 1: REAL condensePool shape (nested base.mint / pool / base.symbol) ---
console.log("[1] Real condensePool shape — the shape getTopCandidates actually returns");
const writes = [];
const mkdirs = [];
const fakeFs = {
  mkdirSync: (p) => mkdirs.push(p),
  writeFileSync: (p, c) => writes.push({ path: p, content: c }),
};

const condensed = [
  {
    pool: "PoolAddrAAA11111111111111111111111111111111",
    name: "AAA-SOL",
    base: { symbol: "AAA", mint: "AAAmint1111111111111111111111111111111111111" },
    quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
    tvl: 50000, volume_window: 12000, fee_active_tvl_ratio: 0.12,
    organic_score: 70, bin_step: 100, volatility: 2.5,
  },
  {
    pool: "PoolAddrBBB22222222222222222222222222222222",
    name: "BBB-SOL",
    base: { symbol: "BBB", mint: "BBBmint2222222222222222222222222222222222222" },
    quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
    tvl: 30000, volume_window: 8000, fee_active_tvl_ratio: 0.09,
    organic_score: 65, bin_step: 80, volatility: 3.1,
  },
];

const r1 = saveToInbox(condensed, { fsImpl: fakeFs });
assert(r1.written === 2, `wrote 2 files from condensed shape (got ${r1.written})`);
assert(r1.skipped === 0, `skipped 0 well-formed candidates (got ${r1.skipped})`);
assert(writes.length === 2, `fakeFs.writeFileSync called 2 times (got ${writes.length})`);
assert(writes.some((w) => /screener-AAA/i.test(w.path)) && writes.some((w) => /screener-BBB/i.test(w.path)),
  "filenames use base.symbol (AAA/BBB), not 'unknown'");
assert(writes.every((w) => /Token: (AAA|BBB)mint/.test(w.content)),
  "Token: line resolved from base.mint");
assert(writes.every((w) => /Pool: PoolAddr(AAA|BBB)/.test(w.content)),
  "Pool: line resolved from c.pool (not 'undefined')");
assert(writes.every((w) => !/undefined/.test(w.content)),
  "no 'undefined' anywhere in inbox content");

// --- Test 2: flat-alias back-compat (defensive) ---
console.log("\n[2] Flat-alias back-compat — base_mint / token_address / pool_address");
const writes2 = [];
const fakeFs2 = { mkdirSync: () => {}, writeFileSync: (p, c) => writes2.push({ path: p, content: c }) };
const flat = [
  { symbol: "FA", pool_address: "PoolFlatA11111111111111111111111111111111111", base_mint: "FAmint11111111111111111111111111111111111111" },
  { symbol: "FB", pool_address: "PoolFlatB22222222222222222222222222222222222", token_address: "FBmint2222222222222222222222222222222222222" },
];
const r2 = saveToInbox(flat, { fsImpl: fakeFs2 });
assert(r2.written === 2, "wrote 2 from flat aliases (back-compat)");
assert(r2.skipped === 0, "skipped 0");
assert(writes2.every((w) => /Token: F[AB]mint/.test(w.content)), "flat base_mint/token_address resolved to Token:");

// --- Test 3: fail-closed — no resolvable mint anywhere ---
console.log("\n[3] Fail-closed — candidates with no resolvable token mint");
const writes3 = [];
const fakeFs3 = { mkdirSync: () => {}, writeFileSync: (p, c) => writes3.push({ path: p, content: c }) };
const noMint = [
  { pool: "Pool1", base: { symbol: "Z1", mint: null } },     // null nested mint
  { pool: "Pool2", base: { symbol: "Z2" } },                 // missing nested mint
  { pool: "Pool3", base_mint: "" },                          // empty flat
  { pool: "Pool4", base_mint: "   " },                       // whitespace flat
  { pool: "Pool5" },                                         // nothing at all
];
const r3 = saveToInbox(noMint, { fsImpl: fakeFs3 });
assert(r3.written === 0, "wrote 0 (all mint-less)");
assert(r3.skipped === 5, `skipped 5 (got ${r3.skipped})`);
assert(writes3.length === 0, "no fs writes for mint-less candidates");

// --- Test 4: fail-closed — mint present but pool address missing ---
console.log("\n[4] Fail-closed — mint present but no pool address (undeployable)");
const writes4 = [];
const fakeFs4 = { mkdirSync: () => {}, writeFileSync: (p, c) => writes4.push({ path: p, content: c }) };
const noPool = [
  { base: { symbol: "NP", mint: "NPmint1111111111111111111111111111111111111" } }, // mint, no pool
];
const r4 = saveToInbox(noPool, { fsImpl: fakeFs4 });
assert(r4.written === 0, "wrote 0 (mint but no pool → undeployable)");
assert(r4.skipped === 1, "skipped 1");

// --- Test 5: empty list ---
console.log("\n[5] Empty candidates list");
const r5 = saveToInbox([], { fsImpl: { mkdirSync: () => {}, writeFileSync: () => {} } });
assert(r5.written === 0 && r5.skipped === 0, "wrote 0, skipped 0");

// --- Test 6: end-to-end — written inbox file parses back to the TOKEN mint ---
console.log("\n[6] Wall-10 — inbox file parses back to the token mint, NOT the pool address");
const writes6 = [];
const fakeFs6 = { mkdirSync: () => {}, writeFileSync: (p, c) => writes6.push({ path: p, content: c }) };
const tokenMint = "TKNmint11111111111111111111111111111111111111".slice(0, 44);
const poolAddr  = "PoolXYZ999999999999999999999999999999999999".slice(0, 44);
saveToInbox([{ pool: poolAddr, base: { symbol: "TKN", mint: tokenMint } }], { fsImpl: fakeFs6 });
assert(writes6.length === 1, "one file written");
const parsed = parseSignalMessage(writes6[0].content);
assert(parsed.tokenAddress === tokenMint,
  `parser picks the Token: mint (${parsed.tokenAddress?.slice(0, 8)}…), not the Pool: addr`);
assert(parsed.tokenAddress !== poolAddr,
  "parser does NOT mistake the pool address for the token mint");

// --- Test 7: parser Token-line priority over a pump-suffixed pool address ---
console.log("\n[7] Wall-10 — explicit Token: line beats positional + suffix heuristics");
const sig = [
  "[SCREENER SIGNAL] FOO / FOO-SOL",
  "Pool: SomePoolAddr1111111111111111111111111pump", // pool addr that happens to end 'pump'
  "Token: RealTokenMint2222222222222222222222222222",
  "Source: Meteora auto-screener",
].join("\n");
const p7 = parseSignalMessage(sig);
assert(p7.tokenAddress === "RealTokenMint2222222222222222222222222222",
  "Token: line wins even when the Pool: address ends in 'pump'");

// --- summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
