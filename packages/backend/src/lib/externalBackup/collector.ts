/**
 * Backup collectors — the in-container snapshot step a manifest can declare to
 * run BEFORE the config is staged (#1894). Extracted from producer.ts so both the
 * producer (local-seed path) and the backup-worker orchestration can run a
 * collector without a circular import (producer ↔ backupWorker/service).
 *
 * Two collectors exist:
 *
 *  - `npm-sqlite` — NPM's consistent sqlite snapshot: it execs into the running
 *    NPM container (over the node agent) and writes a torn-free
 *    `database.sqlite.sb-backup` on disk. The worker / producer then stages that
 *    file under the canonical `database.sqlite` name (via the manifest's
 *    `renames`).
 *  - `pg-dump` (#2864) — `pg_dump` inside the service's own Postgres container,
 *    copied out to the service data dir as `<dumpPath>.sb-dump` and staged under
 *    `<dumpPath>`. The raw `pgdata/` cluster dir is excluded by the collector
 *    itself, whatever the manifest declared.
 *
 * RESTORE. Neither collector has a restore counterpart, by design: both stage a
 * plain file, and the restore path writes it back into the service data dir like
 * any other config file. For sqlite that IS the restore. For Postgres the file
 * is a `pg_dump` custom-format archive, so the operator (or the service's own
 * post-deploy) loads it into the fresh cluster with the tools already inside the
 * Postgres image:
 *
 *   podman cp <serviceDataDir>/<dumpPath> <service>-db:/tmp/restore.dump
 *   podman exec <service>-db pg_restore --username <user> --dbname <database> \
 *     --clean --if-exists /tmp/restore.dump
 *
 * (custom format, not plain SQL: it is compressed, `pg_restore` can rebuild a
 * dropped/renamed database from it, and it round-trips large objects — a plain
 * `.sql` would only be `psql -f`-able into an already-matching schema.)
 * Documented for template authors in `docs/TEMPLATE_AUTHORING.md`.
 */
import path from 'path';

import { agentManager } from '../agent/manager';
import { getConfig } from '../config';
import { logger } from '../logger';
import {
  pgDumpCollectorProblems,
  pgDumpPaths,
  pgDumpRemap,
  type PgDumpCollector,
  type ServiceBackupManifest,
} from '@servicebay/backup-manifest';

// Runs inside the NPM container: a snapshot of the live WAL-mode
// /data/database.sqlite to /data/database.sqlite.sb-backup, which the worker then
// stages under the canonical name.
//
// Preferred path — sqlite3's online `.backup`. Since #1679 the live DB runs in WAL
// mode, so committed writes can sit in the `-wal` sidecar rather than the main
// file. We first `wal_checkpoint(TRUNCATE)` to fold the WAL back into the main DB
// and truncate the sidecar, then take the online `.backup` (itself WAL-aware) into
// a single self-contained file. The checkpoint is best-effort; `.backup` guarantees
// consistency regardless.
//
// Fallback path (#2877) — the jc21 NPM image ships NO sqlite3. The old code gave up
// here and let the host copy `/data/database.sqlite` directly, which can never work:
// that file is owned by the container's (uid-mapped) root at mode 0600, and the
// backup worker runs as a different uid, so every single run ended in EACCES and the
// proxy-host/cert database — the one file whose loss means re-creating every route by
// hand — was the only service never on the NAS. So take the copy from INSIDE the
// container instead, where the file's own uid can read it, and `chmod` the copy so the
// worker can read it back off the bind mount. `cat` needs no binary the image might
// lack. The copy is LIVE (no checkpoint is possible without sqlite3), so it is
// reported as `live` and recorded `consistent: false` in the backup meta.
const NPM_SQLITE_SNAPSHOT_SH = [
  'set -e',
  'DB=/data/database.sqlite',
  'if [ ! -f "$DB" ]; then echo "nodb"; exit 0; fi',
  'if command -v sqlite3 >/dev/null 2>&1; then',
  '  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" || true',
  '  sqlite3 "$DB" ".backup \'$DB.sb-snap\'"',
  '  mv -f "$DB.sb-snap" "$DB.sb-backup"',
  '  chmod 0644 "$DB.sb-backup"',
  '  echo "ok"',
  '  exit 0',
  'fi',
  // No sqlite3 in this image: stream the live DB out through the container's own
  // uid into a host-readable sidecar. Written to a scratch name and moved into
  // place so a half-written copy is never staged.
  'cat "$DB" > "$DB.sb-snap"',
  'mv -f "$DB.sb-snap" "$DB.sb-backup"',
  'chmod 0644 "$DB.sb-backup"',
  'echo "live"',
].join('\n');

/** What a collector run produced. */
export interface CollectorResult {
  /** The manifest to stage — possibly remapped onto the snapshot the collector
   *  wrote. */
  manifest: ServiceBackupManifest;
  /**
   * False when what will be staged is a LIVE copy rather than a torn-free
   * snapshot (#2877): the copy was taken while the service could still be
   * writing, so a restore from it may be missing the most recent committed
   * writes. Recorded in the backup meta so a restore knows what it has.
   */
  consistent: boolean;
}

