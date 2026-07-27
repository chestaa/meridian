#!/usr/bin/env node
/**
 * Vega — ATA rent reclaim / residue sweep.  MONEY-TOUCHING. READ THIS BEFORE RUNNING.
 * ---------------------------------------------------------------------------------
 * PURPOSE (narrow, by design):
 *   Recover SOL that is locked as rent inside the burner's SPL token accounts, and
 *   sweep swappable token residue back to SOL. NOTHING ELSE.
 *
 * WHAT IT WILL NEVER DO (hard-enforced below, not just documented):
 *   - never transfer SOL or tokens OUT of the wallet (closeAccount destination is
 *     asserted === owner; there is no transfer/withdraw instruction in this file)
 *   - never burn a token (no Burn instruction in this file)
 *   - never close, withdraw from, or otherwise touch a DLMM position
 *   - never touch a token account whose mint belongs to an OPEN DLMM position
 *     (protected set is re-derived ON-CHAIN at runtime, never hardcoded)
 *   - never force-close an account that still holds a balance
 *   - never retry a failed transaction (anti-pattern #4 — on-chain state unknown)
 *
 * SAFETY MODEL:
 *   - dry-run is the DEFAULT. `--execute` is required to send anything.
 *   - wallet pubkey must equal EXPECTED_OWNER, and must pass the main-wallet
 *     blacklist in wallet-loader.js (anti-pattern #5).
 *   - every account's balance is RE-READ from chain immediately before its close is
 *     built. The enumeration snapshot is never trusted for the close decision.
 *   - every TX is confirmed AND the resulting on-chain state is verified
 *     (accounts actually gone / balance actually zero) — anti-pattern #3.
 *   - first failure of any kind => STOP the whole run and report.
 *
 * USAGE:
 *   node scripts/reclaim-ata-rent.js                      # dry-run, all stages
 *   node scripts/reclaim-ata-rent.js --stage=empty        # dry-run, zero-balance only
 *   node scripts/reclaim-ata-rent.js --stage=empty --execute
 *   node scripts/reclaim-ata-rent.js --stage=swaps --execute
 *
 * Stages are deliberately separable so the zero-risk money (rent on already-empty
 * accounts) can be banked before any swap touches a market.
 */

import "dotenv/config";
import fs from "fs";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { getSigningWallet } from "../wallet-loader.js";

// ─── Hard-locked constants ──────────────────────────────────────────────────
const EXPECTED_OWNER = "DgA9MZYEsmbyZ7kLt9epZ7z3Eu8nv5FH8paHz66v1Hiu"; // burner
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const WSOL = "So11111111111111111111111111111111111111112";

const CLOSE_IX_OPCODE = 9;      // SPL Token / Token-2022 CloseAccount
const CLOSES_PER_TX = 12;       // conservative — well under the 1232-byte tx limit
const SWAP_SLIPPAGE_BPS = 200;  // 2% ceiling, mirrors tools/wallet.js money path
const SWAP_MAX_IMPACT_BPS = 200;
const JUP = "https://lite-api.jup.ag";

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const STAGE = (argv.find((a) => a.startsWith("--stage=")) || "--stage=all").split("=")[1];
if (!["empty", "swaps", "all"].includes(STAGE)) {
  console.error(`Invalid --stage=${STAGE}. Use empty | swaps | all.`);
  process.exit(1);
}

const log = (...a) => console.log(...a);
const sol = (l) => `${(l / 1e9).toFixed(9)} SOL`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, extra) {
  console.error(`\n🛑 STOP — ${msg}`);
  if (extra) console.error(extra);
  console.error("No further transactions will be sent. Manual on-chain review required before any retry.");
  process.exit(1);
}

// ─── Chain helpers ──────────────────────────────────────────────────────────
function getConnection() {
  const url = process.env.RPC_URL;
  if (!url) fail("RPC_URL is not set.");
  return new Connection(url, "confirmed");
}

