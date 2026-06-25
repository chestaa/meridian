// scripts/test-btc-order.js — fail-closed assertions for the BTC TSMOM swap
// wrapper. All deps injected (quote/swap/verify) — NO network, NO wallet, NO money.
// Run: node scripts/test-btc-order.js

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }
async function rejects(fn, msg) {
  try { await fn(); fail++; console.error(`  ✗ ${msg} (did NOT throw)`); }
  catch { pass++; }
}

const { placeBtcOrder, confirmAndVerify } = await import("../tsmom/btc-order.js");
const { CBBTC_MINT, USDC_MINT } = await import("../tsmom/btc-guards.js");

const goodQuote = async (i, o, amt) => ({ inAmount: amt, outAmount: amt * 0.999, raw: {} });

// ── DRY_RUN gate: bad value throws even before any network ─────────────────────
await rejects(
  () => placeBtcOrder({ input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100, fetchQuote: goodQuote, dryRunRaw: undefined }),
  "placeBtcOrder throws on ambiguous DRY_RUN"
);
await rejects(
  () => placeBtcOrder({ input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100, fetchQuote: goodQuote, dryRunRaw: "1" }),
  "placeBtcOrder throws on DRY_RUN='1'"
);

// ── unsupported leg refused (fail-closed) ──────────────────────────────────────
await rejects(
  () => placeBtcOrder({ input_mint: USDC_MINT, output_mint: USDC_MINT, amount: 100, fetchQuote: goodQuote, dryRunRaw: "true" }),
  "same-mint leg throws"
);
await rejects(
  () => placeBtcOrder({ input_mint: "SomeRandomMint11111111111111111111111111111", output_mint: CBBTC_MINT, amount: 100, fetchQuote: goodQuote, dryRunRaw: "true" }),
  "unknown input mint throws"
);

// ── bad amount refused ─────────────────────────────────────────────────────────
await rejects(
  () => placeBtcOrder({ input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 0, fetchQuote: goodQuote, dryRunRaw: "true" }),
  "zero amount throws"
);
await rejects(
  () => placeBtcOrder({ input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: -5, fetchQuote: goodQuote, dryRunRaw: "true" }),
  "negative amount throws"
);

// ── DRY-RUN: returns intended order, places NOTHING ────────────────────────────
let placedFlag = false;
const spySwap = async () => { placedFlag = true; return { success: true, tx: "X" }; };
const dry = await placeBtcOrder({
  input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100,
  fetchQuote: goodQuote, deps: { swapToken: spySwap }, dryRunRaw: "true",
});
ok(dry.success && dry.placed === false && dry.dry_run === true, "dry-run: success, placed=false, dry_run=true");
ok(placedFlag === false, "dry-run NEVER calls swapToken (no money path reached)");
ok(dry.intended && dry.intended.amount === 100, "dry-run returns intended order shape");

// ── slippage refusal: oracle expects more than quote offers ────────────────────
const slipRefuse = await placeBtcOrder({
  input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100, expectedOut: 100, // expect 100, quote gives 99.9 => 0.1% ok... use bigger gap
  fetchQuote: async () => ({ inAmount: 100, outAmount: 98, raw: {} }), // 2% worse than expected
  dryRunRaw: "true",
});
ok(!slipRefuse.success && slipRefuse.refused && slipRefuse.reason.includes("slippage"), "2% slippage vs oracle refused (even in dry-run)");

// ── LIVE no-auto-retry: a failed swap halts, never retries ─────────────────────
let swapCalls = 0;
const failSwap = async () => { swapCalls++; return { success: false, error: "blockhash expired" }; };
let liveFail, liveThrew = false;
try {
  liveFail = await placeBtcOrder({
    input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100,
    fetchQuote: goodQuote,
    deps: { swapToken: failSwap, confirmAndVerify: async () => ({ ok: true }) },
    dryRunRaw: "false",
  });
} catch { liveThrew = true; }
// Without a BURNER_WALLET_KEY the burner assertion THROWS before any send — that is
// the correct fail-closed proof that the live money path is unreachable in this env.
ok(liveThrew || (liveFail && liveFail.success === false), "live path fail-closed without burner (throws or returns failure)");
ok(swapCalls === 0, "swap NEVER called when burner assertion fails (no money path reached)");

