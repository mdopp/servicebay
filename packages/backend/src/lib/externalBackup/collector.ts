/**
 * Backup collectors — the in-container snapshot step a manifest can declare to
 * run BEFORE the config is staged (#1894). Extracted from producer.ts so both the
 * producer (local-seed path) and the backup-worker orchestration can run a
 * collector without a circular import (producer ↔ backupWorker/service).
 *
 * Two collectors exist:
 *
 *  - `npm-sqlite` — NPM's sqlite snapshot: a torn-free `sqlite3 .backup` taken
 *    inside the running NPM container when the image can do it, otherwise a LIVE
 *    `podman cp` of `/data/database.sqlite` out of the container. Either way the
 *    result is `database.sqlite.sb-backup` on disk, which the worker / producer
 *    stages under the canonical `database.sqlite` name (via the manifest's
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

// Runs inside the NPM container: a torn-free snapshot of the live WAL-mode
// /data/database.sqlite to /data/database.sqlite.sb-backup, which the worker then
// stages under the canonical name.
//
// This is the PREFERRED path — sqlite3's online `.backup`. Since #1679 the live DB
// runs in WAL mode, so committed writes can sit in the `-wal` sidecar rather than
// the main file. We first `wal_checkpoint(TRUNCATE)` to fold the WAL back into the
// main DB and truncate the sidecar, then take the online `.backup` (itself
// WAL-aware) into a single self-contained file.
//
// It only works when the image HAS sqlite3 and the container's exec user can READ
// /data/database.sqlite. The jc21 NPM image satisfies neither (#2877): it ships no
// sqlite3, and `podman exec` into that pod does not land as the file's uid-mapped
// owner, so even a plain `cat` comes back "Permission denied". Both of those exit
// this script without a snapshot, and the caller falls back to `podman cp` — a
// primitive that reads through podman's own storage layer and therefore does not
// depend on in-container permissions at all (the pg-dump collector below already
// copies its archive out that way).
const NPM_SQLITE_SNAPSHOT_SH = [
  'set -e',
  'DB=/data/database.sqlite',
  'if [ ! -f "$DB" ]; then echo "nodb"; exit 0; fi',
  'if ! command -v sqlite3 >/dev/null 2>&1; then echo "nosqlite3"; exit 0; fi',
  'sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" || true',
  'sqlite3 "$DB" ".backup \'$DB.sb-snap\'"',
  'mv -f "$DB.sb-snap" "$DB.sb-backup"',
  'chmod 0644 "$DB.sb-backup"',
  'echo "ok"',
].join('\n');

/** Where the npm-sqlite collector's snapshot lands, relative to the service data
 *  dir — the same rel path the worker's `applyCollectorRemap` looks for. */
