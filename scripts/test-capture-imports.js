#!/usr/bin/env node
/**
 * test-capture-imports.js — Cassiopeia 👁️
 * Import-graph lint: capture-logger.js must NOT touch executor/wallet/dlmm/signing.
 * Forward-capture is READ-ONLY data capture — NO money path, NO on-chain writes.
 * Mirror of test-snapshot-imports.js.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = [path.join(__dirname, "capture-logger.js")];

// Forbid any import/require of the money path: executor (deploy dispatch),
// dlmm.js (on-chain deploy/close/claim), tools/wallet (balances + Jupiter swap
// signing), state.js (position-registry writes), or any signer module.
const FORBIDDEN =
  /(require|from|import)\s*\(?\s*['"][^'"]*(executor|tools\/wallet|wallet-loader|\/wallet\.js|dlmm|\/signer|signer\.js|\.\.\/state\.js)[^'"]*['"]/;

let fail = false;
for (const file of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`[capture-import-lint] MISSING ${file}`);
    fail = true;
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORBIDDEN.test(line)) {
      console.error(`[capture-import-lint] FAIL ${path.basename(file)}:${i + 1} → ${line.trim()}`);
      fail = true;
    }
  }
}

if (fail) process.exit(1);
console.log("[capture-import-lint] PASS — no money-path imports in capture-logger.js");
