// Startup self-heal: add HOST_DATA_DIR to the servicebay quadlet for boxes
// installed before PR #1964 added it to the butane template.
//
// Context: the disk-import worker creates and bind-mounts a per-run output dir
// using the HOST-side data path (HOST_DATA_DIR = /mnt/data/servicebay), not the
// in-container /app/data (which is read-only on the host). The quadlet template
// was updated in #1964 to set Environment=HOST_DATA_DIR=/mnt/data/servicebay,
// but boxes installed before that merge don't have it — they fall back to DATA_DIR
// (/app/data), the mkdir fails with EROFS, and the worker never launches.
//
// This one-time patch injects the missing env var into the running quadlet file
// so the next restart (e.g. a channel flip) picks it up without a full reinstall.
// It is idempotent (skips if already present), and uses the Volume line to discover
// the host path rather than hardcoding /mnt/data/servicebay.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@/lib/logger';

const QUADLET_FILE = path.join(os.homedir(), '.config/containers/systemd/servicebay.container');

/**
 * Parse the host-side data path from the Volume line in the quadlet.
 * Line form: `Volume=/mnt/data/servicebay:/app/data:Z`
 * Returns null if not found or doesn't mount at /app/data.
 */
function parseHostDataDirFromQuadlet(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.match(/^Volume=([^:]+):\/app\/data(?::.+)?$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * If HOST_DATA_DIR is not in the quadlet, inject it. Idempotent.
 * Only patches when:
 *   1. The quadlet file exists (i.e., we're on a real box, not dev/test).
 *   2. HOST_DATA_DIR is not already in the file.
 *   3. We can derive the host path from the Volume line.
 */
export async function patchQuadletHostDataDir(): Promise<void> {
  if (!fs.existsSync(QUADLET_FILE)) {
    // Not a production box (dev/test env — no quadlet file). Skip silently.
    return;
  }

  const content = fs.readFileSync(QUADLET_FILE, 'utf8');

  if (content.includes('HOST_DATA_DIR')) {
    // Already present — nothing to do.
    return;
  }

  const hostDataDir = parseHostDataDirFromQuadlet(content);
  if (!hostDataDir) {
    logger.warn('DiskImport', 'quadletPatch: could not find Volume=...:/app/data line in quadlet — skipping HOST_DATA_DIR patch');
    return;
  }

  // Inject after the first Environment= line (keeps it near the other env vars).
  // The channel-flip `sed` pattern sets precedent for in-process quadlet edits.
  const patched = content.replace(
    /(Environment=[^\n]+\n)/,
    `$1Environment=HOST_DATA_DIR=${hostDataDir}\n`,
  );

  if (patched === content) {
    // regex didn't match any Environment line — fallback: append before [Service]
    logger.warn('DiskImport', 'quadletPatch: no Environment= line found to anchor HOST_DATA_DIR — skipping');
    return;
  }

  fs.writeFileSync(QUADLET_FILE, patched, 'utf8');
  logger.info('DiskImport', `quadletPatch: injected HOST_DATA_DIR=${hostDataDir} into ${QUADLET_FILE} (takes effect on next restart)`);
}
