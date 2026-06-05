/**
 * Per-service config-backup producer for the FritzBox-NAS config-survival
 * feature (#1190 / #1216).
 *
 * Given a service, it reads the config files the manifest marks as worth
 * preserving (include − exclude), applies the strip rules (e.g. drop password
 * hashes), packs them into `<service>.tar`, and writes the tar plus a
 * `<service>.tar.meta.json` sidecar to `sb-backup/` on the NAS. The read-back
 * helpers (list + fetch) are what the restore flow (#1218) builds on.
 *
 * The tarball is built from a staging directory we fully control, so the
 * archive is safe by construction — the hardening that `systemBackup` applies
 * on *extraction* belongs to the restore path, not here.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
// `node:` prefix so a stray browser-polyfill in the SSR module graph can't
// shadow child_process with a no-op stub (see systemBackup.ts for the full
// story) — that would make every tar come back empty without tests noticing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../config';
import { logger } from '../logger';
import { agentManager } from '../agent/manager';
import { getExecutor, type Executor } from '../executor';
import { nasUpload, nasDownload, nasList } from './nasClient';
import {
  getServiceManifest,
  getBackupGate,
  applyStripRules,
  applyTransformRules,
  SERVICE_BACKUP_MANIFESTS,
  type ServiceBackupManifest,
} from './serviceManifest';

const execFileAsync = promisify(execFile);

/** Directory on the NAS (relative to its root) holding all service backups. */
export const NAS_BACKUP_DIR = 'sb-backup';

/** Default on-disk location of the per-service stack dirs. */
const DEFAULT_STACKS_DIR = '/mnt/data/stacks';

/** Sidecar schema version — bump when the meta shape changes. */
const META_SCHEMA_VERSION = 1;

export interface ServiceBackupMeta {
  service: string;
  schemaVersion: number;
  /** ISO timestamp the tar was produced. */
  createdAt: string;
  /** Hostname of the node that produced the backup — survives a reinstall to
   *  tell the operator which box the config came from. */
  nodeId: string;
}

export interface ServiceBackupResult {
  service: string;
  tarName: string;
  metaName: string;
  /** Tar size in bytes. */
  size: number;
  meta: ServiceBackupMeta;
}

