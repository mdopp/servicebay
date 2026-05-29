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
import { nasUpload, nasDownload, nasList } from './nasClient';
import {
  getServiceManifest,
  applyStripRules,
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

/** A relative path is excluded when it equals an exclude entry or lives under
 *  one (an exclude dir). Excludes always win over includes. */
function isExcluded(relPath: string, excludes: string[]): boolean {
  return excludes.some(ex => relPath === ex || relPath.startsWith(ex + '/'));
}

/** Walk an included directory, returning the relative (posix) paths of every
 *  file inside it that isn't excluded. */
async function collectDirFiles(
  serviceDataDir: string,
  relDir: string,
  excludes: string[],
): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(serviceDataDir, relDir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.posix.join(relDir, entry.name);
    if (isExcluded(rel, excludes)) continue;
    if (entry.isDirectory()) {
      out.push(...(await collectDirFiles(serviceDataDir, rel, excludes)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Copy the manifest-selected config files from `serviceDataDir` into
 * `stagingDir`, applying excludes and strip rules. Returns the sorted list of
 * relative paths actually staged. Pure filesystem work — no NAS, no tar — so
 * the selection logic is unit-testable on its own.
 */
export async function stageServiceBackup(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  stagingDir: string,
): Promise<string[]> {
  const staged: string[] = [];
  for (const include of manifest.include) {
    if (isExcluded(include, manifest.exclude)) continue;
    const absInclude = path.join(serviceDataDir, include);
    if (!(await pathExists(absInclude))) continue;
    const stat = await fs.stat(absInclude);
    const relFiles = stat.isDirectory()
      ? await collectDirFiles(serviceDataDir, include, manifest.exclude)
      : [include];
    for (const rel of relFiles) {
      const dest = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const hasStrip = manifest.strip?.some(r => r.file === rel);
      if (hasStrip) {
        // Only read-as-text the files a strip rule targets; everything else is
        // copied byte-for-byte so binary config (e.g. SQLite-ish blobs) stays intact.
        const content = await fs.readFile(path.join(serviceDataDir, rel), 'utf8');
        await fs.writeFile(dest, applyStripRules(manifest, rel, content));
      } else {
        await fs.copyFile(path.join(serviceDataDir, rel), dest);
      }
      staged.push(rel);
    }
  }
  return staged.sort();
}

/** Build a `<service>.tar` buffer from a service's on-disk config dir. */
export async function buildServiceBackupTar(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
): Promise<Buffer> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-svcbackup-'));
  const tarPath = path.join(os.tmpdir(), `sb-svcbackup-${process.pid}-${Date.now()}.tar`);
  try {
    const staged = await stageServiceBackup(serviceDataDir, manifest, stagingDir);
    if (staged.length === 0) {
      throw new Error(`No config files to back up for "${manifest.service}" under ${serviceDataDir}`);
    }
    await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.']);
    return await fs.readFile(tarPath);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(tarPath, { force: true });
  }
}

/** Resolve a service's on-disk config dir from the configured DATA_DIR. */
export async function resolveServiceDataDir(service: string): Promise<string> {
  const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
  return path.join(dataDir, service);
}

/**
 * Produce a service's config tarball and write it (plus its meta sidecar) to
 * the NAS. Pass `serviceDataDir` to back up from an arbitrary location (the
 * `sb-config-upload` CLI in #1219 seeds from a non-SB source this way);
 * otherwise the dir is resolved from the configured DATA_DIR.
 */
export async function backupServiceToNas(
  service: string,
  opts: { serviceDataDir?: string } = {},
): Promise<ServiceBackupResult> {
  const manifest = getServiceManifest(service);
  if (!manifest) {
    throw new Error(`No backup manifest for service "${service}"`);
  }
  const serviceDataDir = opts.serviceDataDir ?? (await resolveServiceDataDir(service));
  const tar = await buildServiceBackupTar(serviceDataDir, manifest);
  return writeServiceBackupToNas(service, tar);
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
