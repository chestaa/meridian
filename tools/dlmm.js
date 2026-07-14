import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { recordRealizedLoss } from "../account-circuit-breaker.js";
import { computeLiveRealizedSolDelta, sumCloseGasSolFromFees } from "../realized-sol.js";
import { getSigningWallet } from "../wallet-loader.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { isBluechipMintPair } from "./screening.js";

// ── Bluechip income-engine hard-locked belt (Vega — Opsi B) ──
// Hardcoded ceiling on per-position bluechip SOL, INDEPENDENT of memecoin
// maxDeployAmount. config.risk.maxBluechipPositionSol may TIGHTEN below this but
// can NEVER exceed it — the deploy path takes Math.min(belt, config). Mirrors the
// MAX_LIVE_POSITION_SOL hard-lock pattern: a real-money invariant lives in code,
// not just in a tunable file. Raising it is an explicit Bro decision (anti-pattern
// #7: never let a tunable/LLM path size above a hardcoded cap).
const MAX_BLUECHIP_POSITION_SOL = 0.45;

// ── Phase-1 live per-position hard cap (Vega — go-live 2026-06-28) ──
// Hardcoded ceiling on per-position SOL for the MEMECOIN live path, INDEPENDENT
// of the tunable config.risk.maxDeployAmount (which lives in user-config.json and
// can be mis-set). config may TIGHTEN below this but can NEVER exceed it — the
// deploy path takes Math.min(belt, config). Anti-pattern #7: a tunable/LLM-driven
// size can never breach a code-pinned cap. Raising it is an explicit Bro decision.
// Raised 0.05 -> 0.5 on Bro's EXPLICIT decision (2026-06-28). NOTE: this is the
// per-position CEILING, not the achievable size — gasReserve + live balance bound
// the actual deploy below it (burner ~0.612 SOL, gasReserve 0.2 → max ~0.412/pos,
// so a single position is ~the whole burner; maxPositions MUST be 1 at this size).
// Mirrors MAX_BLUECHIP_POSITION_SOL pattern. Lives in code, not JSON.
export const MAX_LIVE_POSITION_SOL = 0.5;

// Wrapped-SOL mint — the ONLY mint a single-side SOL deploy may deposit into.
const WSOL_MINT = "So11111111111111111111111111111111111111112";
import { normalizeMint, resolveSwapMaxSlippageBps } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

let _connection = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  return getSigningWallet();
}

// ─── Vega close-formula accuracy fix (2026-07-11, Draco on-chain reconcile) ────
// Measure ACTUAL close gas from the confirmed close-tx fees, so the realized-SOL
// formula subtracts real gas rather than the conservative flat DEFAULT_CLOSE_GAS_SOL.
// The wallet is the fee-payer on the direct close path (sendAndConfirmTransaction
// with [wallet]), so getTransaction(sig).meta.fee IS this wallet's gas cost.
//
// FAIL-SAFE (anti-pattern #2/#3): read-only, runs AFTER the close is confirmed and
// state is already recorded — it can NEVER affect the close TX itself. If ANY leg
// is unreadable (RPC hiccup, sig not yet indexed) it returns null and the formula
// falls back to the conservative flat estimate — we never under-count gas (which
// would flatter the loss). Never throws into the accounting path.
async function measureCloseGasSol(signatures) {
  try {
    const sigs = (Array.isArray(signatures) ? signatures : [])
      .filter((s) => typeof s === "string" && s.length > 0);
    if (sigs.length === 0) return null;
    const conn = getConnection();
    const feeLamports = [];
    for (const sig of sigs) {
      const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const fee = tx?.meta?.fee;
      // Any missing leg → bail to null so we fall back to the conservative flat
      // estimate rather than book a partial (under-counted) gas figure.
      // Explicit null/undefined guard FIRST: Number(null)===0 is finite and would
      // slip an unreadable fee through as 0 gas (under-count → flatter loss).
      if (fee == null || !Number.isFinite(Number(fee))) return null;
      feeLamports.push(Number(fee));
    }
    return sumCloseGasSolFromFees(feeLamports);
  } catch (_e) {
    return null; // never let accounting-gas measurement escalate
  }
}

// ─── Test seam (production-inert) ──────────────────────────────
// ESM exports are immutable bindings, so tests cannot monkey-patch
// getPool / sendAndConfirmTransaction directly. These overridable hooks
// default to the real implementations and are ONLY populated by
// __setForTests. They are never touched in production (Vega Item 2B
// partial-TP path validation — see scripts/validate-partial-tp.js).
const _testHooks = {
  getPool: null,
  getWallet: null,
  getMyPositions: null,
  sendAndConfirmTransaction: null,
  lookupPoolForPosition: null,
};

export function __setForTests(overrides = {}) {
  for (const key of Object.keys(_testHooks)) {
    if (key in overrides) _testHooks[key] = overrides[key];
  }
}

export function __resetTests() {
  for (const key of Object.keys(_testHooks)) _testHooks[key] = null;
}

