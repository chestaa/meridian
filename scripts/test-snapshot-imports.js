#!/usr/bin/env node
/**
 * test-snapshot-imports.js — Sirius 🐺
 * Import-graph lint: snapshot-*.js must NOT touch executor/wallet/dlmm/signing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = [
  path.join(__dirname, 'snapshot-publisher.js'),
  path.join(__dirname, 'lib', 'snapshot-builder.js'),
];

const FORBIDDEN = /(require|from|import)\s*\(?\s*['"][^'"]*(executor|wallet-loader|tools\/wallet|dlmm|\/signer|signer\.js|\.\.\/state\.js)[^'"]*['"]/;

let fail = false;
for (const file of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`[import-lint] MISSING ${file}`);
    fail = true; continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORBIDDEN.test(line)) {
      console.error(`[import-lint] FAIL ${path.basename(file)}:${i + 1} → ${line.trim()}`);
      fail = true;
    }
  }
}

if (fail) process.exit(1);
console.log('[import-lint] PASS — no forbidden imports in snapshot-*.js');
