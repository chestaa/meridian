#!/usr/bin/env node
/**
 * test-env-crypto.js — AES-256-GCM env-crypto invariants.
 * Roundtrip, wrong-passphrase hard-fail, tamper detection, plaintext passthrough,
 * never-logs-key, and the wallet-loader enc: integration (decrypt before bs58).
 */
import { encrypt, decrypt, isEncrypted, resolveValue, ENC_PREFIX } from "../lib/env-crypto.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) { console.error(`FAIL: ${name}`); fail++; }
    else { console.log(`ok: ${name}`); pass++; }
  } catch (e) {
    console.error(`FAIL: ${name} — ${e.message}`);
    fail++;
  }
}
function expectThrow(name, fn) {
  try { fn(); console.error(`FAIL: ${name} (expected throw)`); fail++; }
  catch { console.log(`ok: ${name}`); pass++; }
}

const PASS = "correct horse battery staple";
const SECRET = "5JfakeBurnerPrivateKeyBase58StringForTestingOnly123456789";

// 1. roundtrip
check("encrypt→decrypt roundtrip recovers plaintext", () =>
  decrypt(encrypt(SECRET, PASS), PASS) === SECRET);

// 2. enc: prefix present
check("ciphertext carries enc: prefix", () =>
  encrypt(SECRET, PASS).startsWith(ENC_PREFIX));

// 3. isEncrypted detection
check("isEncrypted true for enc:, false for plaintext", () =>
  isEncrypted(encrypt(SECRET, PASS)) === true && isEncrypted(SECRET) === false);

// 4. non-deterministic (random salt+iv)
check("same plaintext → different ciphertext (random salt/iv)", () =>
  encrypt(SECRET, PASS) !== encrypt(SECRET, PASS));

// 5. wrong passphrase HARD FAILS (never returns corrupt key)
expectThrow("wrong passphrase throws (no corrupt key returned)", () =>
  decrypt(encrypt(SECRET, PASS), "wrong passphrase entirely"));

// 6. tampered ciphertext fails GCM auth
expectThrow("tampered ciphertext fails auth tag", () => {
  const enc = encrypt(SECRET, PASS);
  const raw = Buffer.from(enc.slice(ENC_PREFIX.length), "base64");
  raw[raw.length - 1] ^= 0xff; // flip last byte of ciphertext
  decrypt(ENC_PREFIX + raw.toString("base64"), PASS);
});

// 7. malformed / too-short payload fails
expectThrow("too-short payload throws", () => decrypt(ENC_PREFIX + "AAAA", PASS));

// 8. plaintext passthrough via resolveValue
check("resolveValue passes plaintext through unchanged", () =>
  resolveValue(SECRET, { passphrase: PASS }) === SECRET);

// 9. resolveValue decrypts enc: value
check("resolveValue decrypts enc: value", () =>
  resolveValue(encrypt(SECRET, PASS), { passphrase: PASS }) === SECRET);

// 10. resolveValue throws if enc: but no passphrase
expectThrow("resolveValue throws on enc: with no passphrase", () =>
  resolveValue(encrypt(SECRET, PASS), { passphrase: "" }));

// 11. NEVER logs the key — capture console during a full encrypt/decrypt cycle
check("never logs plaintext key to console", () => {
  const orig = { log: console.log, err: console.error, warn: console.warn };
  let captured = "";
  console.log = console.error = console.warn = (...a) => { captured += a.join(" "); };
  try {
    const enc = encrypt(SECRET, PASS);
    decrypt(enc, PASS);
    try { decrypt(enc, "bad"); } catch { /* expected */ }
    resolveValue(enc, { passphrase: PASS });
  } finally {
    console.log = orig.log; console.error = orig.err; console.warn = orig.warn;
  }
  return !captured.includes(SECRET);
});

// 12. error messages from decrypt never embed the secret or passphrase
check("decrypt error message leaks neither key nor passphrase", () => {
  try { decrypt(encrypt(SECRET, PASS), "bad"); return false; }
  catch (e) { return !e.message.includes(SECRET) && !e.message.includes(PASS); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
