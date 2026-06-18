/**
 * Backup collectors — the in-container snapshot step a manifest can declare to
 * run BEFORE the config is staged (#1894). Extracted from producer.ts so both the
 * producer (local-seed path) and the backup-worker orchestration can run a
 * collector without a circular import (producer ↔ backupWorker/service).
 *
 * The only collector today is NPM's consistent sqlite snapshot: it execs into the
 * running NPM container (over the node agent) and writes a torn-free
 * `database.sqlite.sb-backup` on disk. The worker / producer then stages that file
 * under the canonical `database.sqlite` name (via the manifest's `renames`).
 */
import { agentManager } from '../agent/manager';
import { logger } from '../logger';
import type { ServiceBackupManifest } from './serviceManifest';

// Runs inside the NPM container: a consistent snapshot of the live WAL-mode
// /data/database.sqlite to /data/database.sqlite.sb-backup using sqlite3's online
// `.backup`, then `mv` over the canonical name. NPM's image bundles sqlite3.
//
// Since #1679 the live DB runs in WAL mode, so committed writes can sit in the
// `-wal` sidecar rather than the main file. We first `wal_checkpoint(TRUNCATE)` to
// fold the WAL back into the main DB and truncate the sidecar, then take the
// online `.backup` (itself WAL-aware) into a single self-contained file. The
// checkpoint is best-effort; `.backup` guarantees consistency regardless.
const NPM_SQLITE_SNAPSHOT_SH = [
  'set -e',
  "DB=/data/database.sqlite",
  'if [ ! -f "$DB" ]; then echo "nodb"; exit 0; fi',
  // Not every NPM image ships sqlite3 (#1894 — the current jc21 image does not).
  // Probe for it FIRST and report a precise, greppable reason so the producer can
  // degrade honestly (copy the live file) instead of logging a misleading "(unknown)".
  'if ! command -v sqlite3 >/dev/null 2>&1; then echo "no-sqlite3"; exit 0; fi',
  // Fold the WAL back into the main DB so the snapshot has no dependence on the
  // -wal/-shm sidecars. Best-effort: ignore a non-zero (busy) checkpoint.
  'sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" || true',
  // `.backup` produces a transactionally-consistent copy even mid-write.
  'sqlite3 "$DB" ".backup \'$DB.sb-snap\'"',
  'mv -f "$DB.sb-snap" "$DB.sb-backup"',
  'echo "ok"',
].join('\n');

/**
 * Run a manifest's `collector` (in-container snapshot) before the config is
 * staged. For NPM: takes a consistent `sqlite3 .backup` of the live
 * database.sqlite to `database.sqlite.sb-backup` on disk, then remaps the
 * manifest's `data/database.sqlite` include to that snapshot path so the consistent
 * copy is staged under the original name. Returns a possibly-rewritten manifest.
 * Best-effort: if the snapshot can't be taken the original manifest is returned
 * (the staging copies the live file and logs).
 */
export async function runBackupCollector(
  manifest: ServiceBackupManifest,
  node: string,
): Promise<ServiceBackupManifest> {
  if (manifest.collector?.kind !== 'npm-sqlite') return manifest;
  try {
    const agent = await agentManager.ensureAgent(node);
    const find = await agent.sendCommand('exec', {
      command: `podman ps --format '{{.Names}} {{.Image}}' | awk '/proxy-manager/{print $1; exit}'`,
    }, { timeoutMs: 15_000 });
    const container = ((find as { stdout?: string }).stdout || '').trim().split(/\s+/)[0];
    if (!container) {
      logger.warn('ExternalBackup', 'NPM container not found — backing up database.sqlite as-is (may be inconsistent)');
      return manifest;
    }
    const b64 = Buffer.from(NPM_SQLITE_SNAPSHOT_SH).toString('base64');
    const res = await agent.sendCommand('exec', {
      command: `echo ${b64} | base64 -d | podman exec -i ${container} sh -`,
    }, { timeoutMs: 30_000 });
    const out = ((res as { stdout?: string }).stdout || '').trim();
    const errOut = ((res as { stderr?: string }).stderr || '').trim();
    const code = (res as { code?: number }).code;
    // sqlite3 isn't in this NPM image — degrade honestly to copying the live DB
    // (consistent enough since #1679 flips WAL and the live file is read whole),
    // and say SO in the log rather than a misleading "(unknown)" (#1894).
    if (out === 'no-sqlite3') {
      logger.warn('ExternalBackup', 'NPM sqlite snapshot skipped: sqlite3 not present in the NPM container — backing up database.sqlite as-is');
      return manifest;
    }
    if (code !== 0 || (out !== 'ok' && out !== 'nodb')) {
      // Surface the REAL failure: prefer the container's stderr (the swallowed
      // `sh: sqlite3: not found` etc.), then any stdout, before "(unknown)".
      const reason = errOut || out || 'unknown';
      logger.warn('ExternalBackup', `NPM sqlite snapshot failed (${reason}) — backing up database.sqlite as-is`);
      return manifest;
    }
    // Stage the snapshot in place of the live DB, under the original rel path.
    return {
      ...manifest,
      include: manifest.include.map(p => (p === 'data/database.sqlite' ? 'data/database.sqlite.sb-backup' : p)),
      renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
    };
  } catch (e) {
    logger.warn('ExternalBackup', `NPM sqlite snapshot errored (${e instanceof Error ? e.message : String(e)}) — backing up database.sqlite as-is`);
    return manifest;
  }
}
