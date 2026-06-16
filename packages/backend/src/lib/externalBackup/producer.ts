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
import { shellQuote } from '../util/shellQuote';
import { nasUpload, nasDownload, nasList, nasRemove } from './nasClient';
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
  /**
   * Copy MANY files (given as relative paths under `srcRoot`) into `destRoot`,
   * preserving their relative subdirs, in as few operations as possible. The
   * host-agent backend does this in a SINGLE exec (one `tar -C srcRoot … | tar
   * -x -C destRoot`) instead of a `mkdirp`+`copyFile` round-trip per file — a HA
   * config with HACS is thousands of files, and per-file agent round-trips OOM'd
   * the box (#1894). `relFiles` are plain copies only; strip/transform/renamed
   * files are still staged individually (they're few and need a content rewrite).
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

/**
 * Bulk-copy `relFiles` (relative to `srcRoot`) into `destRoot` host-side in ONE
 * exec (#1894): write the paths NUL-separated to a temp list, then
 * `tar -C srcRoot --null -T list -cf - | tar -C destRoot -xf -`. The pipe streams
 * through the host filesystem — no `cp`/`mkdir` round-trip per file, so a HACS HA
 * config (thousands of files) no longer floods the agent channel and OOMs the
 * box. NUL separation means a path with spaces/newlines/quotes is taken verbatim
 * (no tar `-T` unquoting). Both tar invocations + the pipe need a shell, so this
 * uses `exec` (not execArgv); every interpolated path is shellQuote'd.
 */
async function agentBulkCopyFiles(
  executor: Executor,
  srcRoot: string,
  relFiles: string[],
  destRoot: string,
): Promise<void> {
  if (relFiles.length === 0) return;
  const listFile = `${destRoot}.copylist`;
  await executor.writeFile(listFile, relFiles.join('\0'));
  try {
    const cmd =
      `tar -C ${shellQuote(srcRoot)} --null -T ${shellQuote(listFile)} -cf - | ` +
      `tar -C ${shellQuote(destRoot)} -xf -`;
    await executor.exec(cmd, { timeoutMs: 120_000 });
  } finally {
    await executor.execArgv(['rm', '-f', listFile]);
  }
}

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
    bulkCopyFiles: (srcRoot, relFiles, destRoot) =>
      agentBulkCopyFiles(executor, srcRoot, relFiles, destRoot),
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
  // Not every NPM image ships sqlite3 (#1894 — the current jc21 image does not).
  // Probe for it FIRST and report a precise, greppable reason so the producer can
  // degrade honestly (copy the live file) instead of logging a misleading
  // "(unknown)". The real `sh: sqlite3: not found` stderr never made it back
  // before, so this gap was undiagnosable from the logs.
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

/**
 * Prune dated snapshots for ONE service down to the `keep` most-recent (#1865),
 * removing each pruned tar's `.meta.json` sidecar too. A bare legacy
 * `<service>.tar` (pre-#1865) sorts oldest, so once `keep` dated slots exist it
 * is the first to be pruned — the rotated history supersedes the single slot.
 * Best-effort: a prune failure is logged, never thrown (it must not fail a
 * successful backup). Returns the names pruned.
 */
async function pruneServiceBackups(service: string, keep: number): Promise<string[]> {
  try {
    const all = await listServiceBackups();
    const mine = all
      .filter(b => b.service === service)
      // Newest first: a real dated stamp beats a bare (null) slot; ties (only
      // possible across bare vs the impossible duplicate stamp) keep bare last.
      .sort((a, b) => (b.stamp ?? '').localeCompare(a.stamp ?? ''));
    const stale = mine.slice(keep);
    const pruned: string[] = [];
    for (const entry of stale) {
      await nasRemove(path.posix.join(NAS_BACKUP_DIR, entry.tarName));
      await nasRemove(path.posix.join(NAS_BACKUP_DIR, `${entry.tarName}.meta.json`));
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
 */
async function writeServiceBackupToNas(service: string, tar: Buffer): Promise<ServiceBackupResult> {
  const now = new Date();
  const meta: ServiceBackupMeta = {
    service,
    schemaVersion: META_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    nodeId: os.hostname(),
  };
  const tarName = `${service}-${backupStamp(now)}.tar`;
  const metaName = `${tarName}.meta.json`;

  await nasUpload(path.posix.join(NAS_BACKUP_DIR, tarName), tar);
  await nasUpload(
    path.posix.join(NAS_BACKUP_DIR, metaName),
    Buffer.from(JSON.stringify(meta, null, 2)),
  );

  logger.info('ExternalBackup', `Wrote ${tarName} to NAS (${tar.length} bytes)`);
  await pruneServiceBackups(service, await getBackupRetention());
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

/**
 * List the service backups currently on the NAS — one entry per dated snapshot
 * (#1865), newest first within each service, services A→Z. A bare legacy
 * `<service>.tar` (pre-#1865) is surfaced as a valid undated snapshot
 * (`stamp: null`) so no existing backup goes invisible. Sidecar `.meta.json`
 * files are not snapshots and are filtered out.
 */
export async function listServiceBackups(): Promise<ServiceBackupListEntry[]> {
  const files = await nasList(NAS_BACKUP_DIR);
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
