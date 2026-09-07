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
import { getConfig, updateConfig } from '../config';
import { logger } from '../logger';
import { nasUpload, nasDownload, nasList, nasRemove, withNasSession, isConnectionLevelError } from './nasClient';
import {
  applyStripRules,
  applyTransformRules,
  type ServiceBackupManifest,
} from '@servicebay/backup-manifest';
import { resolveServiceBackupManifest } from './templateManifests';
// Re-exported for back-compat: the collector moved to its own module to break the
// producer ↔ backupWorker/service import cycle (#1955).
export { runBackupCollector } from './collector';
// Re-exported so the `config_backup` probe can classify a recorded run message
// the same way the live run classifies an error (#2876), without reaching into
// the transport module itself.
export { isConnectionLevelError } from './nasClient';

const execFileAsync = promisify(execFile);

/** Directory on the NAS (relative to its root) holding all service backups. */
export const NAS_BACKUP_DIR = 'sb-backup';

/** Filename prefix of the `nas_backup_reachable` probe's write-test file. A
 *  failed write test leaves one behind, so the producer sweeps them (#2873). */
export const NAS_WRITE_TEST_PREFIX = '.sb-write-test-';

/**
 * Does this failure mean the destination ran out of room (#2873)?
 *
 * Deliberately NOT a bare `553` match: FTP reuses 553 for "permission denied"
 * and "illegal file name" too, and treating those as a full share would make
 * the producer delete other services' snapshots to fix a permissions problem.
 * So the trigger is either an explicit out-of-space phrase (what the FritzBox
 * sends alongside both 452 and 553) or a bare `452`, which is only ever
 * "insufficient storage space in system".
 */
const OUT_OF_SPACE_RE =
  /no space left|insufficient storage|not enough space|quota exceeded|disk (?:is )?full|\b452\b/i;

/** True when `error` reports the backup destination being out of space (#2873).
 *  Accepts an Error, a raw string (a recorded `lastMessage`), or anything else. */
export function isOutOfSpaceError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  return OUT_OF_SPACE_RE.test(message);
}

/** Slack added to the "how much must I free" estimate: the `.meta.json` sidecar
 *  plus the filesystem's own per-file overhead. */
const CAPACITY_SLACK_BYTES = 4096;

/**
 * A dated slot younger than this is treated as possibly still being written by a
 * concurrent run (the nightly cron and an on-demand "back up now" can overlap),
 * so the sweep leaves it alone. Anything older with no sidecar / zero bytes is a
 * genuinely abandoned partial upload.
 */
const SWEEP_GRACE_MS = 15 * 60_000;

/** Why a service has no manifest, since #2858: the declaration lives on the
 *  template, so "no manifest" now means the template did not declare one (or
 *  it was refused) — name that, so the operator knows where to look. */
const NO_MANIFEST = (service: string): string =>
  `No backup manifest for service "${service}" — its template declares no \`servicebay.backup\` ` +
  `(or the declaration was refused; see the ExternalBackup log).`;

/** Default on-disk location of the per-service stack dirs. */
const DEFAULT_STACKS_DIR = '/mnt/data/stacks';

/** Sidecar schema version — bump when the meta shape changes. */
const META_SCHEMA_VERSION = 1;

/**
 * How many dated snapshots to keep per service when none is configured (#1865).
 * The producer writes a new dated slot per run and prunes the oldest beyond this
 * — bounded so the NAS can't fill, but deep enough that a silently-corrupted run
 * (the HA empty-automations incident) still has a healthy prior copy to recover.
 */
export const DEFAULT_BACKUP_RETENTION = 7;

/**
 * Match a dated snapshot slot `<service>-YYYYMMDD-HHMM.tar` (#1865) and a bare
 * legacy single-slot `<service>.tar` (pre-#1865 backups, kept restorable so no
 * existing backup goes invisible). A service name may itself contain hyphens
 * (`home-assistant`), so the date stamp is anchored to the END of the name.
 */
const DATED_TAR_RE = /^(.+)-(\d{8}-\d{4})\.tar$/;
const BARE_TAR_RE = /^(.+)\.tar$/;