/**
 * Run a manifest's `collector` (in-container snapshot) before the config is
 * staged. Returns the possibly-rewritten manifest plus whether the staged copy
 * is a consistent snapshot; never throws — a collector that could not run says
 * so in the log, and the staging side decides whether the service degrades
 * (sqlite: copy the live file) or fails (pg-dump: there is nothing safe to fall
 * back to, so the worker reports the service as an error rather than shipping a
 * backup without its database).
 */
export async function runBackupCollector(
  manifest: ServiceBackupManifest,
  node: string,
): Promise<CollectorResult> {
  const collector = manifest.collector;
  if (collector?.kind === 'pg-dump') {
    return { manifest: await runPgDumpCollector(manifest, collector, node), consistent: true };
  }
  return runNpmSqliteCollector(manifest, node);
}

/** The snapshot script's sentinel, or null when it did not complete. A failure
 *  is logged here with the REAL reason — the container's stderr first, then any
 *  stdout, before "(unknown)" (#1894). */
function readSnapshotSentinel(res: unknown): 'ok' | 'live' | 'nodb' | null {
  const out = ((res as { stdout?: string }).stdout || '').trim();
  const errOut = ((res as { stderr?: string }).stderr || '').trim();
  const code = (res as { code?: number }).code;
  if (code === 0 && (out === 'ok' || out === 'live' || out === 'nodb')) return out;
  logger.warn(
    'ExternalBackup',
    `NPM sqlite snapshot failed (${errOut || out || 'unknown'}) — backing up database.sqlite as-is`,
  );
  return null;
}

/**
 * NPM: snapshots the live `database.sqlite` to `database.sqlite.sb-backup` on
 * disk from inside the container, then remaps the manifest's
 * `data/database.sqlite` include to that snapshot path so the copy is staged
 * under the original name.
 *
 * Two grades of snapshot, both taken container-side (see
 * {@link NPM_SQLITE_SNAPSHOT_SH}): a torn-free `sqlite3 .backup` when the image
 * has sqlite3, otherwise a live `cat` — which is what makes the difference
 * between "inconsistent" and "not backed up at all" on the jc21 image (#2877).
 * Best-effort: if neither can be taken the original manifest comes back and the
 * staging copies the live host file (which is where the EACCES used to be).
 */
async function runNpmSqliteCollector(
  manifest: ServiceBackupManifest,
  node: string,
): Promise<CollectorResult> {
  if (manifest.collector?.kind !== 'npm-sqlite') return { manifest, consistent: true };
  try {
    const agent = await agentManager.ensureAgent(node);
    const find = await agent.sendCommand('exec', {
      command: `podman ps --format '{{.Names}} {{.Image}}' | awk '/proxy-manager/{print $1; exit}'`,
    }, { timeoutMs: 15_000 });
    const container = ((find as { stdout?: string }).stdout || '').trim().split(/\s+/)[0];
    if (!container) {
      logger.warn('ExternalBackup', 'NPM container not found — backing up database.sqlite as-is (may be inconsistent)');
      return { manifest, consistent: false };
    }
    const b64 = Buffer.from(NPM_SQLITE_SNAPSHOT_SH).toString('base64');
    const res = await agent.sendCommand('exec', {
      command: `echo ${b64} | base64 -d | podman exec -i ${container} sh -`,
    }, { timeoutMs: 30_000 });
    const sentinel = readSnapshotSentinel(res);
    if (!sentinel) return { manifest, consistent: false };
    if (sentinel === 'live') {
      // The image has no sqlite3, so there is no way to checkpoint the WAL or
      // take an online `.backup`. The live copy IS the backup — say so plainly
      // rather than letting the meta imply a torn-free snapshot (#2877).
      logger.warn(
        'ExternalBackup',
        'NPM image has no sqlite3 — took a LIVE container-side copy of database.sqlite instead ' +
          '(marked consistent:false; writes still in the -wal sidecar are not in it). ' +
          'A host-side copy is not an option: the live file is root-owned 0600 and the backup worker cannot read it.',
      );
    }
    // Stage the snapshot in place of the live DB, under the original rel path.
    return {
      manifest: {
        ...manifest,
        include: manifest.include.map(p => (p === 'data/database.sqlite' ? 'data/database.sqlite.sb-backup' : p)),
        renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
      },
      // `nodb` remaps too (the never-created sidecar is a no-op at staging) and
      // is not an inconsistent copy — there was nothing to copy.
      consistent: sentinel !== 'live',
    };
  } catch (e) {
    logger.warn('ExternalBackup', `NPM sqlite snapshot errored (${e instanceof Error ? e.message : String(e)}) — backing up database.sqlite as-is`);
    return { manifest, consistent: false };
  }
}

/** Same default the producer and the worker service use for the host stacks
 *  root when `templateSettings.DATA_DIR` is unset. */
const DEFAULT_STACKS_DIR = '/mnt/data/stacks';
/** A `pg_dump` of a media-service database is minutes, not seconds. */
const PG_DUMP_TIMEOUT_MS = 10 * 60_000;


