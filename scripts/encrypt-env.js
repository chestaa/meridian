#!/usr/bin/env node
/**
 * encrypt-env.js — encrypt a single sensitive value with AES-256-GCM for at-rest
 * storage in .env (e.g. BURNER_WALLET_KEY / WALLET_PRIVATE_KEY).
 *
 * Usage:
 *   ENV_ENCRYPTION_KEY=<passphrase> node scripts/encrypt-env.js "<plaintext-value>"
 *
 * Output: an enc:-prefixed blob. Paste it into .env as the value:
 *   BURNER_WALLET_KEY=enc:....
 *
 * wallet-loader.js auto-detects the enc: prefix at runtime and decrypts with
 * ENV_ENCRYPTION_KEY. Plaintext values still work (opt-in, non-breaking).
 *
 * SECURITY: this prints the CIPHERTEXT (safe), never the plaintext. Run it in a
 * shell where command history is not persisted if pasting a private key inline,
 * or pipe via stdin to avoid leaking the plaintext into history.
 */
import { encrypt } from "../lib/env-crypto.js";
import readline from "readline";

const passphrase = process.env.ENV_ENCRYPTION_KEY;
if (!passphrase) {
  console.error("ENV_ENCRYPTION_KEY must be set (the master passphrase).");
  process.exit(1);
}

const inlineValue = process.argv.slice(2).join(" ").trim();

function emit(plaintext) {
  if (!plaintext) {
    console.error("No value provided to encrypt.");
    process.exit(1);
  }
  try {
    process.stdout.write(encrypt(plaintext, passphrase) + "\n");
  } catch (e) {
    console.error(`Encrypt failed: ${e.message}`);
    process.exit(1);
  }
}

if (inlineValue) {
  emit(inlineValue);
} else {
  // Read from stdin (preferred — keeps the secret out of shell history).
  const rl = readline.createInterface({ input: process.stdin });
  let buf = "";
  rl.on("line", (l) => { buf += l; });
  rl.on("close", () => emit(buf.trim()));
}