// ─── Vega Item 9 — Rebalance-on-OOR friction estimate (PURE, no TX) ──────────
// A re-center = remove 100% liquidity (1 tx) + re-deploy (1 tx) + the auto-swap
// of base→SOL that close_position performs (1 tx). Each tx burns priority/base
// fees, and the swap eats slippage. If accumulated fees earned < this friction,
// re-centering churns the wallet for a net loss — we must NOT do it. This is a
// conservative SOL-denominated estimate; callers compare it to fees actually
// claimed before deciding to re-center vs hard close.
//
// Components (deliberately pessimistic — over-estimating friction biases toward
// the safer "don't churn" outcome):
//   - gasPerTx: base + priority fee per Solana tx (default 0.00015 SOL)
//   - txCount: remove + deploy + swap = 3
//   - swapSlippage: fraction of the re-deployed capital lost crossing the AMM
//     on the base→SOL auto-swap (default 1% of amountSol)
// Returns a positive SOL number. Never throws — clamps bad input to a safe
// non-zero floor so a NaN can never read as "free to rebalance".
export function estimateRebalanceFrictionSol({
  amountSol,
  gasPerTxSol = 0.00015,
  txCount = 3,
  swapSlippagePct = 1,
} = {}) {
  const amt = Number(amountSol);
  const gas = Number(gasPerTxSol);
  const txs = Number(txCount);
  const slipPct = Number(swapSlippagePct);

  const safeGas = Number.isFinite(gas) && gas >= 0 ? gas : 0.00015;
  const safeTxs = Number.isFinite(txs) && txs > 0 ? txs : 3;
  const gasFriction = safeGas * safeTxs;

  const safeAmt = Number.isFinite(amt) && amt > 0 ? amt : 0;
  const safeSlip = Number.isFinite(slipPct) && slipPct >= 0 ? slipPct : 1;
  const slipFriction = safeAmt * (safeSlip / 100);

  // Floor at gas-only friction so the guard is never satisfied "for free".
  const friction = gasFriction + slipFriction;
  return Number(friction.toFixed(9));
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = indexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

const poolCacheGc = setInterval(() => poolCache.clear(), 5 * 60 * 1000);
const poolMetadataCacheGc = setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);
poolCacheGc.unref?.();
poolMetadataCacheGc.unref?.();

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Item (b) — Volume-regime strategy picker (PURE) ───────────
// Chooses the LP strategy from live pool metrics when no explicit strategy
// is supplied and the regime feature is enabled (caller-gated).
//
//   HIGH volume (>= volumeRegimeHighThreshold) → "spot"   (tight fee capture)
//   LOW  volume                                → "bid_ask" (catch volatility)
//
// CRITICAL volatility guard (Andromeda risk): a high-volatility pool is NEVER
// assigned spot — spot on a volatile pool goes out-of-range instantly and
// realizes IL. If volatility > volumeRegimeMaxVolForSpot → force bid_ask
// regardless of volume.
//
// FAIL-SAFE: volume null/0/non-finite → return the configured default
// (cfg.strategy) — no silent flip. Returns a strategy string.
export function pickRegimeStrategy(volume_window, volatility, cfg) {
  const fallback = cfg?.strategy ?? "bid_ask";
  const vol = Number(volume_window);
  // Bad/missing volume → fail-safe to configured default (no silent flip).
  if (!Number.isFinite(vol) || vol <= 0) return fallback;

  const highThreshold = Number.isFinite(Number(cfg?.volumeRegimeHighThreshold))
    ? Number(cfg.volumeRegimeHighThreshold)
    : 50000;
  const maxVolForSpot = Number.isFinite(Number(cfg?.volumeRegimeMaxVolForSpot))
    ? Number(cfg.volumeRegimeMaxVolForSpot)
    : 3;

  const isHighVolume = vol >= highThreshold;
  if (!isHighVolume) return "bid_ask";

  // High volume → candidate for spot, but apply the volatility guard.
  const parsedVolatility = Number(volatility);
  // If volatility is high (and known), NEVER spot — force bid_ask.
  if (Number.isFinite(parsedVolatility) && parsedVolatility > maxVolForSpot) {
    return "bid_ask";
  }
  return "spot";
}

// ─── Item 1 — Fast bid-ask "bonus stage" override (PURE) ───────
// Intel (@bengsharksol, 83% WR claim): in a FRESH/early-stage pool the price
// tends to pump hard ("bonus stage"); an edge-weighted bid_ask sits ready at
// the range edges to capture that one-directional burst, whereas a tight
// `spot` position would be left behind instantly.
//
// HONEST SCOPE: the Meteora SDK exposes only Spot | Curve | BidAsk and no
// per-bin custom weight — StrategyType.BidAsk *already is* the edge-weighted
// distribution. So this is NOT a new shape; it is a TIMING override that only
// matters when the regime picker would otherwise have returned `spot`. We layer
// it AFTER pickRegimeStrategy so it never widens behavior beyond "fresh+volatile
// → prefer bid_ask".
//
// Returns true only when ALL hold (FAIL-SAFE — anti-pattern #2 — any missing /
// non-finite / non-qualifying metric → false → defer to the regime pick):
//   - feature flag on (cfg.fastBidAskBonusEnabled)
//   - token_age_hours is a finite number > 0 AND <= fastBidAskMaxAgeHours
//   - volatility is a finite number >= fastBidAskMinVolatility
// NEVER a gate, NEVER changes amount/bins/caps — strategy-shape only.
export function isFastBidAskBonus(token_age_hours, volatility, cfg) {
  if (!cfg?.fastBidAskBonusEnabled) return false;

  const age = Number(token_age_hours);
  if (!Number.isFinite(age) || age <= 0) return false; // missing/unknown age → no override

  const vol = Number(volatility);
  if (!Number.isFinite(vol) || vol <= 0) return false; // missing/unusable volatility → no override

  const maxAge = Number.isFinite(Number(cfg?.fastBidAskMaxAgeHours))
    ? Number(cfg.fastBidAskMaxAgeHours)
    : 24;
  const minVol = Number.isFinite(Number(cfg?.fastBidAskMinVolatility))
    ? Number(cfg.fastBidAskMinVolatility)
    : 3;

  return age <= maxAge && vol >= minVol;
}

