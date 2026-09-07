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
 * staged. Returns a possibly-rewritten manifest; never throws — a collector
 * that could not run says so in the log, and the staging side decides whether
 * the service degrades (sqlite: copy the live file) or fails (pg-dump: there is
 * nothing safe to fall back to, so the worker reports the service as an error
 * rather than shipping a backup without its database).
 */
export async function runBackupCollector(
  manifest: ServiceBackupManifest,
  node: string,
): Promise<ServiceBackupManifest> {
  const collector = manifest.collector;
  if (collector?.kind === 'pg-dump') return runPgDumpCollector(manifest, collector, node);
  return runNpmSqliteCollector(manifest, node);
}

/**
 * NPM: takes a consistent `sqlite3 .backup` of the live database.sqlite to
 * `database.sqlite.sb-backup` on disk, then remaps the manifest's
 * `data/database.sqlite` include to that snapshot path so the consistent copy is
 * staged under the original name. Best-effort: if the snapshot can't be taken
 * the original manifest is returned (the staging copies the live file and logs).
 */
async function runNpmSqliteCollector(
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
