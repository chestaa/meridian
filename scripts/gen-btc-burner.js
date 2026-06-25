#!/usr/bin/env node
/**
 * gen-btc-burner.js — generate the DEDICATED BTC-TSMOM burner keypair, encrypt the
 * private key at rest (AES-256-GCM via lib/env-crypto), and print ONLY the PUBLIC key.
 *
 * VEGA 🔥 — Phase-B requirement #5. This creates the live-execution wallet for the
 * BTC-TSMOM stack, SEPARATE from the DLMM burner. It does NOT fund anything and does
 * NOT enable live trading. It is provisioning only — Bro confirms the pubkey out of
 * band before any Phase-D funding.
 *
 * HARD SECURITY CONTRACT (paranoid by design — this is a private key):
 *   * The PLAINTEXT private key NEVER touches disk and is NEVER printed/logged. Only
 *     the AES-256-GCM `enc:` ciphertext is written to the secrets file.
 *   * Requires ENV_ENCRYPTION_KEY (the master passphrase). Refuses without it — we
 *     never write a plaintext key as a "convenience".
 *   * Writes the ciphertext to a GITIGNORED secrets file (default
 *     secrets/btc-burner.enc). Refuses to overwrite an existing file (no clobbering a
 *     funded burner). Use --force only with intent.
 *   * Asserts the generated pubkey is NOT in config/main-wallets-blacklist.json
 *     (a generated key never will be, but we check — anti-pattern #5 defense).
 *   * Prints ONLY: the pubkey + the env var name to set + the secrets file path.
 *
 * Usage:
 *   ENV_ENCRYPTION_KEY=<master-passphrase> node scripts/gen-btc-burner.js
 *   ENV_ENCRYPTION_KEY=<...> node scripts/gen-btc-burner.js --out secrets/btc-burner.enc
 *   ENV_ENCRYPTION_KEY=<...> node scripts/gen-btc-burner.js --force   # overwrite existing
 *
 * AFTER running (operator, out of band — NOT this script's job):
 *   1) Confirm the printed pubkey with Bro.
 *   2) Wire BTC_TSMOM_BURNER_KEY=<contents-of-secrets-file> into the live env
 *      (the enc: blob; wallet-loader decrypts it with ENV_ENCRYPTION_KEY at runtime).
 *      NOTE: this stack uses BURNER_WALLET_KEY today (shared loader). If BTC TSMOM is
 *      to use a DISTINCT key var, wire it in the BTC live entrypoint — out of scope
 *      for Phase B (no live path yet).
 *   3) Phase D ONLY: fund the burner with the probe amount. NEVER before Bro confirms.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { encrypt } from "../lib/env-crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const BLACKLIST_PATH = path.join(REPO, "config", "main-wallets-blacklist.json");

function fail(msg) {
  console.error(`gen-btc-burner: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const outIdx = args.indexOf("--out");
const outPath = path.resolve(
  REPO,
  outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join("secrets", "btc-burner.enc")
);

const passphrase = process.env.ENV_ENCRYPTION_KEY;
if (!passphrase) {
  fail("ENV_ENCRYPTION_KEY (master passphrase) must be set. Refusing to write a plaintext key.");
}

// Refuse to clobber an existing secrets file unless --force (don't overwrite a funded burner).
if (fs.existsSync(outPath) && !force) {
  fail(`secrets file already exists at ${outPath}. Refusing to overwrite (use --force only with intent).`);
}

// 1) Generate a fresh keypair. The secretKey stays in memory only.
const kp = Keypair.generate();
const pubkey = kp.publicKey.toBase58();
const secretB58 = bs58.encode(kp.secretKey); // plaintext — NEVER logged/printed/disk'd raw

// 2) Anti-pattern #5 defense: never a known main wallet (a generated key won't be, but check).
let blacklist = [];
try {
  blacklist = JSON.parse(fs.readFileSync(BLACKLIST_PATH, "utf8")).map((r) => String(r.pubkey || "").trim());
} catch {
  // a missing blacklist is non-fatal HERE (we're generating, not loading for signing);
  // wallet-loader enforces it hard at runtime. We still warn.
  console.error("gen-btc-burner: WARNING — could not read main-wallets-blacklist.json (runtime loader still enforces it).");
}
if (blacklist.includes(pubkey)) {
  fail(`generated pubkey ${pubkey} collides with a blacklisted main wallet (astronomically unlikely — regenerate).`);
}

// 3) Encrypt the private key at rest. Only the ciphertext is ever persisted.
let encBlob;
try {
  encBlob = encrypt(secretB58, passphrase); // enc:base64(salt|iv|tag|ct)
} catch (e) {
  fail(`encryption failed: ${e.message}`);
}

// 4) Write the ciphertext to the gitignored secrets file (0600 where supported).
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, encBlob + "\n", { mode: 0o600 });
try { fs.chmodSync(outPath, 0o600); } catch { /* best-effort on platforms without chmod */ }

// 5) Report ONLY the pubkey + wiring instructions. The private key is gone from view.
console.log("BTC-TSMOM burner provisioned (DRY-RUN-only; NOT funded, NOT live).");
console.log("");
console.log(`  PUBKEY (confirm with Bro out of band): ${pubkey}`);
console.log(`  Encrypted key written to            : ${outPath}  (mode 600, gitignored)`);
console.log(`  Decrypts with                       : ENV_ENCRYPTION_KEY (the master passphrase you used)`);
console.log("");
console.log("NEXT (operator, out of band — NOT done here):");
console.log("  • Confirm the pubkey above with Bro.");
console.log("  • Phase D ONLY: fund the burner. NEVER before Bro confirms.");
console.log("  • The PLAINTEXT private key was never printed, logged, or written. Only the enc: blob exists.");
