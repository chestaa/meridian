import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getSigningWallet } from "../wallet-loader.js";

let _connection = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  return getSigningWallet();
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
/**
 * Build the failure-shape return object. CRITICAL (Vega money-path integrity):
 * on ANY read failure we return `sol: null` + `error: true`, NEVER the sentinel
 * `sol: 0`. A real empty wallet ("balance truly 0") and a failed read ("could
 * not read") must be TEGAS distinguishable by every money-path caller, otherwise
 * a Helius blip masquerades as a 100% drain (phantom "BURNER BALANCE DRAIN") AND
 * a deploy-gate could fail OPEN. Fail-closed per anti-pattern #2/#3.
 *
 * `tokens` stays `[]` (not null) so auto-swap callers (`.tokens?.find`) don't
 * throw — they simply find nothing, which is the correct fail-closed behavior
 * for an unreadable wallet. `sol_price`/`sol_usd`/`usdc`/`total_usd` are null
 * (unknown), not 0 (a real value).
 */
function walletReadFailure(walletAddress, message) {
  return {
    wallet: walletAddress,
    sol: null,
    sol_price: null,
    sol_usd: null,
    usdc: null,
    tokens: [],
    total_usd: null,
    error: true,
    error_message: message,
  };
}

// ─── Helius transient-failure hardening (Vega, P1 — bot idle since Jul 1) ──
// Helius 502'd 73× in 5 days → every screening cycle read the wallet as
// unreadable → the deploy gate skipped → the bot never deployed. Root cause is
// a hard single-shot fetch with no retry and no fallback. Fix hardens ONLY the
// balance READ: (1) retry-with-backoff on 5xx/429, (2) if Helius still fails,
// fall back to plain Solana JSON-RPC `getBalance` (the path that works when
// Helius is down — mirrors scripts/boss-report.js getSolBalance). No deploy,
// sizing, DRY_RUN, or tx logic is touched.
const HELIUS_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const HELIUS_MAX_ATTEMPTS = 3;
const HELIUS_BACKOFF_MS = [300, 800]; // between attempt 1→2 and 2→3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch Helius balances with retry-with-backoff on transient 5xx/429.
 * Returns the parsed JSON on success. Throws on exhausted retries or a
 * non-retryable failure — the caller then attempts the RPC fallback.
 */
async function fetchHeliusBalancesWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= HELIUS_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // Retry only on transient status; other !ok (e.g. 401 bad key) is
        // non-retryable → throw immediately (RPC fallback still runs after).
        if (HELIUS_RETRYABLE_STATUS.has(res.status) && attempt < HELIUS_MAX_ATTEMPTS) {
          lastErr = new Error(`Helius API error: ${res.status} ${res.statusText}`);
          log("wallet_warn", `Helius ${res.status} (attempt ${attempt}/${HELIUS_MAX_ATTEMPTS}) — retrying`);
          await sleep(HELIUS_BACKOFF_MS[attempt - 1] ?? 800);
          continue;
        }
        throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      // Network-level throw (fetch reject) is transient → retry with backoff.
      if (attempt < HELIUS_MAX_ATTEMPTS) {
        log("wallet_warn", `Helius fetch threw (attempt ${attempt}/${HELIUS_MAX_ATTEMPTS}): ${e.message} — retrying`);
        await sleep(HELIUS_BACKOFF_MS[attempt - 1] ?? 800);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Helius fetch failed");
}

/**
 * Plain Solana JSON-RPC getBalance fallback (SOL only). Mirrors the working
 * pattern in scripts/boss-report.js — this RPC path stays up when Helius is
 * down. Returns a finite SOL number on success, or null on ANY failure.
 * NEVER returns 0-as-success: a network/RPC failure yields null so the caller
 * fails closed (anti-pattern #2/#3), not a fabricated empty wallet.
 */
async function getSolBalanceViaRpc(walletAddress) {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) return null;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    // A genuine RPC success carries result.value (lamports, possibly 0). Its
    // ABSENCE means the response was unusable → null, not a sentinel 0.
    const lamports = d?.result?.value;
    if (lamports == null || !Number.isFinite(Number(lamports))) return null;
    return Number(lamports) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}

/**
 * Degraded (RPC-fallback) balance shape. SOL is real (from chain RPC), but the
 * USD/price/token/usdc fields Helius would have provided are genuinely unknown
 * → null (never fabricated, never a sentinel 0). `error` stays false so the
 * deploy gate can proceed on a real SOL read; `degraded`/`source` are markers
 * for observability. `tokens: []` keeps auto-swap callers (`.tokens?.find`)
 * fail-closed (find nothing) rather than throwing.
 */
function walletRpcFallback(walletAddress, sol) {
  return {
    wallet: walletAddress,
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price: null,
    sol_usd: null,
    usdc: null,
    tokens: [],
    total_usd: null,
    error: false,
    degraded: true,
    source: "rpc_fallback",
  };
}

export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return walletReadFailure(null, "Wallet not configured");
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    // No Helius key: still try the RPC fallback so the deploy gate can proceed
    // on a real SOL read rather than skipping forever.
    const sol = await getSolBalanceViaRpc(walletAddress);
    if (sol != null && Number.isFinite(sol)) {
      log("wallet_warn", "Helius API key missing — served SOL via RPC fallback");
      return walletRpcFallback(walletAddress, sol);
    }
    return walletReadFailure(walletAddress, "Helius API key missing");
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const data = await fetchHeliusBalancesWithRetry(url);
    // Distinguish "Helius returned no balances field" (read failure / malformed)
    // from "wallet genuinely holds nothing". A successful 200 always carries a
    // `balances` array; its ABSENCE means the response was unusable → fail-closed
    // (sol: null), NOT a sentinel 0.
    if (!Array.isArray(data.balances)) {
      throw new Error("Helius response missing balances array");
    }
    const balances = data.balances;

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    // Helius exhausted (retries + non-retryable). Try the RPC fallback so a
    // Helius outage no longer freezes deploys. Only if RPC ALSO fails do we
    // return the unreadable/skip result (fail-closed — anti-pattern #2/#3).
    log("wallet_warn", `Helius unreadable after retries (${error.message}) — attempting RPC fallback`);
    const sol = await getSolBalanceViaRpc(walletAddress);
    if (sol != null && Number.isFinite(sol)) {
      log("wallet_warn", `Served SOL=${sol} via RPC fallback (Helius down)`);
      return walletRpcFallback(walletAddress, sol);
    }
    log("wallet_error", `Both Helius and RPC fallback failed: ${error.message}`);
    return walletReadFailure(walletAddress, error.message);
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