export interface ServiceBackupListEntry {
  service: string;
  tarName: string;
  size: number;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The few filesystem primitives the staging + tar-building logic needs, so the
 * SAME selection/exclude/strip/rename logic can run against either:
 *  - the **local** container filesystem (the `sb-config-upload` CLI seed in
 *    #1219 / the HA-OS import #1353, which extract to a container-local temp
 *    dir), or
 *  - the **host** filesystem via the node agent (#1597 — the box backup reads
 *    `/mnt/data/stacks/<service>`, which is NOT bind-mounted into the
 *    servicebay container; only the host agent can see it, the same way
 *    install/restore/deploy reach the stacks).
 *
 * Source reads and the staging dir both live on whichever side the backend
 * targets; the resulting tar bytes are always returned to the caller (the
 * container) for upload to the NAS.
 */
export interface BackupFileBackend {
  /** Directory entries with their type (no recursion). */
  readdirTypes(dir: string): Promise<{ name: string; isDir: boolean; isFile: boolean }[]>;
  exists(target: string): Promise<boolean>;
  isDirectory(target: string): Promise<boolean>;
  /** Read a text (config) file — only ever called for strip-rule targets. */
  readText(target: string): Promise<string>;
  /** Copy a file byte-for-byte (binary-safe — sqlite, certs, …). */
  copyFile(src: string, dest: string): Promise<void>;
  writeText(dest: string, content: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  /** Make a fresh staging dir on this backend's side, return its path. */
  makeStagingDir(): Promise<string>;
  /** Tar the staging dir's contents and return the bytes to the container. */
  tarStagingDir(stagingDir: string): Promise<Buffer>;
  rmrf(target: string): Promise<void>;
}

/** Local-filesystem backend — the in-container path (CLI seed / HA-OS import). */
const localFileBackend: BackupFileBackend = {
  async readdirTypes(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
  },
  exists: pathExists,
  async isDirectory(target) {
    return (await fs.stat(target)).isDirectory();
  },
  readText: target => fs.readFile(target, 'utf8'),
  copyFile: (src, dest) => fs.copyFile(src, dest),
  writeText: (dest, content) => fs.writeFile(dest, content),
  mkdirp: async dir => {
    await fs.mkdir(dir, { recursive: true });
  },
  makeStagingDir: () => fs.mkdtemp(path.join(os.tmpdir(), 'sb-svcbackup-')),
  async tarStagingDir(stagingDir) {
    const tarPath = path.join(os.tmpdir(), `sb-svcbackup-${process.pid}-${Date.now()}.tar`);
    try {
      await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.']);
      return await fs.readFile(tarPath);
    } finally {
      await fs.rm(tarPath, { force: true });
    }
  },
  rmrf: async target => {
    await fs.rm(target, { recursive: true, force: true });
  },
};

/**
 * Host-agent backend (#1597) — reads/stages on the HOST via the node agent, so
 * it sees `/mnt/data/stacks/<service>` (not mounted into the servicebay
 * container). The staging dir + tar are built host-side; only the final tar
 * bytes cross back into the container (base64 over the agent channel, since the
 * agent's `read_file` is utf-8-only and would corrupt binary config).
 */
export function agentFileBackend(executor: Executor): BackupFileBackend {
  return {
    async readdirTypes(dir) {
      // `find -maxdepth 1` with a type tag per entry — one round-trip, and it
      // distinguishes files from dirs without a stat-per-entry storm.
      const { stdout } = await executor.execArgv([
        'find', dir, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\t%f\n',
      ]);
      return stdout
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
          const [type, ...rest] = l.split('\t');
          const name = rest.join('\t');
          return { name, isDir: type === 'd', isFile: type === 'f' };
        });
    },
    exists: target => executor.exists(target),
    async isDirectory(target) {
      // `test -d` exits non-zero (→ execArgv throws) for a non-dir.
      return executor.execArgv(['test', '-d', target]).then(() => true, () => false);
    },
    readText: target => executor.readFile(target),
    async copyFile(src, dest) {
      await executor.execArgv(['cp', '-p', src, dest]);
    },
    writeText: (dest, content) => executor.writeFile(dest, content),
    async mkdirp(dir) {
      await executor.execArgv(['mkdir', '-p', dir]);
    },
    async makeStagingDir() {
      const { stdout } = await executor.execArgv(['mktemp', '-d', '-t', 'sb-svcbackup-XXXXXX']);
      return stdout.trim();
    },
    async tarStagingDir(stagingDir) {
      // Tar host-side to a file, then read it back base64-encoded — no shell
      // pipe and no exec template-literal (each arg is execArgv-quoted). The
      // agent's read_file is utf-8-only, so base64 keeps binary config intact.
      const tarPath = `${stagingDir}.tar`;
      try {
        await executor.execArgv(['tar', '-cf', tarPath, '-C', stagingDir, '.'], { timeoutMs: 120_000 });
        const { stdout } = await executor.execArgv(['base64', tarPath], { timeoutMs: 120_000 });
        return Buffer.from(stdout.replace(/\s+/g, ''), 'base64');
      } finally {
        await executor.execArgv(['rm', '-f', tarPath]);
      }
    },
    async rmrf(target) {
      await executor.execArgv(['rm', '-rf', target]);
    },
  };
}

/** A relative path is excluded when it equals an exclude entry or lives under
 *  one (an exclude dir). Excludes always win over includes. */
function isExcluded(relPath: string, excludes: string[]): boolean {
  return excludes.some(ex => relPath === ex || relPath.startsWith(ex + '/'));
}

/**
 * Resolve a manifest include that may carry a trailing-`*` glob in its leaf
 * component (e.g. `.storage/lovelace*`, `.storage/hacs*`) to the concrete
 * relative paths that exist under `serviceDataDir`. HA names its dashboards
 * `.storage/lovelace.<url_path>` and HACS its data `.storage/hacs.repositories`
 * etc., so an exact include never matches them (#1595/#1596). A plain include
 * (no `*`) resolves to itself. Only a single trailing-`*` on the leaf is
 * supported — that's all the manifest needs, and it keeps the match a cheap
 * prefix test rather than a full glob engine.
 */