const NPM_SNAPSHOT_REL = 'data/database.sqlite.sb-backup';
/** The live DB inside the NPM container. */
const NPM_DB_CONTAINER_PATH = '/data/database.sqlite';
/** A `podman cp` of a proxy-host/cert DB is megabytes, not gigabytes. */
const NPM_CP_TIMEOUT_MS = 2 * 60_000;

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
 *  stdout, before "(unknown)" (#1894). `nosqlite3` is NOT a failure: it is the
 *  expected answer from the jc21 image and routes to the `podman cp` fallback. */
function readSnapshotSentinel(res: unknown): 'ok' | 'nodb' | 'nosqlite3' | null {
  const out = ((res as { stdout?: string }).stdout || '').trim();
  const errOut = ((res as { stderr?: string }).stderr || '').trim();
  const code = (res as { code?: number }).code;
  if (code === 0 && (out === 'ok' || out === 'nodb' || out === 'nosqlite3')) return out;
  logger.warn(
    'ExternalBackup',
    `NPM sqlite snapshot failed (${errOut || out || 'unknown'}) — falling back to a podman cp of the live DB`,
  );
  return null;
}

/** The manifest with `data/database.sqlite` swapped for the snapshot the
 *  collector wrote, staged back under the canonical name. */
function npmSqliteRemap(manifest: ServiceBackupManifest): ServiceBackupManifest {
  return {
    ...manifest,
    include: manifest.include.map(p => (p === 'data/database.sqlite' ? NPM_SNAPSHOT_REL : p)),
    renames: { [NPM_SNAPSHOT_REL]: 'data/database.sqlite' },
  };
}

/**
 * Copy the live DB out of the container with `podman cp` (#2877, fix-forward).
 *
 * This is the primitive that does NOT depend on in-container permissions: podman
 * reads the file through its own storage layer as the podman user, so it works
 * even though `podman exec … cat /data/database.sqlite` in this pod answers
 * "Permission denied".
 *
 * No `chmod` afterwards (#2882). Rootless `podman cp` lands the copy owned by the
 * podman user (`core`) — the very host identity the backup worker's
 * container-root maps to (see `packages/backup-worker/Containerfile`) — so the
 * 0600 copy is already worker-readable, box-proven by a 13/13 run whose worker
 * remapped onto this sidecar and reported no unreadable file while the chmod
 * never ran. And `chmod` is not on the agent's `SAFE_EXEC_ALLOWLIST`, so issuing
 * it made `safe_exec` reject — turning a snapshot that was on disk and already
 * staged into a logged "errored — as-is".
 *
 * The copy is LIVE (no checkpoint is possible without sqlite3), so the caller
 * records it `consistent: false`.
 */
async function copyLiveDbOutOfContainer(
  agent: ExecAgent,
  container: string,
  hostSnap: string,
): Promise<boolean> {
  await safeExec(agent, ['mkdir', '-p', path.dirname(hostSnap)], 30_000);
  const copy = await safeExec(
    agent,
    ['podman', 'cp', `${container}:${NPM_DB_CONTAINER_PATH}`, hostSnap],
    NPM_CP_TIMEOUT_MS,
  );
  if (copy.code !== 0) {
    logger.warn('ExternalBackup', `podman cp of NPM's database.sqlite out of "${container}" failed (${copy.stderr.trim() || copy.stdout.trim() || 'unknown'}) — no snapshot staged`);
    return false;
  }
  return true;
}

/**
 * NPM: snapshots the live `database.sqlite` to `database.sqlite.sb-backup` on
 * disk, then remaps the manifest's `data/database.sqlite` include to that
 * snapshot path so the copy is staged under the original name.
 *
 * Two grades of snapshot: a torn-free in-container `sqlite3 .backup` when the
 * image has sqlite3 AND the exec user can read the DB, otherwise a LIVE
 * `podman cp` out of the container — which is what makes the difference between
 * "inconsistent" and "not backed up at all" on the jc21 image (#2877).
 *
 * A STALE snapshot is removed before anything can fail, so a failed run can never
 * ship yesterday's database as if it were today's (the worker remaps on the mere
 * presence of the sidecar). If neither grade can be taken, the original manifest
 * comes back: the staging then finds the live host file unreadable and records it
 * as a skipped file rather than failing the whole service.
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
    const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
    const hostSnap = path.join(dataDir, manifest.dataSubdir ?? manifest.service, NPM_SNAPSHOT_REL);
    // Stale snapshot out of the way BEFORE anything can fail (see the docblock).
    await safeExec(agent, ['rm', '-f', hostSnap], 30_000);
    const b64 = Buffer.from(NPM_SQLITE_SNAPSHOT_SH).toString('base64');
    const res = await agent.sendCommand('exec', {
      command: `echo ${b64} | base64 -d | podman exec -i ${container} sh -`,
    }, { timeoutMs: 30_000 });
    const sentinel = readSnapshotSentinel(res);
    // `nodb` remaps too (the never-created sidecar is a no-op at staging) and is
    // not an inconsistent copy — there was nothing to copy.
    if (sentinel === 'ok' || sentinel === 'nodb') return { manifest: npmSqliteRemap(manifest), consistent: true };
    // No sqlite3, or the exec user cannot read the DB. Either way the snapshot
    // must not depend on in-container permissions — copy it out through podman.
    if (await copyLiveDbOutOfContainer(agent, container, hostSnap)) {
      // INFO, not WARN (#2882): on the jc21 image this is the EXPECTED grade of
      // snapshot, and it succeeded — a healthy run must not cry wolf. The
      // `consistent:false` in the meta is what records the live-copy caveat.
      logger.info(
        'ExternalBackup',
        'NPM: no in-container sqlite3 snapshot was possible — staged a LIVE `podman cp` snapshot of database.sqlite instead ' +
          '(marked consistent:false; writes still in the -wal sidecar are not in it). ' +
          'A host-side copy is not an option: the live file is root-owned 0600 and the backup worker cannot read it.',
      );
      return { manifest: npmSqliteRemap(manifest), consistent: false };
    }
    logger.warn(
      'ExternalBackup',
      'NPM: no snapshot of database.sqlite could be taken — the live host file is root-owned 0600, so the backup ' +
        'worker will skip it and nginx ships WITHOUT its proxy-host/cert database.',
    );
    return { manifest, consistent: false };
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