type ExecAgent = {
  sendCommand: (op: string, args: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
};

/** Structured agent exec (`safe_exec`): the argv reaches the host verbatim, so
 *  a container/user/database name out of a foreign template's manifest is never
 *  shell-parsed. No shell string, and no credential — `pg_dump` authenticates
 *  over the container's local socket as its own superuser. */
async function safeExec(
  agent: ExecAgent,
  argv: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const res = await agent.sendCommand('safe_exec', { argv }, { timeoutMs }) as {
    stdout?: string; stderr?: string; code?: number;
  };
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.code ?? -1 };
}

/** The RUNNING container whose name matches `name` exactly. `podman ps --filter
 *  name=` is a substring match, so `paperless-db` would also answer for
 *  `paperless-db-restore-test` — dump the declared container or nothing. */
async function findRunningContainer(agent: ExecAgent, name: string): Promise<string | null> {
  const found = await safeExec(
    agent,
    ['podman', 'ps', '--filter', `name=${name}`, '--format', '{{.Names}}'],
    15_000,
  );
  return found.stdout.split('\n').map(l => l.trim()).find(l => l === name) ?? null;
}

/**
 * `pg_dump` in the container, then `podman cp` the archive out to `hostDump`.
 * Returns false (having logged the real reason) when either step failed, so the
 * caller leaves the manifest un-remapped and no dump is staged. The
 * container-side scratch file is removed either way.
 */
async function dumpPostgresToHost(
  agent: ExecAgent,
  container: string,
  collector: PgDumpCollector,
  containerPath: string,
  hostDump: string,
): Promise<boolean> {
  // Custom format: compressed, and `pg_restore --clean --if-exists` can rebuild
  // the database from it (see the module docblock for the restore recipe).
  const dump = await safeExec(
    agent,
    [
      'podman', 'exec', container,
      'pg_dump',
      '--username', collector.user,
      '--dbname', collector.database,
      '--format=custom',
      '--file', containerPath,
    ],
    PG_DUMP_TIMEOUT_MS,
  );
  const cleanup = ['podman', 'exec', container, 'rm', '-f', containerPath];
  if (dump.code !== 0) {
    logger.warn('ExternalBackup', `pg_dump failed in "${container}" (${dump.stderr.trim() || dump.stdout.trim() || 'unknown'}) — no dump staged`);
    await safeExec(agent, cleanup, 30_000);
    return false;
  }
  await safeExec(agent, ['mkdir', '-p', path.dirname(hostDump)], 30_000);
  const copy = await safeExec(
    agent,
    ['podman', 'cp', `${container}:${containerPath}`, hostDump],
    PG_DUMP_TIMEOUT_MS,
  );
  await safeExec(agent, cleanup, 30_000);
  if (copy.code !== 0) {
    logger.warn('ExternalBackup', `pg-dump copy out of "${container}" failed (${copy.stderr.trim() || 'unknown'}) — no dump staged`);
    return false;
  }
  return true;
}

/**
 * `pg_dump` in the service's own Postgres container (#2864).
 *
 * The dump is written to the container's `/tmp`, copied out into the service
 * data dir as `<dumpPath>.sb-dump`, and staged under `<dumpPath>`; `pgdata/` is
 * excluded by {@link pgDumpRemap} regardless of what the manifest declared. A
 * previous run's dump is deleted FIRST, so a failed dump can never be shipped as
 * if it were today's — the worker then finds no dump and reports the service as
 * failed instead of silently shipping a backup without its database.
 */
async function runPgDumpCollector(
  manifest: ServiceBackupManifest,
  collector: PgDumpCollector,
  node: string,
): Promise<ServiceBackupManifest> {
  const problems = pgDumpCollectorProblems(manifest);
  if (problems.length > 0) {
    logger.warn('ExternalBackup', `pg-dump collector for "${manifest.service}" is misconfigured — no dump taken: ${problems.join('; ')}`);
    return manifest;
  }
  const paths = pgDumpPaths(collector);
  const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
  const hostDump = path.join(dataDir, manifest.dataSubdir ?? manifest.service, paths.stagedRel);
  try {
    const agent = await agentManager.ensureAgent(node);
    // Stale dump out of the way before anything can fail (see the docblock).
    await safeExec(agent, ['rm', '-f', hostDump], 30_000);
    const container = await findRunningContainer(agent, collector.container);
    if (!container) {
      logger.warn('ExternalBackup', `pg-dump collector: Postgres container "${collector.container}" is not running — no dump taken for "${manifest.service}"`);
      return manifest;
    }
    if (!(await dumpPostgresToHost(agent, container, collector, paths.containerPath, hostDump))) {
      return manifest;
    }
    logger.info('ExternalBackup', `pg-dump collector staged ${paths.dumpRel} for "${manifest.service}" (${paths.pgdataRel}/ excluded)`);
    return pgDumpRemap(manifest);
  } catch (e) {
    logger.warn('ExternalBackup', `pg-dump collector errored for "${manifest.service}" (${e instanceof Error ? e.message : String(e)}) — no dump staged`);
    return manifest;
  }
}