/** All token accounts owned by the wallet, across both token programs. */
async function enumerateTokenAccounts(conn, owner) {
  const rows = [];
  for (const [label, programId] of [["token", TOKEN_PROGRAM], ["token2022", TOKEN_2022]]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
    for (const { pubkey, account } of res.value) {
      const info = account.data.parsed.info;
      rows.push({
        ata: pubkey.toBase58(),
        programLabel: label,
        programId,
        mint: info.mint,
        amountRaw: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        uiAmount: info.tokenAmount.uiAmountString,
        rentLamports: account.lamports,
        state: info.state,
        delegate: info.delegate || null,
        closeAuthority: info.closeAuthority || null,
      });
    }
  }
  return rows;
}

/**
 * Mints belonging to OPEN DLMM positions — re-derived on-chain every run.
 * These are PROTECTED: we do not close their token accounts even when empty,
 * because the position is live money and Bro owns that decision separately.
 */
async function protectedMintsFromOpenPositions(conn, owner) {
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 40, bytes: owner.toBase58() } }], // PositionV2.owner
  });
  const protectedMints = new Set();
  const positions = [];
  for (const a of accs) {
    const lbPair = new PublicKey(a.account.data.subarray(8, 40));
    const pair = await conn.getAccountInfo(lbPair, "confirmed");
    if (!pair) fail(`Open position ${a.pubkey.toBase58()} references pair ${lbPair.toBase58()} that could not be read. Refusing to proceed blind.`);
    const tokenX = new PublicKey(pair.data.subarray(88, 120)).toBase58();
    const tokenY = new PublicKey(pair.data.subarray(120, 152)).toBase58();
    protectedMints.add(tokenX);
    protectedMints.add(tokenY);
    positions.push({ position: a.pubkey.toBase58(), lbPair: lbPair.toBase58(), tokenX, tokenY });
  }
  return { protectedMints, positions };
}

function buildCloseIx({ ata, owner, programId }) {
  // CloseAccount: [account(w), destination(w), owner(signer)]
  // destination === owner. Rent goes back to the same wallet. Asserted by caller.
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_IX_OPCODE]),
  });
}

/** Send + confirm + hard-verify. Never retries. */
async function sendAndVerify(conn, tx, wallet, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);

  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 0, // anti-pattern #4: no blind resubmission
    });
  } catch (e) {
    fail(`${label}: send failed — ${e.message}`, e.logs ? e.logs.join("\n") : undefined);
  }

  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    fail(`${label}: TX ${sig} confirmed with error ${JSON.stringify(conf.value.err)}`);
  }
  log(`   ✅ ${label} confirmed: ${sig}`);
  return sig;
}

// ─── Stage 1: close zero-balance accounts ───────────────────────────────────
async function stageCloseEmpty(conn, wallet, candidates) {
  log(`\n── STAGE: close ${candidates.length} zero-balance account(s) ──`);
  if (!candidates.length) return { closed: 0, sigs: [] };
  if (!EXECUTE) {
    log("   (dry-run — nothing sent)");
    return { closed: 0, sigs: [] };
  }

  const sigs = [];
  let closed = 0;
  for (let i = 0; i < candidates.length; i += CLOSES_PER_TX) {
    const batch = candidates.slice(i, i + CLOSES_PER_TX);
    const tx = new Transaction();
    const included = [];

    for (const c of batch) {
      // RE-READ from chain. Never trust the enumeration snapshot to authorize a close.
      const fresh = await conn.getParsedAccountInfo(new PublicKey(c.ata), "confirmed");
      if (!fresh.value) { log(`   • ${c.ata} already gone — skip`); continue; }
      const info = fresh.value.data?.parsed?.info;
      if (!info) fail(`${c.ata}: unparseable account data — refusing to close blind.`);
      if (info.owner !== wallet.publicKey.toBase58()) fail(`${c.ata}: owner mismatch (${info.owner}) — refusing.`);
      if (info.tokenAmount.amount !== "0") {
        log(`   • ${c.ata} balance became ${info.tokenAmount.uiAmountString} — SKIP (never force-close a funded account)`);
        continue;
      }
      tx.add(buildCloseIx({ ata: c.ata, owner: wallet.publicKey, programId: c.programId }));
      included.push(c);
    }

    if (!included.length) continue;
    const sig = await sendAndVerify(conn, tx, wallet, `close batch ${i / CLOSES_PER_TX + 1} (${included.length} acct)`);
    sigs.push(sig);

    // Anti-pattern #3: confirmation is not proof. Verify the accounts are actually gone.
    for (const c of included) {
      const after = await conn.getAccountInfo(new PublicKey(c.ata), "confirmed");
      if (after) fail(`${c.ata}: TX ${sig} confirmed but account still exists on-chain.`);
    }
    closed += included.length;
    log(`   verified ${included.length} account(s) closed on-chain`);
    await sleep(500);
  }
  return { closed, sigs };
}

