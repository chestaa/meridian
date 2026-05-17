/**
 * Test: auto-screener null-token-address guard
 * Validates saveToInbox() filters out candidates missing base_mint/token_address.
 * Sirius signal-collector forensic harness.
 */
process.env.AUTO_SCREENER_NO_AUTOSTART = "1";

const { saveToInbox } = await import("./auto-screener.js");

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

console.log("=== auto-screener null-token-address guard tests ===\n");

// --- Test 1: mixed candidates (3 with token, 2 without) ---
console.log("[1] Mixed candidates — 3 with token address, 2 without");
const writes = [];
const mkdirs = [];
const fakeFs = {
  mkdirSync: (p) => mkdirs.push(p),
  writeFileSync: (p, c) => writes.push({ path: p, content: c }),
};

const candidates = [
  { symbol: "AAA", pool_address: "pool1", base_mint: "mintAAA111", tvl: 50000 },
  { symbol: "BBB", pool_address: "pool2", token_address: "mintBBB222", tvl: 30000 },
  { symbol: "CCC", pool_address: "pool3", base_mint: "mintCCC333", tvl: 25000 },
  { symbol: "DDD", pool_address: "pool4", base_mint: null, tvl: 10000 },
  { symbol: "EEE", pool_address: "pool5", tvl: 5000 }, // no base_mint or token_address field
];

const result = saveToInbox(candidates, { fsImpl: fakeFs });
assert(result.written === 3, `wrote 3 files (got ${result.written})`);
assert(result.skipped === 2, `skipped 2 candidates (got ${result.skipped})`);
assert(writes.length === 3, `fakeFs.writeFileSync called 3 times (got ${writes.length})`);
assert(writes.every((w) => /screener-(aaa|bbb|ccc)/i.test(w.path)),
  "all written filenames correspond to AAA/BBB/CCC");
assert(writes.every((w) => w.content.includes("Token: mint")),
  "all inbox files include resolved Token: line");
assert(!writes.some((w) => /screener-(ddd|eee)/i.test(w.path)),
  "no files written for DDD or EEE (null/missing token)");

// --- Test 2: all valid ---
console.log("\n[2] All candidates valid");
const writes2 = [];
const fakeFs2 = {
  mkdirSync: () => {},
  writeFileSync: (p, c) => writes2.push({ path: p, content: c }),
};
const valid = [
  { symbol: "X1", pool_address: "p1", base_mint: "mintX1" },
  { symbol: "X2", pool_address: "p2", base_mint: "mintX2" },
];
const r2 = saveToInbox(valid, { fsImpl: fakeFs2 });
assert(r2.written === 2, "wrote 2 files");
assert(r2.skipped === 0, "skipped 0");

// --- Test 3: all invalid ---
console.log("\n[3] All candidates invalid (no token)");
const writes3 = [];
const fakeFs3 = {
  mkdirSync: () => {},
  writeFileSync: (p, c) => writes3.push({ path: p, content: c }),
};
const invalid = [
  { symbol: "Z1", pool_address: "p1" },
  { symbol: "Z2", pool_address: "p2", base_mint: "" },
  { symbol: "Z3", pool_address: "p3", base_mint: "   " },
];
const r3 = saveToInbox(invalid, { fsImpl: fakeFs3 });
assert(r3.written === 0, "wrote 0 files");
assert(r3.skipped === 3, "skipped 3 (null, empty, whitespace)");
assert(writes3.length === 0, "no fs writes occurred");

// --- Test 4: empty candidates list ---
console.log("\n[4] Empty candidates list");
const r4 = saveToInbox([], { fsImpl: { mkdirSync: () => {}, writeFileSync: () => {} } });
assert(r4.written === 0, "wrote 0");
assert(r4.skipped === 0, "skipped 0");

// --- summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