/** Format `Date` → the `YYYYMMDD-HHMM` UTC stamp used in a dated slot name. */
function backupStamp(when: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${when.getUTCFullYear()}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}` +
    `-${p(when.getUTCHours())}${p(when.getUTCMinutes())}`
  );
}

/**
 * Derive an ISO timestamp from a `YYYYMMDD-HHMM` UTC dated-slot stamp (#1890),
 * so the UI can show a "Created" column without fetching every `.meta.json`
 * sidecar. A null stamp (a bare legacy `<service>.tar`) has no embedded date →
 * null (the UI renders "—"). The sidecar's `createdAt` is the authoritative
 * source, but it's written from the same `Date` the stamp is, so the stamp is a
 * faithful, network-free derivation.
 */
function createdAtFromStamp(stamp: string | null): string | null {
  if (!stamp) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
}

/**
 * Parse a NAS tar filename into its service + (optional) dated stamp. A dated
 * slot resolves both; a bare legacy `<service>.tar` resolves the service with a
 * null stamp (so it sorts as the oldest / a valid undated snapshot). A non-tar
 * name returns null.
 */
function parseSlotName(name: string): { service: string; stamp: string | null } | null {
  const dated = DATED_TAR_RE.exec(name);
  if (dated) return { service: dated[1], stamp: dated[2] };
  const bare = BARE_TAR_RE.exec(name);
  if (bare) return { service: bare[1], stamp: null };
  return null;
}

export interface ServiceBackupMeta {
  service: string;
  schemaVersion: number;
  /** ISO timestamp the tar was produced. */
  createdAt: string;
  /** Hostname of the node that produced the backup — survives a reinstall to
   *  tell the operator which box the config came from. */
  nodeId: string;
  /**
   * False when the service's database was captured as a LIVE copy rather than a
   * torn-free snapshot (#2877) — e.g. NPM's `database.sqlite` on an image with
   * no `sqlite3`, where the alternative was no backup at all. Absent means the
   * copy is consistent (every backup written before this field existed).
   */
  consistent?: boolean;
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
  /** The `YYYYMMDD-HHMM` UTC stamp parsed from a dated slot, or null for a bare
   *  legacy `<service>.tar` (pre-#1865). Lets the UI label / order snapshots. */
  stamp: string | null;
  /** ISO timestamp the snapshot was created (#1890). Read from the `.meta.json`
   *  sidecar's `createdAt` when present; otherwise derived from the dated `stamp`
   *  (`YYYYMMDD-HHMM` UTC). Null for a bare legacy slot with no sidecar, which the
   *  UI renders as "—". */
  createdAt: string | null;
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
 * The few filesystem primitives the staging + tar-building logic needs. Only the
 * **local** container-filesystem backend remains (the `sb-config-upload` CLI seed
 * #1219 / the HA-OS import #1353, which extract a single uploaded archive into a
 * container-local temp dir — small, no OOM risk). The box backup's HEAVY host-side
 * walk/copy/tar moved into the resource-capped backup worker container (#1955,
 * backupWorker/) — the old host-agent backend that held every tar in this process
 * and OOM'd the box (#1894) is retired.
 *
 * The seam is kept so the local-seed path stays unit-testable; the staging tar
 * bytes are returned to the caller for upload to the NAS.
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
  /**
   * Copy MANY files (relative paths under `srcRoot`) into `destRoot`, preserving
   * their relative subdirs. `relFiles` are plain copies only; strip/transform/
   * renamed files are still staged individually (they need a content rewrite).
   */
  bulkCopyFiles(srcRoot: string, relFiles: string[], destRoot: string): Promise<void>;
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
  async bulkCopyFiles(srcRoot, relFiles, destRoot) {
    // Local fs: a plain per-file copy is already cheap (no agent round-trips),
    // so there's nothing to batch — just mkdirp + copy each.
    for (const rel of relFiles) {
      const dest = path.join(destRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(srcRoot, rel), dest);
    }
  },
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
  // Plain (byte-for-byte) copies are batched into one bulk operation per backend
  // (#1894) — the agent backend does them in a single host-side tar pipe instead
  // of a round-trip per file. Files that need a content rewrite (strip/transform)
  // or a rename are staged individually: they're few, and each needs a per-file
  // read/write or a distinct dest path that a bulk copy can't express.
  const plainCopies: string[] = [];
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
      const needsRewrite =
        manifest.strip?.some(r => r.file === rel) ||
        manifest.transform?.some(r => r.file === rel);
      const renamed = tarRel !== rel;
      if (needsRewrite) {
        // Only read-as-text the files a strip/transform rule targets; everything
        // else is copied byte-for-byte so binary config (e.g. SQLite-ish blobs)
        // stays intact. Strip (key removal) then transform (value rewrite).
        const dest = path.join(stagingDir, tarRel);
        await backend.mkdirp(path.dirname(dest));
        const content = await backend.readText(path.join(serviceDataDir, rel));
        const stripped = applyStripRules(manifest, rel, content);
        await backend.writeText(dest, applyTransformRules(manifest, rel, stripped));
      } else if (renamed) {
        // A renamed plain copy can't ride the bulk tar (its tarball path differs
        // from its source path) — stage it on its own.
        const dest = path.join(stagingDir, tarRel);
        await backend.mkdirp(path.dirname(dest));
        await backend.copyFile(path.join(serviceDataDir, rel), dest);
      } else {
        plainCopies.push(rel);
      }
      staged.push(tarRel);
    }
  }
  // One bulk copy for every byte-for-byte file (the OOM-causing bulk, e.g.
  // custom_components) — relative paths preserved under the staging dir.
  await backend.bulkCopyFiles(serviceDataDir, plainCopies, stagingDir);
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
 *  though its template/service name is `nginx`).
 *
 *  Throws for a VOLUME-held manifest (#2596): that service's state is in a
 *  podman named volume, not under DATA_DIR, so there is no such dir. Returning
 *  `<DATA_DIR>/<service>` instead would be the fail-open shape this whole gate
 *  exists to prevent — the restore/wipe callers would happily write config into
 *  a directory the service never reads, and report success. The backup side
 *  reads the volume through the worker (backupWorker/launcher.ts); the restore
 *  side has no equivalent yet and says so. */
export async function resolveServiceDataDir(service: string): Promise<string> {
  const manifest = await resolveServiceBackupManifest(service);
  if (manifest?.volume) {
    throw new Error(
      `"${service}" keeps its config in the podman volume "${manifest.volume}", not under DATA_DIR — ` +
      `it is backed up from the volume, but restoring into a named volume is not supported yet (#2596).`,
    );
  }
  const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
  const subdir = manifest?.dataSubdir ?? service;
  return path.join(dataDir, subdir);
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
  const manifest = await resolveServiceBackupManifest(service);
  if (!manifest) {
    throw new Error(NO_MANIFEST(service));
  }
  // A box backup (no serviceDataDir) reads the stacks dir host-side — the HEAVY
  // walk/copy/tar that OOM'd the control plane in-process (#1894). It now runs in
  // the resource-capped backup worker container (#1955); servicebay only launches
  // it, polls status, then streams the produced tar to the NAS.
  if (!opts.serviceDataDir) {
    const { runBackupForServices } = await import('../backupWorker/service');
    const completed = await runBackupForServices([service], opts.node || 'Local');
    const [entry] = await uploadBackupRun(completed);
    if (!entry || !entry.ok) {
      throw new Error(entry?.error ?? `No backup produced for "${service}"`);
    }
    return {
      service,
      tarName: entry.tarName ?? `${service}.tar`,
      metaName: `${entry.tarName ?? `${service}.tar`}.meta.json`,
      size: entry.size ?? 0,
      meta: { service, schemaVersion: META_SCHEMA_VERSION, createdAt: new Date().toISOString(), nodeId: os.hostname() },
    };
  }
  // An explicit serviceDataDir is a container-local source (CLI seed / HA-OS
  // import): the dir is already extracted in the servicebay container and is
  // small (one uploaded archive), so it's staged in-process on the local fs — the
  // worker can't see a container-local temp dir, and there's no OOM risk here.
  const tar = await buildServiceBackupTar(opts.serviceDataDir, manifest, localFileBackend);
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
 * Stream a completed worker run's tars to the NAS, one at a time (bounded I/O —
 * the control plane never holds them all), then remove the per-run out dir.
 * Returns the per-service entries (ok services on the NAS + the worker's skip/
 * error rollup). Shared by the per-service + back-up-all NAS paths (#1955).
 */
async function uploadBackupRun(
  completed: import('../backupWorker/service').BackupRun,
): Promise<ServiceBackupRunEntry[]> {
  const { readBackupTar, cleanupBackupRun } = await import('../backupWorker/service');
  const { exec, run, status } = completed;
  const results: ServiceBackupRunEntry[] = [];
  try {
    for (const r of status.results) {
      if (r.ok && r.tarName) {
        try {
          const tar = await readBackupTar(exec, run, r.tarName);
          const written = await writeServiceBackupToNas(r.service, tar, {
            consistent: !completed.inconsistent?.has(r.service),
          });
          results.push({ service: r.service, ok: true, tarName: written.tarName, size: written.size });
        } catch (e) {
          results.push({ service: r.service, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        // skip (no config on disk yet) or a per-service worker error — mirror the
        // old producer's per-service failure entry (one bad service doesn't abort).
        results.push({ service: r.service, ok: false, error: r.detail ?? 'No config files to back up' });
      }
    }
  } finally {
    await cleanupBackupRun(exec, run);
  }
  return results;
}

/**
 * On-demand "back up now" (#1217): back up every INSTALLED service that has a
 * backup manifest to the NAS, in one pass — now worker-backed (#1955). The heavy
 * multi-service walk/copy/tar runs in ONE backup-worker container; servicebay
 * launches it, polls the compact status, then streams each produced tar to the
 * NAS. The old in-process per-service agent file-copy held every tar in the
 * control plane and OOM'd the box (#1894). Per-service failures are captured in
 * the result (one bad service doesn't abort the rest).
 */
export async function backupInstalledServicesToNas(): Promise<ServiceBackupRunEntry[]> {
  const { runBackupForInstalled } = await import('../backupWorker/service');
  try {
    const completed = await runBackupForInstalled();
    // Nothing installed ships a manifest — a real, recordable 0/0 outcome, not
    // a success and not a failure. The probe names that state; recording it
    // here is what stops "never ran" and "had nothing to do" looking alike.
    //
    // ONE destination session for the whole upload phase (#2876): the sweep,
    // every per-service prune and every tar/meta upload share one FTP control
    // connection. A connection per call opened 50–70 sessions in ~10 s, which
    // tripped the FritzBox's session budget after ~8 services and left the same
    // tail of services unbacked-up every night.
    const results = completed ? await withNasSession(() => uploadBackupRun(completed)) : [];
    await recordExternalBackupRun(results);
    return results;
  } catch (e) {
    await recordExternalBackupRun([], e);
    throw e;
  }
}

/**
 * Persist the run's outcome to `config.externalBackup` (#2615) so the
 * `config_backup` diagnose probe can report last-run + freshness without
 * anyone reading the journal. Best-effort by construction: a config write that
 * fails must never turn a completed backup into a failed one, so it is logged
 * and swallowed — the probe then reports the previous (stale) run, which is
 * itself the honest answer.
 */
/**
 * The run's one-line outcome for `config.externalBackup.lastMessage`, with the
 * two failure classes told apart (#2876).
 *
 * A FritzBox that drops the control connection after ~8 services produced five
 * identical `connect ECONNREFUSED …` rows, one per remaining service — which
 * reads as "these five services are broken" and sends the operator to the wrong
 * fix. Connection-level failures are therefore summarised as ONE fact about the
 * destination, and only the genuine per-service errors are listed by name.
 * Exported for the unit test and for `recordExternalBackupRun`.
 */
export function summariseBackupRun(results: ServiceBackupRunEntry[]): string {
  const total = results.length;
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) return `${ok}/${total} services backed up`;
  const dropped = failed.filter(r => isConnectionLevelError(r.error));
  const perService = failed.filter(r => !isConnectionLevelError(r.error));
  const parts: string[] = [];
  if (dropped.length > 0) {
    parts.push(
      `The destination dropped the connection after ${ok} of ${total} services — ` +
        `${dropped.length} service(s) never got a write: ${dropped.map(r => r.service).join(', ')} ` +
        `(first error: ${dropped[0].error ?? 'no reason recorded'})`,
    );
  }
  if (perService.length > 0) {
    parts.push(
      `Not backed up: ${perService
        .slice(0, 5)
        .map(r => `${r.service} (${r.error ?? 'no reason recorded'})`)
        .join('; ')}`,
    );
  }
  return parts.join('. ');
}

async function recordExternalBackupRun(results: ServiceBackupRunEntry[], error?: unknown): Promise<void> {
  const total = results.length;
  const ok = results.filter(r => r.ok).length;
  const lastStatus = error ? 'error' : ok < total ? 'partial' : 'success';
  const lastMessage = error
    ? error instanceof Error ? error.message : String(error)
    : summariseBackupRun(results);
  try {
    const current = (await getConfig()).externalBackup;
    await updateConfig({
      externalBackup: {
        ...current,
        // Absent means enabled (config-survival is the safe default), so
        // materialising `true` here keeps the effective behaviour identical.
        enabled: current?.enabled ?? true,
        lastRun: new Date().toISOString(),
        lastStatus,
        lastMessage,
        servicesOk: ok,
        servicesTotal: total,
      },
    });
  } catch (e) {
    logger.warn('ExternalBackup', `Could not record the run outcome: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/** The nightly NAS-backup schedule, for surfacing the "when" on Settings →
 *  Backups (#1890). `nextRunAt` is null when disabled. */
export interface NasBackupSchedule {
  enabled: boolean;
  /** Daily run time, 24h `HH:MM` UTC. */
  time: string;
  /** ISO timestamp of the next scheduled run, or null when disabled. */
  nextRunAt: string | null;
}

/**
 * Resolve the nightly NAS-backup schedule from config (#1890) so the UI can show
 * the real configured time + next run instead of a vague "nightly". Derives the
 * next run from `getNextExternalBackupDelayMs` — the same source the scheduler
 * uses — so the surfaced time matches what actually fires.
 */
export async function getNasBackupSchedule(now: Date = new Date()): Promise<NasBackupSchedule> {
  const cfg = (await getConfig()).externalBackup;
  const enabled = cfg?.enabled !== false; // enabled unless explicitly disabled
  const time = cfg?.time || DEFAULT_EXTERNAL_BACKUP_TIME;
  if (!enabled) return { enabled: false, time, nextRunAt: null };
  const nextRunAt = new Date(now.getTime() + getNextExternalBackupDelayMs(time, now)).toISOString();
  return { enabled: true, time, nextRunAt };
}

/** Resolve the per-service retention (keep N most-recent) from config (#1865). */
async function getBackupRetention(): Promise<number> {
  const configured = (await getConfig()).externalBackup?.retention;
  return typeof configured === 'number' && configured > 0 ? Math.floor(configured) : DEFAULT_BACKUP_RETENTION;
}

/** Remove one snapshot: the tar AND its `.meta.json` sidecar (#1890), so a prune
 *  never leaves a sidecar behind to be swept later. */
async function removeSnapshot(tarName: string): Promise<void> {
  await nasRemove(path.posix.join(NAS_BACKUP_DIR, tarName));
  await nasRemove(path.posix.join(NAS_BACKUP_DIR, `${tarName}.meta.json`));
}

/** Is this dated slot young enough that a concurrent run may still be writing
 *  it? A bare legacy slot carries no stamp, so it is never "in flight". */
function withinSweepGrace(stamp: string | null, now: Date): boolean {
  const createdAt = createdAtFromStamp(stamp);
  if (!createdAt) return false;
  return Math.abs(now.getTime() - Date.parse(createdAt)) < SWEEP_GRACE_MS;
}

/** What the sweep should do with one file in `sb-backup/`. `partial` also
 *  condemns the file's sidecar, if it has one. */
type SweepVerdict = 'keep' | 'drop' | 'partial';

/** Classify one listed file. See {@link sweepNasBackupDir} for the four shapes
 *  and why "no sidecar" only condemns *dated* slots. */
function sweepVerdict(
  file: { name: string; size: number },
  present: (name: string) => boolean,
  now: Date,
): SweepVerdict {
  const { name } = file;
  if (name.startsWith(NAS_WRITE_TEST_PREFIX)) return 'drop';
  if (name.endsWith('.tar.meta.json')) {
    return present(name.slice(0, -'.meta.json'.length)) ? 'keep' : 'drop';
  }
  if (!name.endsWith('.tar')) return 'keep';
  const stamp = parseSlotName(name)?.stamp ?? null;
  if (withinSweepGrace(stamp, now)) return 'keep';
  const zeroLength = (file.size ?? 0) === 0;
  const datedWithoutSidecar = stamp !== null && !present(`${name}.meta.json`);
  return zeroLength || datedWithoutSidecar ? 'partial' : 'keep';
}

/**
 * Remove everything in `sb-backup/` that is not a restorable snapshot (#2873),
 * and return the snapshots that survive.
 *
 * A 452/553 mid-transfer leaves a partial (often zero-length) tar behind, and a
 * failed `nas_backup_reachable` write test leaves a `.sb-write-test-*` file —
 * neither is ever cleaned up today, so they accumulate on a share that is
 * already full. Four shapes are swept:
 *   - `.sb-write-test-*` probe leftovers,
 *   - a `.tar.meta.json` sidecar whose tar is gone (the tar is uploaded FIRST,
 *     so a lone sidecar is never an in-flight write),
 *   - a zero-length tar,
 *   - a **dated** tar with no sidecar — we always write the sidecar right after
 *     the tar, so a dated slot without one is an interrupted upload.
 * A bare legacy `<service>.tar` (pre-#1865) has no sidecar by construction and
 * stays restorable (#1865 semantics), so "no sidecar" only condemns dated slots.
 *
 * Best-effort by construction: a sweep failure is logged, never thrown — it must
 * not turn a backup that would otherwise succeed into a failure.
 */
async function sweepNasBackupDir(
  now: Date,
): Promise<{ removed: string[]; freedBytes: number; entries: ServiceBackupListEntry[] }> {
  const removed: string[] = [];
  let freedBytes = 0;
  let files: { name: string; size: number }[] = [];
  try {
    files = await nasList(NAS_BACKUP_DIR);
    const sizeOf = new Map(files.map(f => [f.name, f.size ?? 0]));
    const drop = async (name: string): Promise<void> => {
      await nasRemove(path.posix.join(NAS_BACKUP_DIR, name));
      removed.push(name);
      freedBytes += sizeOf.get(name) ?? 0;
    };
    const present = (name: string): boolean => sizeOf.has(name);
    for (const file of files) {
      const verdict = sweepVerdict(file, present, now);
      if (verdict === 'keep') continue;
      await drop(file.name);
      // A condemned tar takes its sidecar with it (the sidecar's own verdict
      // would be `drop` on the next run, but there is no reason to wait).
      if (verdict === 'partial' && present(`${file.name}.meta.json`)) {
        await drop(`${file.name}.meta.json`);
      }
    }
    if (removed.length > 0) {
      logger.info(
        'ExternalBackup',
        `Swept ${removed.length} partial/orphaned file(s) from ${NAS_BACKUP_DIR}/ ` +
          `(${freedBytes} bytes): ${removed.join(', ')}`,
      );
    }
  } catch (e) {
    logger.warn(
      'ExternalBackup',
      `Sweep of ${NAS_BACKUP_DIR}/ failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const gone = new Set(removed);
  return { removed, freedBytes, entries: toSnapshotEntries(files.filter(f => !gone.has(f.name))) };
}

/**
 * Free at least `needBytes` by pruning the OLDEST snapshots across ALL services
 * (#2873). Count-based per-service retention alone cannot keep a small share
 * within capacity — 12 services × 7 snapshots of whatever size each happens to
 * be can exceed the drive regardless of the count — so a full share is answered
 * by dropping the globally-oldest snapshots first.
 *
 * **Never drops a service's last remaining snapshot**: a service whose only copy
 * is deleted to make room for another service is a data-loss bug, not a prune.
 * If every service is down to one copy the target is simply too small, which the
 * caller reports as such. Best-effort: failures are logged, never thrown.
 */
async function pruneAcrossServices(needBytes: number): Promise<{ pruned: string[]; freedBytes: number }> {
  const pruned: string[] = [];
  let freedBytes = 0;
  try {
    const all = await listServiceBackups();
    // The listing is newest-first within a service, so the first entry seen for
    // a service is the one copy that must survive.
    const newestPerService = new Map<string, string>();
    for (const entry of all) {
      if (!newestPerService.has(entry.service)) newestPerService.set(entry.service, entry.tarName);
    }
    const candidates = all
      .filter(e => newestPerService.get(e.service) !== e.tarName)
      // Oldest first, across services. A bare legacy slot has no stamp and sorts
      // first — it is the oldest thing on the share by definition.
      .sort((a, b) => (a.stamp ?? '').localeCompare(b.stamp ?? ''));
    for (const entry of candidates) {
      if (freedBytes >= needBytes) break;
      await removeSnapshot(entry.tarName);
      pruned.push(entry.tarName);
      freedBytes += entry.size;
    }
    if (pruned.length > 0) {
      logger.info(
        'ExternalBackup',
        `Freed ${freedBytes} bytes for a ${needBytes}-byte write by pruning ${pruned.length} ` +
          `old snapshot(s) across services: ${pruned.join(', ')}`,
      );
    }
  } catch (e) {
    logger.warn(
      'ExternalBackup',
      `Cross-service prune failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { pruned, freedBytes };
}

/**
 * Prune dated snapshots for ONE service down to the `keep` most-recent (#1865),
 * removing each pruned tar's `.meta.json` sidecar too. A bare legacy
 * `<service>.tar` (pre-#1865) sorts oldest, so once `keep` dated slots exist it
 * is the first to be pruned — the rotated history supersedes the single slot.
 * Best-effort: a prune failure is logged, never thrown (it must not fail a
 * successful backup). Returns the names pruned.
 */
async function pruneServiceBackups(
  service: string,
  keep: number,
  known?: ServiceBackupListEntry[],
): Promise<string[]> {
  try {
    const all = known ?? (await listServiceBackups());
    const mine = all
      .filter(b => b.service === service)
      // Newest first: a real dated stamp beats a bare (null) slot; ties (only
      // possible across bare vs the impossible duplicate stamp) keep bare last.
      .sort((a, b) => (b.stamp ?? '').localeCompare(a.stamp ?? ''));
    const stale = mine.slice(keep);
    const pruned: string[] = [];
    for (const entry of stale) {
      await removeSnapshot(entry.tarName);
      pruned.push(entry.tarName);
    }
    if (pruned.length > 0) {
      logger.info('ExternalBackup', `Pruned ${pruned.length} old ${service} backup(s): ${pruned.join(', ')}`);
    }
    return pruned;
  } catch (e) {
    logger.warn('ExternalBackup', `Retention prune for "${service}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Write an already-built `<service>.tar` buffer to the NAS as a NEW dated slot
 * (`sb-backup/<service>-YYYYMMDD-HHMM.tar` + `.meta.json`) rather than
 * overwriting one slot, then prune to the retention policy (#1865). Keeping
 * dated/rotated copies is what lets a restore recover from a silently-corrupted
 * run (the HA empty-automations incident) instead of only the latest state.
 * Shared by the dir-based producer (`backupServiceToNas`) and the upload route
 * (#1351) so the on-NAS format has a single source of truth.
 *
 * Room is made BEFORE the upload, not only after it (#2873). The old order —
 * upload, then prune — meant a full share was a permanent lockout: the upload
 * threw, so the prune that would have freed the space was never reached, every
 * night, for every service. Now each write sweeps the partial/orphaned files,
 * prunes this service to `keep - 1` (so the new snapshot lands on budget), and
 * — if the destination still reports itself full — prunes the oldest snapshots
 * across ALL services and retries once.
 */
async function writeServiceBackupToNas(
  service: string,
  tar: Buffer,
  opts: { consistent?: boolean } = {},
): Promise<ServiceBackupResult> {
  const now = new Date();
  const meta: ServiceBackupMeta = {
    service,
    schemaVersion: META_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    nodeId: os.hostname(),
    // Only recorded when it is FALSE: a restore reading an older meta (or any
    // service without a collector) must keep reading as "consistent".
    ...(opts.consistent === false ? { consistent: false } : {}),
  };
  const tarName = `${service}-${backupStamp(now)}.tar`;
  const metaName = `${tarName}.meta.json`;
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2));
  const keep = await getBackupRetention();

  // Make room first. Both steps are best-effort (they swallow their own
  // failures): a prune that cannot run must never fail a backup that could
  // otherwise succeed. Pruning to `keep - 1` leaves exactly `keep` once this
  // write lands, and never below 1 — so a failed upload can't leave a service
  // with no snapshot at all.
  const swept = await sweepNasBackupDir(now);
  await pruneServiceBackups(service, Math.max(keep - 1, 1), swept.entries);

  const upload = async (): Promise<void> => {
    await nasUpload(path.posix.join(NAS_BACKUP_DIR, tarName), tar);
    await nasUpload(path.posix.join(NAS_BACKUP_DIR, metaName), metaBuf);
  };

  try {
    await upload();
  } catch (e) {
    if (!isOutOfSpaceError(e)) throw e;
    // The destination is full. Drop whatever partial this attempt left behind,
    // free space across services (never a service's last copy), retry ONCE.
    const needBytes = tar.length + metaBuf.length + CAPACITY_SLACK_BYTES;
    await nasRemove(path.posix.join(NAS_BACKUP_DIR, tarName)).catch(() => {});
    const { pruned, freedBytes } = await pruneAcrossServices(needBytes);
    try {
      await upload();
    } catch (retryError) {
      if (!isOutOfSpaceError(retryError)) throw retryError;
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `${detail} — target too small for one snapshot of each service: ${tarName} needs ${needBytes} bytes, ` +
          `pruning ${pruned.length} old snapshot(s) freed ${freedBytes} and the sweep freed ${swept.freedBytes}. ` +
          `Every service's newest snapshot is kept, so nothing further can be released.`,
      );
    }
  }

  logger.info('ExternalBackup', `Wrote ${tarName} to NAS (${tar.length} bytes)`);
  await pruneServiceBackups(service, keep);
  return { service, tarName, metaName, size: tar.length, meta };
}

/**
 * Delete one NAS snapshot — the tar AND its `.meta.json` sidecar (#1890),
 * mirroring `pruneServiceBackups`' cleanup. `tarName` is operator-supplied (a
 * NAS path), so it's validated: it must be a bare basename (no directory
 * separators / `..` traversal / NUL), end in `.tar`, and not be a sidecar
 * itself. The sidecar remove is best-effort — a legacy bare slot may have none,
 * and a missing sidecar must not fail the tar delete.
 */
export async function deleteServiceBackup(tarName: string): Promise<{ tarName: string; metaRemoved: boolean }> {
  if (typeof tarName !== 'string' || !tarName) {
    throw new Error('tarName is required');
  }
  // Reject any path component, traversal, or NUL — `tarName` names a file inside
  // sb-backup/, never a path. basename!==input catches `../`, `a/b`, leading `/`.
  if (
    tarName.includes('/') ||
    tarName.includes('\\') ||
    tarName.includes('\0') ||
    path.posix.basename(tarName) !== tarName
  ) {
    throw new Error(`Invalid backup name: "${tarName}"`);
  }
  if (!tarName.endsWith('.tar')) {
    throw new Error(`Not a service backup tar: "${tarName}"`);
  }

  await nasRemove(path.posix.join(NAS_BACKUP_DIR, tarName));
  let metaRemoved = false;
  try {
    await nasRemove(path.posix.join(NAS_BACKUP_DIR, `${tarName}.meta.json`));
    metaRemoved = true;
  } catch (e) {
    // A bare legacy slot has no sidecar — don't fail the delete over it.
    logger.info('ExternalBackup', `No meta sidecar removed for ${tarName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  logger.info('ExternalBackup', `Deleted NAS backup ${tarName}${metaRemoved ? ' (+ sidecar)' : ''}`);
  return { tarName, metaRemoved };
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
  if (!(await resolveServiceBackupManifest(service))) {
    throw new Error(NO_MANIFEST(service));
  }
  // A valid (GNU/ustar) tar is at least one 512-byte record; reject obviously
  // non-tar uploads early rather than writing garbage to the NAS.
  if (tar.length < 512) {
    throw new Error('uploaded archive is empty or not a tar');
  }
  return writeServiceBackupToNas(service, tar);
}

/**
 * List the service backups currently on the NAS — one entry per dated snapshot
 * (#1865), newest first within each service, services A→Z. A bare legacy
 * `<service>.tar` (pre-#1865) is surfaced as a valid undated snapshot
 * (`stamp: null`) so no existing backup goes invisible. Sidecar `.meta.json`
 * files are not snapshots and are filtered out.
 */
export async function listServiceBackups(): Promise<ServiceBackupListEntry[]> {
  return toSnapshotEntries(await nasList(NAS_BACKUP_DIR));
}

/** Shape a raw `sb-backup/` listing into snapshot entries. Split out of
 *  {@link listServiceBackups} so the pre-write sweep (#2873) can reuse the file
 *  list it already fetched instead of listing the share a second time. */
function toSnapshotEntries(files: { name: string; size: number }[]): ServiceBackupListEntry[] {
  return files
    .filter(f => f.name.endsWith('.tar')) // drops `.tar.meta.json` sidecars
    .map(f => {
      const parsed = parseSlotName(f.name);
      return parsed
        ? {
            service: parsed.service,
            tarName: f.name,
            size: f.size,
            stamp: parsed.stamp,
            createdAt: createdAtFromStamp(parsed.stamp),
          }
        : null;
    })
    .filter((e): e is ServiceBackupListEntry => e !== null)
    .sort((a, b) =>
      a.service !== b.service
        ? a.service.localeCompare(b.service)
        : (b.stamp ?? '').localeCompare(a.stamp ?? ''), // newest snapshot first
    );
}

/**
 * Resolve the most-recent snapshot tarName for a service from the NAS listing
 * (#1865) — the "restore latest" default. Returns null when the service has no
 * backup on the NAS. A dated slot always wins over a bare legacy `<service>.tar`
 * (which sorts oldest); with only the bare slot present it resolves to that, so
 * existing single-slot backups stay restorable.
 */
export async function latestServiceBackupName(service: string): Promise<string | null> {
  const mine = (await listServiceBackups()).filter(b => b.service === service);
  return mine.length > 0 ? mine[0].tarName : null; // listing is already newest-first
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
