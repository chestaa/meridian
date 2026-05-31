import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";
import { isEncrypted, resolveValue } from "./lib/env-crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLACKLIST_PATH = path.join(__dirname, "config", "main-wallets-blacklist.json");

let _wallet = null;
let _source = null;

function loadBlacklist() {
  if (!fs.existsSync(BLACKLIST_PATH)) {
    throw new Error(
      `main-wallets-blacklist.json missing at ${BLACKLIST_PATH}. ` +
      `Refusing to start. Create the file with at least your main wallet pubkey. ` +
      `See docs/plans/burner-wallet-path-design.md §3.`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf8"));
  } catch (e) {
    throw new Error(`main-wallets-blacklist.json is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(raw)) throw new Error("main-wallets-blacklist.json must be a JSON array");
  return raw.map((r) => String(r.pubkey || "").trim()).filter(Boolean);
}

/**
 * Single source for signing wallet — used by both dlmm.js and wallet.js.
 *
 * Resolution order:
 *   1. BURNER_WALLET_KEY  — always preferred
 *   2. WALLET_PRIVATE_KEY — ONLY accepted when DRY_RUN=true (Phase 0 legacy compat)
 *
 * DRY_RUN=false with no BURNER_WALLET_KEY → hard refuse (Anti-Pattern #5).
 * Loaded pubkey matched against main-wallets-blacklist.json → hard refuse on match.
 */
export function getSigningWallet() {
  if (_wallet) return _wallet;

  const dryRun = String(process.env.DRY_RUN || "").toLowerCase() === "true";
  const burnerKey = process.env.BURNER_WALLET_KEY;
  const legacyKey = process.env.WALLET_PRIVATE_KEY;

  let secret, source;
  if (burnerKey) {
    secret = burnerKey;
    source = "BURNER_WALLET_KEY";
  } else if (dryRun && legacyKey) {
    secret = legacyKey;
    source = "WALLET_PRIVATE_KEY (legacy dry-run fallback)";
    log("wallet_warn", "Using legacy WALLET_PRIVATE_KEY — only allowed because DRY_RUN=true. Add BURNER_WALLET_KEY before Phase 1.");
  } else if (!dryRun && !burnerKey) {
    throw new Error(
      "Phase 1 violation: DRY_RUN=false requires BURNER_WALLET_KEY. " +
      "Legacy WALLET_PRIVATE_KEY is NOT accepted for live trading. " +
      "See docs/plans/burner-wallet-path-design.md."
    );
  } else {
    throw new Error("No wallet key found. Set BURNER_WALLET_KEY (or WALLET_PRIVATE_KEY with DRY_RUN=true for dry-run).");
  }

  // At-rest decryption (Vega — post pk-leak intel). If the key is enc:-prefixed,
  // decrypt with ENV_ENCRYPTION_KEY before use. Plaintext keys pass through
  // unchanged (backward compatible, opt-in). A decrypt failure throws — we NEVER
  // proceed with a corrupt/half-decrypted key. The decrypted secret is NEVER logged.
  if (isEncrypted(secret)) {
    try {
      secret = resolveValue(secret); // reads ENV_ENCRYPTION_KEY internally
    } catch (e) {
      throw new Error(`Failed to decrypt wallet key from ${source}: ${e.message}`);
    }
    source = `${source} (enc:AES-256-GCM)`;
  }

  let kp;
  try {
    kp = Keypair.fromSecretKey(bs58.decode(secret));
  } catch (e) {
    throw new Error(`Failed to load wallet from ${source}: ${e.message}`);
  }

  const pub = kp.publicKey.toBase58();
  const blacklist = loadBlacklist();
  if (blacklist.includes(pub)) {
    throw new Error(
      `Wallet ${pub} is in main-wallets-blacklist.json. ` +
      `Refusing to start. Anti-Pattern #5: never use main wallet for live trading.`
    );
  }

  log("init", `Wallet source=${source} pubkey=${pub}`);
  _wallet = kp;
  _source = source;
  return _wallet;
}

export function getWalletSource() {
  return _source;
}