// ─── Deploy Position ───────────────────────────────────────────
/**
 * Vega — entry_features builder (data-collection mode, 2026-07-10). PURE, exported
 * for unit tests. Assembles the raw context snapshot persisted on the position at
 * deploy, consumed later by direction-gating (#2). Every input is ALREADY known
 * this cycle (screening enrichment + market-regime read) — this adds NO API call.
 *
 * FAIL-SAFE (anti-pattern #2): each field is a finite number or null — NEVER
 * fabricated. buy_sell_flow_ratio = buy/(buy+sell) in [0,1] when both flow legs are
 * finite AND total>0; otherwise null (missing/zero flow is unknown, not "balanced").
 */
export function buildEntryFeatures({
  sol_regime_24h_pct,
  token_price_change_1h,
  token_price_change_24h,
  buy_vol,
  sell_vol,
  mcap,
} = {}) {
  // STRICT numeric coercion (anti-pattern #2). The naive `Number.isFinite(Number(v))`
  // pattern FABRICATES 0 for genuinely-missing inputs because `Number(null)===0`,
  // `Number('')===0`, `Number(false)===0` are all finite. That is exactly how the
  // 42-record entry_features dataset was poisoned with flat zeros. Mirror
  // screening.js `strictNumeric` / classifyRegime discipline: only a real finite
  // number (or a non-empty numeric string) survives — null/undefined/''/boolean/
  // object → null (honest gap), NEVER 0.
  const num = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const buy = num(buy_vol);
  const sell = num(sell_vol);
  let buy_sell_flow_ratio = null;
  if (buy != null && sell != null) {
    const total = buy + sell;
    if (total > 0) buy_sell_flow_ratio = parseFloat((buy / total).toFixed(4));
  }
  return {
    sol_regime_24h_pct: num(sol_regime_24h_pct),
    token_price_change_1h: num(token_price_change_1h),
    token_price_change_24h: num(token_price_change_24h),
    buy_sell_flow_ratio,
    mcap: num(mcap),
  };
}

