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

  // Hardening (Draco 2026-06-06): the snapshot push races the autopull cron for
  // the git index lock. `flock -n` aborted instantly on contention → execSync
  // throws → systemd marks the oneshot `failed` → false-alarm OnFailure alert.
  // Fix: `flock -w 30` blocks up to 30s for the lock instead of bailing, AND we
  // retry the push once on transient failure (e.g. force-with-lease loses to a
  // concurrent autopull reset — refetch remote status then re-push).
  const pushBase = 'git push --force-with-lease origin status';
  const pushCmd = useFlock ? `flock -w 30 ${LOCKFILE} ${pushBase}` : pushBase;

  try {
    sh(pushCmd, gitOpts);
    console.log('[snapshot] pushed to status branch');
  } catch (firstErr) {
    console.warn(`[snapshot] push attempt 1 failed (${firstErr.message.split('\n')[0]}), retrying once`);
    // Refresh local view of the remote status branch so force-with-lease has a
    // current lease base, then re-push. This recovers from a lost lease race.
    try { sh('git fetch origin status', gitOpts); } catch { /* best-effort */ }
    sh(pushCmd, gitOpts);
    console.log('[snapshot] pushed to status branch (retry)');
  }
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