async function resolveIncludeGlob(
  backend: BackupFileBackend,
  serviceDataDir: string,
  include: string,
): Promise<string[]> {
  if (!include.includes('*')) return [include];
  const dir = path.posix.dirname(include);
  const leaf = path.posix.basename(include);
  if (leaf.indexOf('*') !== leaf.length - 1) {
    // Only a trailing-`*` leaf glob is supported; anything else is a manifest
    // authoring error — treat it as a literal (it simply won't exist → skipped).
    return [include];
  }
  const prefix = leaf.slice(0, -1);
  const parentAbs = path.join(serviceDataDir, dir);
  if (!(await backend.exists(parentAbs))) return [];
  const entries = await backend.readdirTypes(parentAbs);
  return entries
    .filter(e => e.name.startsWith(prefix))
    .map(e => path.posix.join(dir, e.name));
}

/** Walk an included directory, returning the relative (posix) paths of every
 *  file inside it that isn't excluded. */
async function collectDirFiles(
  backend: BackupFileBackend,
  serviceDataDir: string,
  relDir: string,
  excludes: string[],
): Promise<string[]> {
  const out: string[] = [];
  const entries = await backend.readdirTypes(path.join(serviceDataDir, relDir));
  for (const entry of entries) {
    const rel = path.posix.join(relDir, entry.name);
    if (isExcluded(rel, excludes)) continue;
    if (entry.isDir) {
      out.push(...(await collectDirFiles(backend, serviceDataDir, rel, excludes)));
    } else if (entry.isFile) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Copy the manifest-selected config files from `serviceDataDir` into
 * `stagingDir`, applying excludes and strip rules. Returns the sorted list of
 * relative paths actually staged. The `backend` decides whether source +
 * staging live in-container (local) or on the host via the agent (#1597) — the
 * selection logic is identical, and unit-testable on the local backend.
 */
export async function stageServiceBackup(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  stagingDir: string,
  backend: BackupFileBackend = localFileBackend,
): Promise<string[]> {
  const staged: string[] = [];
  // Expand any trailing-`*` glob includes (HA dashboards `.storage/lovelace*`,
  // HACS data `.storage/hacs*`) to the concrete paths on disk first.
  const includes: string[] = [];
  for (const include of manifest.include) {
    includes.push(...(await resolveIncludeGlob(backend, serviceDataDir, include)));
  }
  for (const include of includes) {
    if (isExcluded(include, manifest.exclude)) continue;
    const absInclude = path.join(serviceDataDir, include);
    if (!(await backend.exists(absInclude))) continue;
    const relFiles = (await backend.isDirectory(absInclude))
      ? await collectDirFiles(backend, serviceDataDir, include, manifest.exclude)
      : [include];
    for (const rel of relFiles) {
      // A collector may stage a snapshot file under a canonical name (e.g.
      // database.sqlite.sb-backup → database.sqlite) so restore lands it right.
      const tarRel = manifest.renames?.[rel] ?? rel;
      const dest = path.join(stagingDir, tarRel);
      await backend.mkdirp(path.dirname(dest));
      const needsRewrite =
        manifest.strip?.some(r => r.file === rel) ||
        manifest.transform?.some(r => r.file === rel);
      if (needsRewrite) {
        // Only read-as-text the files a strip/transform rule targets; everything
        // else is copied byte-for-byte so binary config (e.g. SQLite-ish blobs)
        // stays intact. Strip (key removal) then transform (value rewrite).
        const content = await backend.readText(path.join(serviceDataDir, rel));
        const stripped = applyStripRules(manifest, rel, content);
        await backend.writeText(dest, applyTransformRules(manifest, rel, stripped));
      } else {
        await backend.copyFile(path.join(serviceDataDir, rel), dest);
      }
      staged.push(tarRel);
    }
  }
  return staged.sort();
}

/**
 * Build a `<service>.tar` buffer from a service's config dir. With the default
 * local backend the dir is in-container; pass the agent backend (#1597) to read
 * + tar host-side and stream the bytes back.
 */
export async function buildServiceBackupTar(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  backend: BackupFileBackend = localFileBackend,
): Promise<Buffer> {
  const stagingDir = await backend.makeStagingDir();
  try {
    const staged = await stageServiceBackup(serviceDataDir, manifest, stagingDir, backend);
    if (staged.length === 0) {
      throw new Error(`No config files to back up for "${manifest.service}" under ${serviceDataDir}`);
    }
    return await backend.tarStagingDir(stagingDir);
  } finally {
    await backend.rmrf(stagingDir);
  }
}

/** Resolve a service's on-disk config dir from the configured DATA_DIR. Honors
 *  a manifest's `dataSubdir` override (NPM stores under `nginx-proxy-manager/`
 *  though its template/service name is `nginx`). */
export async function resolveServiceDataDir(service: string): Promise<string> {
  const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
  const subdir = getServiceManifest(service)?.dataSubdir ?? service;
  return path.join(dataDir, subdir);
}

// Runs inside the NPM container: a consistent snapshot of the live WAL-mode
// /data/database.sqlite to /data/database.sqlite.sb-backup using sqlite3's
// online `.backup`, then `mv` over the canonical name so the file-copy producer
// reads a torn-free copy. NPM's image bundles sqlite3.
//
// Since #1679 the live DB runs in WAL mode (the auth/nginx post-deploys flip
// `journal_mode=WAL`), so committed writes can sit in the `-wal` sidecar rather
// than the main file. We first `wal_checkpoint(TRUNCATE)` to fold the WAL back
// into the main DB and truncate the sidecar — so even a plain reader of
// database.sqlite would be consistent — then take the online `.backup` (itself
// WAL-aware) into a single self-contained file the producer stages under the
// canonical name. The checkpoint is best-effort (a busy DB may not fully
// checkpoint); `.backup` guarantees consistency regardless.
const NPM_SQLITE_SNAPSHOT_SH = [
  'set -e',
  "DB=/data/database.sqlite",
  'if [ ! -f "$DB" ]; then echo "nodb"; exit 0; fi',
  // Fold the WAL back into the main DB so the snapshot has no dependence on the
  // -wal/-shm sidecars. Best-effort: ignore a non-zero (busy) checkpoint.
  'sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" || true',
  // `.backup` produces a transactionally-consistent copy even mid-write.
  'sqlite3 "$DB" ".backup \'$DB.sb-snap\'"',
  'mv -f "$DB.sb-snap" "$DB.sb-backup"',
  'echo "ok"',
].join('\n');

/**
 * Run a manifest's `collector` (in-container snapshot) before the file-copy
 * producer reads the data dir. For NPM: takes a consistent `sqlite3 .backup`
 * of the live database.sqlite to `database.sqlite.sb-backup` on disk, then
 * remaps the manifest's `data/database.sqlite` include to that snapshot path so
 * the producer stages the consistent copy under the original name. Returns a
 * possibly-rewritten manifest. Best-effort: if the snapshot can't be taken the
 * original manifest is returned (the producer copies the live file and logs).
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
    if ((res as { code?: number }).code !== 0 || (out !== 'ok' && out !== 'nodb')) {
      logger.warn('ExternalBackup', `NPM sqlite snapshot failed (${out || 'unknown'}) — backing up database.sqlite as-is`);
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

/**
 * Produce a service's config tarball and write it (plus its meta sidecar) to
 * the NAS. Pass `serviceDataDir` to back up from an arbitrary location (the
 * `sb-config-upload` CLI in #1219 seeds from a non-SB source this way);
 * otherwise the dir is resolved from the configured DATA_DIR.
 */
export async function backupServiceToNas(
  service: string,
  opts: { serviceDataDir?: string; node?: string } = {},
): Promise<ServiceBackupResult> {
  let manifest = getServiceManifest(service);
  if (!manifest) {
    throw new Error(`No backup manifest for service "${service}"`);
  }
  // Run any in-container snapshot collector (e.g. NPM's consistent sqlite copy)
  // before reading the data dir — only for a live box backup, never for the
  // arbitrary-dir CLI seed (which has no running container to exec into).
  if (manifest.collector && !opts.serviceDataDir) {
    manifest = await runBackupCollector(manifest, opts.node || 'Local');
  }
  // An explicit serviceDataDir is a container-local source (CLI seed / HA-OS
  // import) → local fs backend. A box backup reads the stacks dir, which is NOT
  // mounted into the servicebay container, so it MUST go through the host agent
  // (#1597) — same path install/restore/deploy use.
  const serviceDataDir = opts.serviceDataDir ?? (await resolveServiceDataDir(service));
  const backend = opts.serviceDataDir
    ? localFileBackend
    : agentFileBackend(getExecutor(opts.node || 'Local'));
  const tar = await buildServiceBackupTar(serviceDataDir, manifest, backend);
  return writeServiceBackupToNas(service, tar);
}

/** One service's outcome in an on-demand backup-all run. */
export interface ServiceBackupRunEntry {
  service: string;
  ok: boolean;
  tarName?: string;
  size?: number;
  error?: string;
}

/**
 * On-demand "back up now" (#1217): back up every INSTALLED service that has a
 * backup manifest to the NAS, in one pass. Per-service failures are captured in
 * the result (one bad service doesn't abort the rest) — a NAS-not-configured /
 * connection error surfaces on the first attempt and repeats per service, which
 * the caller can detect (all `ok:false` with the same error).
 */
export async function backupInstalledServicesToNas(): Promise<ServiceBackupRunEntry[]> {
  const installed = new Set(Object.keys((await getConfig()).installedTemplates ?? {}));
  const results: ServiceBackupRunEntry[] = [];
  for (const manifest of SERVICE_BACKUP_MANIFESTS) {
    // A sibling-store entry (#1594) gates on its parent template, not its own
    // synthetic service name (which is never an installedTemplates key).
    if (!installed.has(getBackupGate(manifest))) continue;
    try {
      const r = await backupServiceToNas(manifest.service);
      results.push({ service: manifest.service, ok: true, tarName: r.tarName, size: r.size });
    } catch (e) {
      results.push({ service: manifest.service, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

// ─── Nightly scheduler (#1217) ───────────────────────────────────────
//
// Mirrors backup/service.ts scheduleBackup(): a self-rescheduling setTimeout
// that fires once per day at a fixed UTC time. Kept separate from the full
// systemBackup cron so the lightweight config push runs on its own slot
// (default 03:30 UTC, offset from the 02:00 snapshot to avoid contention).

let externalBackupTimer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_EXTERNAL_BACKUP_TIME = '03:30';

/**
 * Next daily run for the external NAS backup, as ms-from-now. Exported for the
 * scheduler test (the timer itself is awkward to assert directly).
 */
export function getNextExternalBackupDelayMs(time: string, now: Date = new Date()): number {
  const [hourStr, minuteStr] = (time || DEFAULT_EXTERNAL_BACKUP_TIME).split(':');
  const hour = Number(hourStr) || 0;
  const minute = Number(minuteStr) || 0;

  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(hour, minute);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  return next.getTime() - now.getTime();
}

/**
 * Schedule the nightly per-service config backup to the FritzBox NAS. Called
 * once at server startup (alongside scheduleBackup()). Self-reschedules after
 * each run. When the run fires but no NAS is configured, the producer reports
 * every service as `ok:false` with the "not configured" error — the cron logs
 * that and reschedules rather than throwing, so an unconfigured box quietly
 * no-ops until the gateway is set.
 */
export function scheduleExternalNasBackup(): void {
  if (externalBackupTimer) {
    clearTimeout(externalBackupTimer);
    externalBackupTimer = null;
  }

  getConfig()
    .then(appConfig => {
      const cfg = appConfig.externalBackup;
      // Defaults: enabled unless explicitly disabled (config-survival is the
      // safe default for a home box).
      if (cfg?.enabled === false) {
        logger.info('ExternalBackup', 'Nightly NAS config backup disabled');
        return;
      }

      const time = cfg?.time || DEFAULT_EXTERNAL_BACKUP_TIME;
      const delayMs = getNextExternalBackupDelayMs(time);
      const nextRun = new Date(Date.now() + delayMs);
      logger.info(
        'ExternalBackup',
        `Next nightly NAS config backup scheduled at ${nextRun.toISOString()} (in ${Math.round(delayMs / 60000)} min)`,
      );

      externalBackupTimer = setTimeout(async () => {
        try {
          const results = await backupInstalledServicesToNas();
          const ok = results.filter(r => r.ok).length;
          logger.info('ExternalBackup', `Nightly NAS config backup: ${ok}/${results.length} services backed up`);
        } catch (e) {
          logger.error('ExternalBackup', `Nightly NAS config backup failed: ${e}`);
        } finally {
          scheduleExternalNasBackup();
        }
      }, delayMs);
    })
    .catch(e => {
      logger.error('ExternalBackup', `Failed to schedule nightly NAS config backup: ${e}`);
    });
}

/**
 * Write an already-built `<service>.tar` buffer to the NAS in the canonical
 * restore layout (`sb-backup/<service>.tar` + `.meta.json`). Shared by the
 * dir-based producer (`backupServiceToNas`) and the upload route (#1351) so the
 * on-NAS format has a single source of truth.
 */
async function writeServiceBackupToNas(service: string, tar: Buffer): Promise<ServiceBackupResult> {
  const meta: ServiceBackupMeta = {
    service,
    schemaVersion: META_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    nodeId: os.hostname(),
  };
  const tarName = `${service}.tar`;
  const metaName = `${tarName}.meta.json`;

  await nasUpload(path.posix.join(NAS_BACKUP_DIR, tarName), tar);
  await nasUpload(
    path.posix.join(NAS_BACKUP_DIR, metaName),
    Buffer.from(JSON.stringify(meta, null, 2)),
  );

  logger.info('ExternalBackup', `Wrote ${tarName} to NAS (${tar.length} bytes)`);
  return { service, tarName, metaName, size: tar.length, meta };
}

/**
 * Stage an uploaded, already-container-shaped `<service>.tar` onto the NAS in
 * the restore layout (#1351). Lets the TUI / extractors seed a fresh install's
 * NAS from the operator's machine. The service must have a backup manifest (so
 * the restore flow knows how to consume it); the bytes are written verbatim
 * (box-side backups apply the whitelist/strip via the producer, while uploaded
 * archives are shaped by their own producer — e.g. the HA-OS extractor #1353).
 */
export async function stageUploadedServiceTar(service: string, tar: Buffer): Promise<ServiceBackupResult> {
  if (!getServiceManifest(service)) {
    throw new Error(`No backup manifest for service "${service}"`);
  }
  // A valid (GNU/ustar) tar is at least one 512-byte record; reject obviously
  // non-tar uploads early rather than writing garbage to the NAS.
  if (tar.length < 512) {
    throw new Error('uploaded archive is empty or not a tar');
  }
  return writeServiceBackupToNas(service, tar);
}

/** List the service backups currently on the NAS. */
export async function listServiceBackups(): Promise<ServiceBackupListEntry[]> {
  const files = await nasList(NAS_BACKUP_DIR);
  return files
    .filter(f => f.name.endsWith('.tar'))
    .map(f => ({ service: f.name.replace(/\.tar$/, ''), tarName: f.name, size: f.size }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * Fetch one backup tar (and its meta sidecar, if present) from the NAS for the
 * restore flow. A missing/corrupt sidecar resolves with `meta: null` rather
 * than failing — the tar is still restorable.
 */
export async function fetchServiceBackup(
  tarName: string,
): Promise<{ tar: Buffer; meta: ServiceBackupMeta | null }> {
  const safeName = path.posix.basename(tarName);
  if (!safeName.endsWith('.tar')) {
    throw new Error(`Not a service backup tar: "${tarName}"`);
  }
  const tar = await nasDownload(path.posix.join(NAS_BACKUP_DIR, safeName));
  let meta: ServiceBackupMeta | null = null;
  try {
    const metaBuf = await nasDownload(path.posix.join(NAS_BACKUP_DIR, `${safeName}.meta.json`));
    meta = JSON.parse(metaBuf.toString('utf8')) as ServiceBackupMeta;
  } catch {
    meta = null;
  }
  return { tar, meta };
}