// ── LIVE no-auto-retry, with an EPHEMERAL in-memory burner (never funded, never
//    persisted, not on blacklist) so the burner gate passes and we exercise the
//    actual send→fail→halt path. swapToken is INJECTED — no real network/money. ──
const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const ephemeral = Keypair.generate();
process.env.BURNER_WALLET_KEY = bs58.encode(ephemeral.secretKey);
process.env.RPC_URL = process.env.RPC_URL || "http://localhost:1"; // never actually hit (swap injected)

let retrySwapCalls = 0;
const failOnceSwap = async () => { retrySwapCalls++; return { success: false, error: "blockhash expired" }; };
const liveHalt = await placeBtcOrder({
  input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100,
  fetchQuote: goodQuote,
  deps: { swapToken: failOnceSwap, confirmAndVerify: async () => ({ ok: true }) },
  dryRunRaw: "false",
});
ok(retrySwapCalls === 1, "live swap FAILURE: swapToken called EXACTLY once (NEVER auto-retried)");
ok(!liveHalt.success && liveHalt.halted === true, "live swap failure => halted, not retried");

// Live SUCCESS but verify MISMATCH => halt, no retry, marked sent_unverified.
let okSwapCalls = 0;
const okSwap = async () => { okSwapCalls++; return { success: true, tx: "SIG123", amount_out: "100000000" }; };
const liveMismatch = await placeBtcOrder({
  input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100,
  fetchQuote: goodQuote,
  deps: { swapToken: okSwap, confirmAndVerify: async () => ({ ok: false, reason: "realized_slippage_too_high" }) },
  dryRunRaw: "false",
});
ok(okSwapCalls === 1, "verify-mismatch path: swap called once, no retry");
ok(!liveMismatch.success && liveMismatch.placed === "sent_unverified" && liveMismatch.halted, "verify mismatch => sent_unverified + halt");

// Live SUCCESS + verify OK => placed:true with signature.
const liveOk = await placeBtcOrder({
  input_mint: USDC_MINT, output_mint: CBBTC_MINT, amount: 100,
  fetchQuote: goodQuote,
  deps: { swapToken: async () => ({ success: true, tx: "SIGOK", amount_out: "99800000" }), confirmAndVerify: async () => ({ ok: true, realizedOut: 0.001, slippageRealized: 0.002 }) },
  dryRunRaw: "false",
});
ok(liveOk.success && liveOk.placed === true && liveOk.signature === "SIGOK", "live success+verify => placed:true with signature");

delete process.env.BURNER_WALLET_KEY;

// ── confirmAndVerify: fail-closed when no reported out ─────────────────────────
const noOut = await confirmAndVerify({
  signature: "sig", output_mint: CBBTC_MINT, expectedOut: 1, reportedOut: null,
  conn: { confirmTransaction: async () => ({ value: { err: null } }) },
});
ok(!noOut.ok && noOut.reason === "no_reported_out_fail_closed", "verify: missing reported out => fail-closed");

// ── confirmAndVerify: confirm error throws (no silent success) ─────────────────
await rejects(
  () => confirmAndVerify({
    signature: "sig", output_mint: CBBTC_MINT, expectedOut: 1, reportedOut: 1,
    conn: { confirmTransaction: async () => ({ value: { err: { InstructionError: [0, "x"] } } }) },
  }),
  "verify throws on confirmTransaction err"
);

// ── confirmAndVerify: realized slippage beyond cap => not ok ───────────────────
const slipBad = await confirmAndVerify({
  signature: "sig", output_mint: CBBTC_MINT, expectedOut: 100, reportedOut: 97, // 3% short
  conn: { confirmTransaction: async () => ({ value: { err: null } }) },
});
ok(!slipBad.ok && slipBad.reason.includes("slippage"), "verify: realized 3% slippage => mismatch (not ok)");

// ── confirmAndVerify: within cap => ok ─────────────────────────────────────────
const slipGood = await confirmAndVerify({
  signature: "sig", output_mint: CBBTC_MINT, expectedOut: 100, reportedOut: 99.8, // 0.2% ok
  conn: { confirmTransaction: async () => ({ value: { err: null } }) },
});
ok(slipGood.ok && slipGood.realizedOut === 99.8, "verify: 0.2% realized slippage => ok");

console.log(`\nbtc-order: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