export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  volume_window, // optional: live volume metric for regime strategy pick (item b)
  token_age_hours, // optional: pool/token age for fast bid-ask bonus override (item 1)
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // Vega — entry_features raw inputs (data-collection mode). Threaded from the
  // in-cycle screening enrichment + market-regime read; NO new API call is made
  // here. Any absent input → null on the persisted feature (fail-safe, never
  // fabricated). Assembled by buildEntryFeatures → persisted by trackPosition.
  sol_regime_24h_pct,
  token_price_change_1h,
  token_price_change_24h,
  buy_vol,
  sell_vol,
  mcap,
}) {
  pool_address = normalizeMint(pool_address);
  // Vega — assemble the entry_features snapshot once (fail-safe; null where absent).
  // Persisted by both trackPosition call sites below (relay + standard deploy paths).
  const entryFeatures = buildEntryFeatures({
    sol_regime_24h_pct,
    token_price_change_1h,
    token_price_change_24h,
    buy_vol,
    sell_vol,
    mcap,
  });
  // Strategy resolution priority:
  //   1. explicit `strategy` (LLM/manual override) — always wins
  //   2. volume-regime pick — only when enabled AND no explicit strategy
  //   3. config.strategy.strategy — legacy default / fail-safe
  //   then: fast bid-ask bonus override (item 1) — fresh+volatile forces
  //   bid_ask, but ONLY when no explicit strategy was passed (override-wins
  //   for the LLM/manual case is preserved) and the flag is on.
  let activeStrategy;
  if (strategy) {
    activeStrategy = strategy; // explicit override wins — fast-BA never touches it
  } else {
    if (config.strategy.volumeRegimeEnabled) {
      activeStrategy = pickRegimeStrategy(volume_window, volatility, config.strategy);
    } else {
      activeStrategy = config.strategy.strategy; // legacy
    }
    // Item 1 — fast bid-ask "bonus stage": fresh + volatile → force bid_ask.
    // No-op unless it actually changes the pick (typically when regime chose
    // spot). FAIL-SAFE inside isFastBidAskBonus: missing age/volatility → false.
    if (isFastBidAskBonus(token_age_hours, volatility, config.strategy)) {
      if (activeStrategy !== "bid_ask") {
        log(
          "deploy",
          `Fast bid-ask bonus: fresh(${token_age_hours}h)+volatile(${volatility}) overriding ${activeStrategy} -> bid_ask`,
        );
      }
      activeStrategy = "bid_ask";
    }
  }
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await (_testHooks.getPool || getPool)(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  const quoteMint = pool.lbPair.tokenYMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }

  // ── Bluechip income-engine mode (Vega — Opsi B, money-path) ──
  // Dual-mode: when bluechipModeEnabled is ON, bluechip pools (both legs whitelisted)
  // get the income-engine PRIVILEGES (wide bins, vol-floor exemption, separate cap),
  // while non-bluechip pools STAY on the memecoin path (strict bins, memecoin cap).
  // Resolve from the LIVE on-chain pool mints (not LLM-supplied metadata) so the guard
  // can NEVER be fooled by a mislabelled candidate. bluechipModeEnabled default OFF →
  // isBluechipDeploy is always false → the memecoin path below is byte-for-byte unchanged.
  const bluechipModeEnabled = config.screening?.bluechipModeEnabled === true;
  const isBluechipDeploy = bluechipModeEnabled && isBluechipMintPair(baseMint, quoteMint);
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }

  // ── Bluechip per-position SOL cap (Vega — Opsi B, money-path belt) ──
  // ONLY a bluechip deploy is subject to this cap (memecoin keeps maxDeployAmount,
  // unchanged). Effective cap = min(hardcoded belt, config tunable) — config can
  // tighten BELOW the hardcoded MAX_BLUECHIP_POSITION_SOL but can NEVER exceed it
  // (anti-pattern #7: a tunable/LLM-driven size can never breach the code-pinned cap).
  if (isBluechipDeploy) {
    const bluechipCap = Math.min(
      MAX_BLUECHIP_POSITION_SOL,
      Number(config.risk?.maxBluechipPositionSol ?? MAX_BLUECHIP_POSITION_SOL),
    );
    if (finalAmountY > bluechipCap) {
      throw new Error(
        `Invalid deploy amount: bluechip position ${finalAmountY} SOL exceeds the bluechip cap ${bluechipCap} SOL (hard belt ${MAX_BLUECHIP_POSITION_SOL}).`,
      );
    }
  }
  // ── Phase-1 memecoin per-position HARD CAP (Vega — go-live, NON-bluechip path) ──
  // The bluechip lane has its own belt above; this is the memecoin/general live belt.
  // Effective cap = min(code-pinned MAX_LIVE_POSITION_SOL, config maxDeployAmount).
  // DRY_RUN paper deploys are exempt (no real SOL moves) so the dry-run soak can size
  // freely; the cap binds only when real TX will be sent. anti-pattern #7.
  if (!isBluechipDeploy && process.env.DRY_RUN !== "true") {
    const liveCap = Math.min(
      MAX_LIVE_POSITION_SOL,
      Number(config.risk?.maxDeployAmount ?? MAX_LIVE_POSITION_SOL),
    );
    if (finalAmountY > liveCap) {
      throw new Error(
        `Invalid deploy amount: live position ${finalAmountY} SOL exceeds the Phase-1 per-position cap ${liveCap} SOL (hard belt ${MAX_LIVE_POSITION_SOL}).`,
      );
    }
  }

  // ── wSOL-leg chain-side assertion (Vega — closes the CLAUDE.md TODO) ──
  // This agent deploys single-side SOL into the Y leg (totalYAmount = finalAmountY).
  // That is ONLY correct when tokenY IS wSOL. quoteMint is read from the LIVE
  // on-chain pool (pool.lbPair.tokenYMint), so a mislabelled candidate cannot fool
  // it. The screener guards this pre-deploy, but this is the authoritative money-path
  // belt: a single-side SOL deposit into a non-wSOL Y leg is REFUSED before any TX.
  // FAIL-CLOSED: a missing/unreadable quoteMint also refuses (anti-pattern #2).
  // DRY_RUN exempt (no real deposit) so paper soak on any pool shape still runs.
  if (process.env.DRY_RUN !== "true" && finalAmountY > 0) {
    if (!quoteMint || quoteMint !== WSOL_MINT) {
      throw new Error(
        `Refusing single-side SOL deploy: pool tokenY (quote) mint is ${quoteMint || "unknown"}, not wSOL (${WSOL_MINT}). SOL can only be deposited when wSOL is the Y leg.`,
      );
    }
  }

  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  // ── Bins-below CEILING (Vega — Opsi B whitelist privilege gate) ──
  // ONLY enforced when bluechipModeEnabled is ON, so the memecoin path stays
  // byte-for-byte unchanged when the master flag is OFF (no new ceiling exists).
  // With the flag ON:
  //   - BLUECHIP (whitelist) pools may go WIDE up to bluechipMaxBinsBelow (the income
  //     engine's broad passive range). This is the privilege the whitelist unlocks.
  //   - Everything else (non-whitelist pair) is clamped to the memecoin maxBinsBelow.
  // This IS the whitelist enforcement: a non-bluechip pair simply CANNOT obtain a
  // wide range while the engine is in bluechip mode → REFUSE. bins_above stays 0
  // (Opsi B single-side SOL — amount_x is guarded separately above).
  if (bluechipModeEnabled) {
    const memecoinMaxBinsBelow = Math.max(
      minBinsBelow,
      Number(config.strategy.maxBinsBelow ?? minBinsBelow),
    );
    const bluechipCeil = Math.max(
      memecoinMaxBinsBelow,
      Math.round(Number(config.strategy.bluechipMaxBinsBelow ?? memecoinMaxBinsBelow)),
    );
    const binsCeiling = isBluechipDeploy ? bluechipCeil : memecoinMaxBinsBelow;
    if (activeBinsBelow > binsCeiling) {
      throw new Error(
        isBluechipDeploy
          ? `Invalid deploy range: bins_below ${activeBinsBelow} exceeds bluechip ceiling ${binsCeiling}.`
          : `Invalid deploy range: bins_below ${activeBinsBelow} exceeds memecoin ceiling ${binsCeiling}. Wide range is bluechip-whitelist only (pool legs not both whitelisted).`,
      );
    }
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          entry_features: entryFeatures,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      entry_features: entryFeatures,
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Live velocity stats (Vega Item 6 wiring) ──────────────────
// The velocity-drop exit (state.js#updatePnlAndCheckExits) reads
// price_change_1h_pct + net_buyers_1h off the position object. Paper trades
// get these from token enrichment (token.js stats1h). Live positions previously
// LACKED them, so the velocity exit could NEVER fire live (VEGA VETO). This
// fetches the SAME Jupiter source paper uses, keyed by base mint, with a short
// TTL cache so the management cron doesn't hammer the API.
const _velocityStatsCache = new Map(); // mint → { at, value }
const VELOCITY_STATS_TTL = 60_000; // 1 min — fresh enough for a 1h-window signal

export async function fetchVelocityStatsForMint(baseMint) {
  if (!baseMint) return { price_change_1h_pct: null, net_buyers_1h: null };
  const key = String(baseMint);
  const cached = _velocityStatsCache.get(key);
  if (cached && Date.now() - cached.at < VELOCITY_STATS_TTL) return cached.value;

  const empty = { price_change_1h_pct: null, net_buyers_1h: null };
  try {
    const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(key)}`);
    if (!res.ok) {
      log("velocity_stats", `HTTP ${res.status} for mint ${key.slice(0, 8)}`);
      _velocityStatsCache.set(key, { at: Date.now(), value: empty });
      return empty;
    }
    const data = await res.json();
    const tokens = Array.isArray(data) ? data : [data];
    // Prefer an exact mint match; fall back to the first result.
    const t = tokens.find((x) => x?.id === key) || tokens[0];
    const s = t?.stats1h;
    const value = {
      price_change_1h_pct: s?.priceChange != null && Number.isFinite(Number(s.priceChange)) ? Number(s.priceChange) : null,
      net_buyers_1h: s?.numNetBuyers != null && Number.isFinite(Number(s.numNetBuyers)) ? Number(s.numNetBuyers) : null,
    };
    _velocityStatsCache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    log("velocity_stats", `Fetch error for mint ${key.slice(0, 8)}: ${e.message}`);
    _velocityStatsCache.set(key, { at: Date.now(), value: empty });
    return empty;
  }
}

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  if (shouldUseLpAgentRelay()) {
    try {
      const payload = await fetchOpenPositionsFromMeridian({
        walletAddress,
        agentId: getAgentIdForRequests(),
      });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
          request_id: payload?.requestId || null,
        };
      }
      log("pnl_warn", "Relay positions API did not include requested position; falling back to Meteora PnL path");
    } catch (error) {
      log("pnl_warn", `Relay PnL lookup failed; falling back to Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    return {
      pnl_usd:           Math.round((p.pnlUsd ?? 0) * 100) / 100,
      pnl_pct:           Math.round((p.pnlPctChange ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      all_time_fees_usd: Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100,
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRelayPosition(position) {
  if (!position || typeof position !== "object") return position;
  if (!config.management.solMode) return position;

  const totalValueNative = position.total_value_native ?? position.total_value_usd;
  const unclaimedFeesNative = position.unclaimed_fees_native ?? position.unclaimed_fees_usd;
  const collectedFeesNative = position.collected_fees_native ?? position.collected_fees_usd;
  const pnlNative = position.pnl_native ?? position.pnl_usd;
  const derivedPnlPct = position.pnl_pct_derived_native ?? position.pnl_pct_derived;

  return {
    ...position,
    total_value_usd: totalValueNative,
    unclaimed_fees_usd: unclaimedFeesNative,
    collected_fees_usd: collectedFeesNative,
    pnl_usd: pnlNative,
    pnl_pct_derived: derivedPnlPct,
  };
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await agentMeridianJson(`/positions/open?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 10_000,
    },
  });
  return {
    ...payload,
    positions: Array.isArray(payload?.positions)
      ? payload.positions.map((position) => normalizeRelayPosition(position))
      : [],
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    if (shouldUseLpAgentRelay()) {
      try {
        if (!silent) log("positions", "Fetching open positions via Agent Meridian relay...");
        const result = await fetchOpenPositionsFromMeridian({
          walletAddress,
          agentId: getAgentIdForRequests(),
        });
        const normalizedPositions = Array.isArray(result.positions) ? result.positions : [];
        syncOpenPositions(normalizedPositions.map((p) => p.position));
        _positionsCache = {
          wallet: walletAddress,
          total_positions: Number(result.total_positions || 0),
          positions: normalizedPositions,
          request_id: result.requestId || null,
        };
        _positionsCacheAt = Date.now();
        return _positionsCache;
      } catch (error) {
        log("positions_warn", `Agent Meridian relay failed; falling back to Meteora/local positions path: ${error.message}`);
      }
    }

    // Portfolio API discovers open pools/positions for this wallet.
    // Detailed range data stays on Meteora PnL API; value/PnL can be overridden by LPAgent below.
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = await fetchLpAgentOpenPositions(walletAddress);

    // Vega Item 6 — fetch 1h velocity stats per base mint (parallel, cached) so
    // the live position object carries price_change_1h_pct + net_buyers_1h. The
    // velocity-drop exit reads these; without them it can never fire live.
    const velocityByMint = {};
    if (config.management.velocityExitEnabled !== false) {
      const uniqueMints = [...new Set(pools.map((pool) => pool.tokenXMint).filter(Boolean))];
      const velStats = await Promise.all(uniqueMints.map((mint) => fetchVelocityStatsForMint(mint)));
      uniqueMints.forEach((mint, i) => { velocityByMint[mint] = velStats[i]; });
    }

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        const pnlPctSuspicious = pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
        if (pnlPctSuspicious) {
          log("positions_warn", `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)}`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          // Vega fix #1 — fee-inclusive exit metric (LIVE). derivedPnlPct is
          // (currentValue + unclaimedFees + withdrawals + allTimeFees − deposit)
          // / deposit — i.e. the TRUE net economic position with REAL IL already
          // embedded in currentValue (NOT naive 0% like paper). state.js prefers
          // this over the SDK-reported price-only pnl_pct for exit decisions,
          // with fallback to pnl_pct when derived is unavailable. Suspicious
          // ticks (reported vs derived diverge) still short-circuit via
          // pnl_pct_suspicious upstream.
          pnl_pct_fee_inclusive: derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
          // Entry deploy size in SOL (from tracked deploy record). Used by the
          // /positions trade-card to show "Entry: $X (Y SOL)" honestly. null if
          // the deploy was never tracked (e.g. discovered-only position).
          amount_sol:         tracked?.amount_sol ?? null,
          // Vega Item 6 — 1h velocity signal (same Jupiter source as paper).
          // null when stats unavailable → velocity exit safely no-ops.
          price_change_1h_pct: velocityByMint[pool.tokenXMint]?.price_change_1h_pct ?? null,
          net_buyers_1h:       velocityByMint[pool.tokenXMint]?.net_buyers_1h ?? null,
        });
      }
    }

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    syncOpenPositions(positions.map(p => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          // Vega money-path hardening (2026-07-12): was a hard 5000 (50%) — a
          // real leak vector if this dormant relay path were ever enabled. Now
          // capped to the same config ceiling as the active swap (default 200 =
          // 2%, hard-clamped ≤500). DORMANT (lpAgentRelayEnabled=false) so no
          // behavior change today — this just defuses the bomb.
          slippageBps: resolveSwapMaxSlippageBps(),
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        // Vega fix #1 — SOL figures for realized_sol_delta formula fallback.
        let withdrawnSol = null;
        let feesSol = null;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlUsd = parseFloat(posEntry.pnlUsd || 0);
                pnlPct = parseFloat(posEntry.pnlPctChange || 0);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                // Vega honesty fix #1 (2026-06-23): present-but-zero SOL on a
                // settling record → UNKNOWN (null) when USD contradicts a wipe,
                // so the formula returns null (honest gap), not a fabricated -1×.
                const rawWithdrawnSol = posEntry.allTimeWithdrawals?.total?.sol != null
                  ? parseFloat(posEntry.allTimeWithdrawals.total.sol) : null;
                const usdNotWiped = (Number.isFinite(finalValueUsd) && finalValueUsd > 0)
                  || (Number.isFinite(pnlPct) && pnlPct > -90);
                const nextWithdrawnSol = (rawWithdrawnSol === 0 && usdNotWiped)
                  ? null
                  : rawWithdrawnSol;
                const nextFeesSol = posEntry.allTimeFees?.total?.sol != null
                  ? parseFloat(posEntry.allTimeFees.total.sol) : null;
                withdrawnSol = Number.isFinite(nextWithdrawnSol) ? nextWithdrawnSol : withdrawnSol;
                feesSol = Number.isFinite(nextFeesSol) ? nextFeesSol : feesSol;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        // Vega fix #1 — formula-based realized SOL delta (relay close path).
        // NOTE: measured-gas (Item 1) is deliberately NOT applied here — the relay
        // (Agent Meridian zap-out) execution model does not guarantee THIS wallet is
        // the fee-payer, so a getTransaction fee would not cleanly equal wallet gas.
        // The conservative flat DEFAULT_CLOSE_GAS_SOL is kept for the relay path
        // (loss-overstating, never flattering). Draco's reconcile is the direct path.
        const relayCloseRsd = config.internalAgents?.realizedSolAccounting !== false
          ? computeLiveRealizedSolDelta({
              solDeployed: tracked.amount_sol ?? null,
              solReceivedOnClose: Number.isFinite(withdrawnSol) ? withdrawnSol : null,
              feesClaimedSol: Number.isFinite(feesSol) ? feesSol : null,
              finalValueUsd,
              pnlPct,
            })
          : null;

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: livePosition?.base_mint || null,
          peak_pnl_pct: tracked.peak_pnl_pct,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          fees_earned_sol: Number.isFinite(feesSol) ? feesSol : undefined,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          apiPnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
          apiPnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          // Vega Item 2 (2026-07-11) — canonical entry_features forward (relay path).
          // Same owner-side defense-in-depth as the direct path. Additive; null gap
          // when unknown, never fabricated.
          entry_features: tracked.entry_features ?? null,
          realized_sol_delta: relayCloseRsd?.realized_sol_delta ?? null,
          realized_sol_delta_pct: relayCloseRsd?.realized_sol_delta_pct ?? null,
          realized_sol_method: relayCloseRsd?.method ?? null,
          realized_sol_estimate: relayCloseRsd?.estimate ?? null,
        });

        await recordRealizedLoss({
          pnl_pct: pnlPct,
          amount_sol: tracked.amount_sol,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          reason: reason || "agent decision",
        }).catch((e) => log("circuit_warn", `recordRealizedLoss failed (relay close): ${e.message}`));

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: livePosition?.base_mint || null,
          // Vega fix #1 — SOL figures for realized_sol_delta formula fallback.
          sol_deployed: tracked.amount_sol ?? null,
          sol_received: Number.isFinite(withdrawnSol) ? withdrawnSol : null,
          fees_claimed_sol: Number.isFinite(feesSol) ? feesSol : null,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      // Vega fix #1 — SOL-denominated figures for realized_sol_delta formula
      // fallback (used only when the executor wallet-delta snapshot is missing).
      let withdrawnSol = null;
      let feesSol = null;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = parseFloat(posEntry.pnlUsd || 0);
              const nextPnlPct = parseFloat(posEntry.pnlPctChange || 0);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              // Vega honesty fix #1 (2026-06-23): a PRESENT-but-ZERO SOL
              // withdrawal on a settling record makes the formula read ~-100%
              // even when USD economics show the position did NOT wipe. Treat
              // present-but-zero SOL as UNKNOWN (null) when USD contradicts a
              // wipe (finalValueUsd > 0 or pnlPct > -90), so the formula returns
              // null (honest gap) rather than a fabricated -1× deploy.
              const rawWithdrawnSol = posEntry.allTimeWithdrawals?.total?.sol != null
                ? parseFloat(posEntry.allTimeWithdrawals.total.sol) : null;
              const usdNotWiped = (Number.isFinite(nextFinalValueUsd) && nextFinalValueUsd > 0)
                || (Number.isFinite(nextPnlPct) && nextPnlPct > -90);
              const nextWithdrawnSol = (rawWithdrawnSol === 0 && usdNotWiped)
                ? null
                : rawWithdrawnSol;
              const nextFeesSol = posEntry.allTimeFees?.total?.sol != null
                ? parseFloat(posEntry.allTimeFees.total.sol) : null;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlUsd        = nextPnlUsd;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                withdrawnSol  = Number.isFinite(nextWithdrawnSol) ? nextWithdrawnSol : withdrawnSol;
                feesSol       = Number.isFinite(nextFeesSol) ? nextFeesSol : feesSol;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} USD (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)}, deposited=${initialUsd.toFixed(2)}`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlUsd        = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? 0;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      // Vega fix #1 — formula-based realized SOL delta persisted into the
      // performance record (the more precise wallet-delta is computed in the
      // executor close handler for the live notification). Flagged as estimate.
      //
      // Close-formula ACCURACY fix (2026-07-11, Draco on-chain reconcile): thread
      // MEASURED close gas (actual tx fees this wallet paid) instead of the flat
      // conservative estimate. The flat 0.00203928 SOL/close over-deducted
      // ~0.00067 SOL/trade → over 12 trades it overstated loss by ~0.008 SOL
      // (formula −0.027 vs on-chain −0.019). Measuring the real fees removes that
      // systematic bias so per-trade realized matches on-chain reality. Rent nets
      // out on both sides (paid at open, refunded at close) so it is correctly
      // absent from the formula — returned capital, never booked as profit.
      // FAIL-SAFE: measureCloseGasSol → null on any read failure → formula falls
      // back to the conservative flat estimate (never under-counts gas).
      const measuredCloseGasSol = await measureCloseGasSol(txHashes);
      const closeRsd = config.internalAgents?.realizedSolAccounting !== false
        ? computeLiveRealizedSolDelta({
            solDeployed: tracked.amount_sol ?? null,
            solReceivedOnClose: Number.isFinite(withdrawnSol) ? withdrawnSol : null,
            feesClaimedSol: Number.isFinite(feesSol) ? feesSol : null,
            gasSpentSol: Number.isFinite(measuredCloseGasSol) ? measuredCloseGasSol : undefined,
            finalValueUsd,
            pnlPct,
          })
        : null;

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: pool.lbPair.tokenXMint.toString(),
        peak_pnl_pct: tracked.peak_pnl_pct,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        fees_earned_sol: Number.isFinite(feesSol) ? feesSol : undefined,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        apiPnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
        apiPnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        // Vega Item 2 (2026-07-11) — canonical entry_features forward. Owner-side
        // defense-in-depth: dlmm.js is the source of truth for the closing position,
        // so it forwards the deploy-time feature snapshot directly. lessons.js also
        // backfills from tracked, but writing it here guarantees the field is present
        // even if that fallback path changes. Additive, never fabricated (null gap).
        entry_features: tracked.entry_features ?? null,
        realized_sol_delta: closeRsd?.realized_sol_delta ?? null,
        realized_sol_delta_pct: closeRsd?.realized_sol_delta_pct ?? null,
        realized_sol_method: closeRsd?.method ?? null,
        realized_sol_estimate: closeRsd?.estimate ?? null,
      });

      await recordRealizedLoss({
        pnl_pct: pnlPct,
        amount_sol: tracked.amount_sol,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        reason: reason || "agent decision",
      }).catch((e) => log("circuit_warn", `recordRealizedLoss failed: ${e.message}`));

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: pool.lbPair.tokenXMint.toString(),
        // Vega fix #1 — SOL figures for realized_sol_delta (formula fallback in
        // executor when the wallet-delta snapshot is unavailable). Additive.
        sol_deployed: tracked.amount_sol ?? null,
        sol_received: Number.isFinite(withdrawnSol) ? withdrawnSol : null,
        fees_claimed_sol: Number.isFinite(feesSol) ? feesSol : null,
        // Vega honesty-audit 2026-06-21 — SINGLE SOURCE OF TRUTH. Return the EXACT
        // realized-SOL figure that was written into the ledger (lessons.json) so the
        // Telegram notif reports the IDENTICAL number. The executor may REFINE this
        // with a measured wallet-delta (same economic quantity, now modal-corrected),
        // but if the wallet snapshot is unavailable the notif falls back to THIS
        // ledger figure rather than recomputing a divergent one.
        ledger_realized_sol_delta: closeRsd?.realized_sol_delta ?? null,
        ledger_realized_sol_delta_pct: closeRsd?.realized_sol_delta_pct ?? null,
        ledger_realized_sol_method: closeRsd?.method ?? null,
        ledger_realized_sol_estimate: closeRsd?.estimate ?? null,
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Partial Close (Vega Item 2B) ──────────────────────────────
// Pull a FRACTION of liquidity (bps) while KEEPING the position account open
// so the remainder keeps earning fees and can still hit trailing/velocity/OOR.
// Uses the same proven `removeLiquidity` primitive as a full close but with
// shouldClaimAndClose:false. This is NOT a position-ending operation.
//
// Money invariants:
//   - DRY_RUN guarded (paper accounting handled by paper-trades.js, not here).
//   - bps clamped to (0, 10000) — refuses a 0% or full (10000) pull. A full
//     pull MUST go through close_position (which closes the account + records
//     performance). A 0% pull is a no-op error.
//   - Idempotency is the CALLER's responsibility via state.markPartialTpDone —
//     this fn does not track fire-once state, it just executes one pull.
//   - TX confirmed before returning success (sendAndConfirmTransaction).
export async function partialClosePosition({ position_address, pct, reason }) {
  position_address = normalizeMint(position_address);

  const pctNum = Number(pct);
  if (!Number.isFinite(pctNum) || pctNum <= 0 || pctNum >= 100) {
    return { success: false, error: `partial pct ${pct} invalid — must be in (0,100). Use close_position for a full pull.` };
  }
  const bps = Math.round(pctNum * 100); // 50% → 5000 bps
  if (bps <= 0 || bps >= 10000) {
    return { success: false, error: `computed bps ${bps} out of (0,10000) range — refusing partial close.` };
  }

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_partial_close: position_address, bps, pct: pctNum, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — cannot partial close." };
  }

  try {
    log("partial_close", `Partial close ${pctNum}% (bps=${bps}) for ${position_address}: ${reason || "scale-out"}`);
    const wallet = (_testHooks.getWallet || getWallet)();
    const poolAddress = await (_testHooks.lookupPoolForPosition || lookupPoolForPosition)(position_address, wallet.publicKey.toString());

    // Fresh pool load so SDK reads current bin liquidity state.
    poolCache.delete(poolAddress.toString());
    const pool = await (_testHooks.getPool || getPool)(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    // Determine bin range + verify there is liquidity to pull.
    let fromBinId = -887272;
    let toBinId = 887272;
    let hasLiquidity = false;
    const positionDataForPull = await pool.getPosition(positionPubKey);
    const processed = positionDataForPull?.positionData;
    if (processed) {
      fromBinId = processed.lowerBinId ?? fromBinId;
      toBinId = processed.upperBinId ?? toBinId;
      const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
      hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
    }
    if (!hasLiquidity) {
      return { success: false, error: "No liquidity to pull — position is empty. Skipping partial close." };
    }

    // Remove `bps` of liquidity, KEEP account open (shouldClaimAndClose:false).
    const partialTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose: false, // CRITICAL — keep the account alive
    });

    const sendTx = _testHooks.sendAndConfirmTransaction || sendAndConfirmTransaction;
    const txHashes = [];
    for (const tx of Array.isArray(partialTx) ? partialTx : [partialTx]) {
      const txHash = await sendTx(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    if (txHashes.length === 0) {
      return { success: false, error: "Partial close produced no transactions." };
    }

    // Invalidate position cache so the next read reflects the reduced size.
    _positionsCacheAt = 0;

    // Verify the position is STILL OPEN (we must NOT have closed the account).
    let stillOpen = false;
    try {
      const refreshed = await (_testHooks.getMyPositions || getMyPositions)({ force: true, silent: true });
      stillOpen = Boolean(refreshed?.positions?.some((p) => p.position === position_address));
    } catch (e) {
      log("partial_close_warn", `Post-partial verification failed: ${e.message}`);
    }

    log("partial_close", `SUCCESS partial ${pctNum}% txs: ${txHashes.join(", ")} (still_open=${stillOpen})`);
    return {
      success: true,
      partial: true,
      position: position_address,
      pool: poolAddress,
      pct: pctNum,
      bps,
      txs: txHashes,
      still_open: stillOpen,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("partial_close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
