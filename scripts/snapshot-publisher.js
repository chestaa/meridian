#!/usr/bin/env node
/**
 * snapshot-publisher.js — Sirius 🐺
 *
 * Build status snapshot and publish to `status` branch via worktree.
 * NEVER imports executor/wallet-loader/dlmm/signing modules.
 *
 * Dry mode (default when no --push): write to ./status-snapshot.json only.
 * Push mode: --push  →  worktree + flock + force-with-lease.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import 'dotenv/config';
import { buildSnapshot } from './lib/snapshot-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKTREE_DIR = path.join(ROOT, '.git-worktrees', 'status');
const SNAPSHOT_FILE = 'status-snapshot.json';
const LOCKFILE = path.join(ROOT, '.git-worktrees', '.snapshot.lock');

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
}

function pushSnapshot(snapshotJson) {
  if (!fs.existsSync(WORKTREE_DIR)) {
    throw new Error(`Worktree missing: ${WORKTREE_DIR}. Run setup per docs/snapshot-publisher.md`);
  }
  const useFlock = process.platform !== 'win32';
  const targetFile = path.join(WORKTREE_DIR, SNAPSHOT_FILE);

  fs.writeFileSync(targetFile, snapshotJson + '\n');

  const gitOpts = { cwd: WORKTREE_DIR };
  const status = sh('git status --porcelain', gitOpts);
  if (!status) {
    console.log('[snapshot] no change, skipping commit');
    return;
  }

  sh('git add status-snapshot.json', gitOpts);
  sh(`git -c user.name=meridian-snapshot -c user.email=snapshot@meridian.local commit -m "snapshot: ${new Date().toISOString()}"`, gitOpts);

  const pushCmd = useFlock
    ? `flock -n ${LOCKFILE} git push --force-with-lease origin status`
    : `git push --force-with-lease origin status`;
  sh(pushCmd, gitOpts);
  console.log('[snapshot] pushed to status branch');
}

async function main() {
  const push = process.argv.includes('--push');
  const snap = await buildSnapshot();
  const json = JSON.stringify(snap, null, 2);

  if (!push) {
    const out = path.join(ROOT, SNAPSHOT_FILE);
    fs.writeFileSync(out, json + '\n');
    console.log(`[snapshot] dry mode → wrote ${out}`);
    console.log(`[snapshot] ts=${snap.ts} open=${snap.summary.open_count} sol_free=${snap.wallet.sol_free}`);
    return;
  }

  pushSnapshot(json);
}

main().catch(err => {
  console.error('[snapshot] FATAL:', err.message);
  process.exit(1);
});