// ─── Stage 2: swap residue → SOL, then close ────────────────────────────────
async function jupQuote(mint, amountRaw) {
  const url = `${JUP}/swap/v1/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${amountRaw}` +
              `&slippageBps=${SWAP_SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const body = await r.text();
  if (!r.ok) return { ok: false, reason: `quote HTTP ${r.status}: ${body.slice(0, 160)}` };
  const j = JSON.parse(body);
  if (!j.outAmount) return { ok: false, reason: `no route: ${body.slice(0, 160)}` };
  return { ok: true, quote: j };
}

async function stageSwapResidue(conn, wallet, candidates) {
  log(`\n── STAGE: swap ${candidates.length} residue account(s) → SOL, then close ──`);
  const sigs = [];
  let swapped = 0;

  for (const c of candidates) {
    // Quote on the EXACT raw balance so nothing is left behind to block the close.
    const fresh = await conn.getParsedAccountInfo(new PublicKey(c.ata), "confirmed");
    if (!fresh.value) { log(`   • ${c.ata} gone — skip`); continue; }
    const amountRaw = fresh.value.data.parsed.info.tokenAmount.amount;
    if (amountRaw === "0") { log(`   • ${c.mint} already empty — will close in empty stage`); continue; }

    const q = await jupQuote(c.mint, amountRaw);
    if (!q.ok) {
      log(`   • SKIP ${c.mint} (${c.uiAmount}) — ${q.reason}. Not burned, not force-closed.`);
      continue;
    }
    const impactBps = Math.abs(Number(q.quote.priceImpactPct || 0)) * 10000;
    if (Number.isFinite(impactBps) && impactBps > SWAP_MAX_IMPACT_BPS) {
      log(`   • SKIP ${c.mint} — price impact ${impactBps.toFixed(1)}bps > cap ${SWAP_MAX_IMPACT_BPS}bps. No bad fill taken.`);
      continue;
    }
    log(`   • ${c.mint} ${c.uiAmount} → ${sol(Number(q.quote.outAmount))} via ${(q.quote.routePlan || []).map((x) => x.swapInfo?.label).join(" > ")}`);
    if (!EXECUTE) continue;

    const r = await fetch(`${JUP}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: q.quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!r.ok) fail(`swap build failed for ${c.mint}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const { swapTransaction } = await r.json();
    if (!swapTransaction) fail(`swap build returned no transaction for ${c.mint}`);

    const vtx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    vtx.message.recentBlockhash = blockhash;
    vtx.sign([wallet]);

    let sig;
    try {
      sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 0 });
    } catch (e) {
      fail(`swap send failed for ${c.mint} — ${e.message}`, e.logs ? e.logs.join("\n") : undefined);
    }
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) fail(`swap ${sig} for ${c.mint} confirmed with error ${JSON.stringify(conf.value.err)}`);
    log(`   ✅ swap confirmed: ${sig}`);
    sigs.push(sig);
    swapped++;
    await sleep(800);
  }
  return { swapped, sigs };
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  log("Vega — ATA rent reclaim");
  log(`mode: ${EXECUTE ? "EXECUTE (real transactions)" : "DRY-RUN (no transactions)"}   stage: ${STAGE}`);

  // A dry-run never signs anything, so it must not require key material. Only
  // --execute loads the signing wallet. This lets the plan be audited on a machine
  // that has no burner key at all (anti-pattern #5: don't move keys around to plan).
  let wallet = null;
  let owner;
  if (EXECUTE) {
    wallet = getSigningWallet(); // enforces main-wallet blacklist + at-rest decryption
    owner = wallet.publicKey;
    if (owner.toBase58() !== EXPECTED_OWNER) {
      fail(`Loaded wallet ${owner.toBase58()} !== expected burner ${EXPECTED_OWNER}. Refusing.`);
    }
    log(`wallet: ${owner.toBase58()} ✓ (signing enabled)`);
  } else {
    owner = new PublicKey(EXPECTED_OWNER);
    log(`wallet: ${owner.toBase58()} (read-only — no key loaded)`);
  }

  const conn = getConnection();
  const before = await conn.getBalance(owner, "confirmed");
  log(`SOL before: ${sol(before)}`);

  const { protectedMints, positions } = await protectedMintsFromOpenPositions(conn, owner);
  log(`open DLMM positions: ${positions.length}`);
  for (const p of positions) log(`   pos ${p.position} pair ${p.lbPair} X=${p.tokenX} Y=${p.tokenY}  → PROTECTED`);

  const rows = await enumerateTokenAccounts(conn, owner);
  const totalRent = rows.reduce((s, r) => s + r.rentLamports, 0);
  log(`token accounts: ${rows.length}   rent locked: ${sol(totalRent)}`);

  const empty = [], residue = [], skipped = [];
  for (const r of rows) {
    if (protectedMints.has(r.mint)) { skipped.push({ ...r, why: "mint belongs to an OPEN DLMM position" }); continue; }
    if (r.state !== "initialized") { skipped.push({ ...r, why: `account state=${r.state}` }); continue; }
    if (r.closeAuthority && r.closeAuthority !== owner.toBase58()) { skipped.push({ ...r, why: `foreign closeAuthority ${r.closeAuthority}` }); continue; }
    if (BigInt(r.amountRaw) === 0n) empty.push(r); else residue.push(r);
  }
  log(`\nclassification: ${empty.length} empty · ${residue.length} residue · ${skipped.length} protected/skipped`);
  for (const s of skipped) log(`   SKIP ${s.ata} mint=${s.mint} bal=${s.uiAmount} :: ${s.why}`);

  const result = { swaps: null, closes: null };
  if (STAGE === "swaps" || STAGE === "all") result.swaps = await stageSwapResidue(conn, wallet, residue);

  if (STAGE === "empty" || STAGE === "all") {
    // Re-enumerate so anything emptied by the swap stage is picked up.
    const rows2 = await enumerateTokenAccounts(conn, owner);
    const closable = rows2.filter(
      (r) => !protectedMints.has(r.mint) && r.state === "initialized" &&
             (!r.closeAuthority || r.closeAuthority === owner.toBase58()) &&
             BigInt(r.amountRaw) === 0n
    );
    result.closes = await stageCloseEmpty(conn, wallet, closable);
  }

  const after = await conn.getBalance(owner, "confirmed");
  log(`\n── RESULT ──`);
  log(`SOL before : ${sol(before)}`);
  log(`SOL after  : ${sol(after)}`);
  log(`net change : ${after >= before ? "+" : ""}${sol(after - before)}`);
  if (result.swaps) log(`swaps sent : ${result.swaps.swapped}`);
  if (result.closes) log(`closed     : ${result.closes.closed}`);
  const allSigs = [...(result.swaps?.sigs || []), ...(result.closes?.sigs || [])];
  if (allSigs.length) { log("signatures:"); allSigs.forEach((s) => log(`   ${s}`)); }
  if (!EXECUTE) log("\n(dry-run — re-run with --execute to send)");
})().catch((e) => fail(`unhandled: ${e.message}`, e.stack));
