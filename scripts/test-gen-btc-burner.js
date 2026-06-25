// scripts/test-gen-btc-burner.js — burner generator security contract.
// Proves: refuses without master key; writes ONLY enc: ciphertext (never plaintext);
// the blob decrypts back to a valid keypair matching the reported pubkey; refuses to
// clobber. Runs the script as a child process with an isolated --out path.
// Run: node scripts/test-gen-btc-burner.js

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { decrypt, isEncrypted } from "../lib/env-crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "gen-btc-burner.js");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btc-burner-"));
const out = path.join(tmp, "btc-burner.enc");
const MASTER = "test-master-passphrase-not-production";

function run(env, extraArgs = []) {
  return execFileSync("node", [SCRIPT, "--out", out, ...extraArgs], {
    env: { ...process.env, ...env }, encoding: "utf8",
  });
}
function runExpectFail(env, extraArgs = []) {
  try { run(env, extraArgs); return null; }
  catch (e) { return (e.stderr || "") + (e.stdout || ""); }
}

// ── refuses without ENV_ENCRYPTION_KEY (never writes plaintext) ─────────────────
const noKey = runExpectFail({ ENV_ENCRYPTION_KEY: "" });
ok(noKey && /ENV_ENCRYPTION_KEY/.test(noKey), "refuses without master key");
ok(!fs.existsSync(out), "no file written when master key missing");

// ── happy path: writes enc: ciphertext, prints pubkey, NOT the private key ───────
const stdout = run({ ENV_ENCRYPTION_KEY: MASTER });
const m = stdout.match(/PUBKEY[^:]*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
ok(m, "prints a base58 pubkey");
const reportedPub = m && m[1];
ok(fs.existsSync(out), "secrets file written");

const blob = fs.readFileSync(out, "utf8").trim();
ok(isEncrypted(blob), "secrets file holds an enc:-prefixed blob");

// the plaintext private key must NOT appear in stdout.
const decoded = decrypt(blob, MASTER);
ok(!stdout.includes(decoded), "PLAINTEXT private key NOT present in stdout (never leaked)");

// the blob decrypts to a keypair whose pubkey matches the reported one.
const kp = Keypair.fromSecretKey(bs58.decode(decoded));
ok(kp.publicKey.toBase58() === reportedPub, "enc: blob decrypts to the SAME keypair as the reported pubkey");

// wrong passphrase fails to decrypt (GCM auth) — confirms it's genuinely encrypted.
let wrongFailed = false;
try { decrypt(blob, "wrong-passphrase"); } catch { wrongFailed = true; }
ok(wrongFailed, "wrong passphrase fails to decrypt (AES-256-GCM auth)");

// ── refuses to clobber an existing file without --force ─────────────────────────
const clobber = runExpectFail({ ENV_ENCRYPTION_KEY: MASTER });
ok(clobber && /already exists/.test(clobber), "refuses to overwrite an existing secrets file");

// ── --force overwrites and produces a DIFFERENT key ─────────────────────────────
const forced = run({ ENV_ENCRYPTION_KEY: MASTER }, ["--force"]);
const m2 = forced.match(/PUBKEY[^:]*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
ok(m2 && m2[1] !== reportedPub, "--force regenerates a distinct keypair");

console.log(`\ngen-btc-burner: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
