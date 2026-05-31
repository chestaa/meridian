/**
 * env-crypto.js — AES-256-GCM at-rest encryption for sensitive env values.
 *
 * Built post pk-leak intel (community wallet drained via leaked private key).
 * Defense-in-depth: even if .env leaks on disk, an enc: value is useless
 * without ENV_ENCRYPTION_KEY (which should live OUT of band — see tradeoff note
 * in wallet-loader.js and the task report).
 *
 * Format of an encrypted value (after the `enc:` prefix):
 *   base64( salt[16] || iv[12] || authTag[16] || ciphertext )
 *
 * Key derivation: scrypt(passphrase, salt, 32) → AES-256 key. Per-value random
 * salt + iv so identical plaintexts never produce identical ciphertext, and a
 * leaked ciphertext reveals nothing about the passphrase.
 *
 * SECURITY INVARIANTS (money/credential path — paranoid by design):
 *   - GCM auth tag is verified on decrypt. A wrong passphrase or any tamper
 *     throws — we NEVER return a half-valid / corrupt key. Hard fail only.
 *   - This module NEVER logs plaintext or the passphrase. Callers must not
 *     log the return value of decrypt().
 *   - No new dependency: Node's built-in `crypto` only.
 */

import crypto from "crypto";

export const ENC_PREFIX = "enc:";
const ALGO = "aes-256-gcm";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("env-crypto: passphrase (ENV_ENCRYPTION_KEY) is empty.");
  }
  return crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT_COST);
}

/** True if a stored value carries the encrypted marker prefix. */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a plaintext string. Returns an `enc:`-prefixed base64 blob.
 * Used by scripts/encrypt-env.js — NOT on the hot runtime path.
 */
export function encrypt(plaintext, passphrase) {
  if (typeof plaintext !== "string") {
    throw new Error("env-crypto.encrypt: plaintext must be a string.");
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, tag, ct]).toString("base64");
  return ENC_PREFIX + blob;
}

/**
 * Decrypt an `enc:`-prefixed value. Throws on any failure (wrong passphrase,
 * tamper, malformed blob) — callers MUST NOT proceed with a bad key.
 * Returns plaintext string. NEVER log this return value.
 */
export function decrypt(encValue, passphrase) {
  if (!isEncrypted(encValue)) {
    throw new Error("env-crypto.decrypt: value is not enc:-prefixed.");
  }
  let raw;
  try {
    raw = Buffer.from(encValue.slice(ENC_PREFIX.length), "base64");
  } catch {
    throw new Error("env-crypto.decrypt: malformed base64 payload.");
  }
  if (raw.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error("env-crypto.decrypt: payload too short / corrupt.");
  }
  const salt = raw.subarray(0, SALT_LEN);
  const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ct = raw.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // GCM auth failure = wrong passphrase or tampered ciphertext.
    // Do NOT leak any detail about key/plaintext.
    throw new Error(
      "env-crypto.decrypt: authentication failed — wrong ENV_ENCRYPTION_KEY or corrupted value. Refusing to proceed."
    );
  }
}

/**
 * Resolve a possibly-encrypted env value to plaintext.
 *   - plaintext (no enc: prefix) → returned as-is (backward compatible)
 *   - enc:-prefixed → decrypted with ENV_ENCRYPTION_KEY (must be set, else throw)
 */
export function resolveValue(value, { passphrase = process.env.ENV_ENCRYPTION_KEY } = {}) {
  if (!isEncrypted(value)) return value; // plaintext passthrough
  if (!passphrase) {
    throw new Error(
      "Encrypted value (enc:) found but ENV_ENCRYPTION_KEY is not set. " +
      "Refusing to proceed — cannot decrypt credential."
    );
  }
  return decrypt(value, passphrase);
}
