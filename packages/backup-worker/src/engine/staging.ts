// backup-worker — config staging engine (#1955, slice of #1949).
//
// The heavy part of the external/config backup, moved OUT of the servicebay
// control plane: walk a service's config dir, select the manifest's include −
// exclude paths, apply strip/transform rewrites, copy the bytes into a staging
// dir, and tar it. This runs IN the worker container against the RO-mounted
// stacks dir (`/mnt/stacks/...`) — so a HACS HA config (thousands of files) is
// copied + tarred inside the worker's `--memory` cap, never in the box's Node
// process (the in-process per-file copy + held tar bytes OOM'd the box, #1894).
//
// The old backend producer had a `BackupFileBackend` seam so the SAME logic could
// run either in-container (local fs) or host-side via the agent. The worker only
// ever needs the local-fs path (it IS the container, with the stacks dir mounted),
// so this engine is plain `node:fs` — no agent, no backend abstraction. Pure,
// unit-testable logic; the CLI wires it to the real mount + out volume.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  applyStripRules,
  applyTransformRules,
  type ServiceBackupManifest,
} from '@servicebay/backup-manifest';

const execFileAsync = promisify(execFile);

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

/**
 * Fully resolve `absPath` and return it only when it still lives inside the
 * service's own (already-resolved) data root — otherwise `null`.
 *
 * Security (#2454): manifest-include resolution must NOT follow a symlink out
 * of the service's data dir. A compromised service can replace an included path
 * (e.g. `.storage`) with a symlink at a *sibling* service's data dir; a bare
 * `fs.stat` follows it, so the sibling's bytes would be copied into THIS
 * service's tar and shipped offsite. `fs.realpath` resolves symlinks in every
 * component, so this also rejects an include that merely *traverses* a symlink
 * (or a `..` segment) on its way out. A symlink that stays inside the service's
 * own data root is legitimate and still resolves.
 */
async function realPathInsideRoot(dataDirReal: string, absPath: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(absPath);
  } catch {
    return null; // missing, dangling symlink, or a symlink loop
  }
  return real === dataDirReal || real.startsWith(dataDirReal + path.sep) ? real : null;
}

/**
 * Resolve a manifest include that may carry a trailing-`*` glob in its leaf
 * component (e.g. `.storage/lovelace*`) to the concrete relative paths under
 * `serviceDataDir`. A plain include resolves to itself. Only a single
 * trailing-`*` on the leaf is supported (#1595/#1596).
 */
async function resolveIncludeGlob(
  serviceDataDir: string,
  dataDirReal: string,
  include: string,
): Promise<string[]> {
  if (!include.includes('*')) return [include];
  const dir = path.posix.dirname(include);
  const leaf = path.posix.basename(include);
  if (leaf.indexOf('*') !== leaf.length - 1) return [include];
  const prefix = leaf.slice(0, -1);
  // Escaping parent → not even enumerated (no sibling-directory listing).
  const parentReal = await realPathInsideRoot(dataDirReal, path.join(serviceDataDir, dir));
  if (!parentReal) return [];
  const entries = await fs.readdir(parentReal, { withFileTypes: true });
  return entries
    .filter(e => e.name.startsWith(prefix))
    .map(e => path.posix.join(dir, e.name));
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

/** One config file the staging could not read, with the reason. Reported per
 *  service (and recorded in the NAS tar's meta sidecar) rather than failing the
 *  whole service (#2877). */
export interface SkippedConfigFile {
  /** Path inside the tar the file WOULD have had. */
  file: string;
  /** Why it could not be staged (e.g. `EACCES`). */
  reason: string;
}

/** What one service's staging produced: the tar-relative paths that landed, plus
 *  the ones that were skipped because they could not be read. */
export interface StagedConfig {
  staged: string[];
  skipped: SkippedConfigFile[];
}

/**
 * A file the worker is not ALLOWED to read (#2877). NPM's `database.sqlite` is
 * owned by the container's uid-mapped root at mode 0600 and the worker runs as a
 * different uid, so a plain copy of it throws EACCES. One such file must not fail
 * the whole service's backup — the other config (certs, custom SSL) is still
 * worth shipping, and the miss is reported instead of swallowed.
 */
function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Stage ONE selected file into the staging dir under its tar-relative name,
 * applying any strip/transform rewrite. Returns the miss when the file could not
 * be READ (#2877) — that is reported, not thrown, so one locked-down file cannot
 * cost the service the rest of its config. Any other failure still throws.
 */
async function stageOneFile(
  serviceDataDir: string,
  stagingDir: string,
  manifest: ServiceBackupManifest,
  rel: string,
  tarRel: string,
): Promise<SkippedConfigFile | null> {
  const dest = path.join(stagingDir, tarRel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const needsRewrite =
    manifest.strip?.some(r => r.file === rel) ||
    manifest.transform?.some(r => r.file === rel);
  try {
    if (needsRewrite) {
      const content = await fs.readFile(path.join(serviceDataDir, rel), 'utf8');
      const stripped = applyStripRules(manifest, rel, content);
      await fs.writeFile(dest, applyTransformRules(manifest, rel, stripped));
    } else {
      await fs.copyFile(path.join(serviceDataDir, rel), dest);
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    const reason = (error as NodeJS.ErrnoException).code ?? 'EACCES';
    console.warn(
      `[backup-worker] "${manifest.service}": skipping "${tarRel}" — ${reason} reading it (owned by another uid?)`,
    );
    await fs.rm(dest, { force: true });
    return { file: tarRel, reason };
  }
  return null;
}

/**
 * Copy the manifest-selected config files from `serviceDataDir` into
 * `stagingDir`, applying excludes and strip/transform rules. Returns the sorted
 * list of relative paths actually staged plus the ones skipped as unreadable.
 * Plain (byte-for-byte) copies keep binary config intact; only strip/transform
 * targets are read as text.
 */
export async function stageServiceBackup(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  stagingDir: string,
): Promise<StagedConfig> {
  const staged: string[] = [];
  const skipped: SkippedConfigFile[] = [];
  let dataDirReal: string;
  try {
    // The data root itself may legitimately be a symlink (e.g. a mounted
    // stacks path) — resolve it ONCE and containment-check against the result.
    dataDirReal = await fs.realpath(serviceDataDir);
  } catch {
    return { staged, skipped }; // no data dir on disk yet
  }
  // A collector's snapshot is staged UNDER the live file's name, so the live
  // original must never be copied over it — it would race the snapshot for the
  // same tar path, and it is exactly the file the worker cannot read anyway.
  const renameTargets = new Set(Object.values(manifest.renames ?? {}));
  const includes: string[] = [];
  for (const include of manifest.include) {
    includes.push(...(await resolveIncludeGlob(serviceDataDir, dataDirReal, include)));
  }
  for (const include of includes) {
    if (isExcluded(include, manifest.exclude)) continue;
    const absInclude = path.join(serviceDataDir, include);
    if (!(await pathExists(absInclude))) continue;
    const realInclude = await realPathInsideRoot(dataDirReal, absInclude);
    if (!realInclude) {
      // #2454 — symlink (or `..`) escape out of the service's own data dir.
      console.warn(
        `[backup-worker] "${manifest.service}": skipping include "${include}" — it resolves outside the service data dir`,
      );
      continue;
    }
    const isDir = (await fs.stat(realInclude)).isDirectory();
    const relFiles = isDir
      ? await collectDirFiles(serviceDataDir, include, manifest.exclude)
      : [include];
    for (const rel of relFiles) {
      const tarRel = manifest.renames?.[rel] ?? rel;
      // The collector already snapshotted this one under its own name.
      if (tarRel === rel && renameTargets.has(rel)) continue;
      // A miss is reported and the run carries on (#2877).
      const miss = await stageOneFile(serviceDataDir, stagingDir, manifest, rel, tarRel);
      if (miss) skipped.push(miss);
      else staged.push(tarRel);
    }
  }
  return { staged: staged.sort(), skipped };
}

/** Result of staging + tarring one service's config. */
export interface BuiltServiceTar {
  /** Number of config files staged into the tar. */
  files: number;
  /** Tar size in bytes. */
  bytes: number;
  /** Tar-relative paths of the declared files that could NOT be read (#2877).
   *  Empty on a complete backup; servicebay records them in the meta sidecar. */
  skipped: string[];
}

/**
 * Stage a service's config into a fresh temp dir, tar it to `tarPath`, and return
 * the file/size rollup. Throws when nothing matched the manifest (the caller maps
 * that to a "skip" — the service has no config on disk yet), and separately when
 * everything that DID match was unreadable — that is an error, not an empty
 * service, and must not read as "nothing to back up".
 */
export async function buildServiceBackupTar(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  tarPath: string,
): Promise<BuiltServiceTar> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-bw-'));
  try {
    const { staged, skipped } = await stageServiceBackup(serviceDataDir, manifest, stagingDir);
    if (staged.length === 0) {
      if (skipped.length > 0) {
        throw new Error(
          `Every config file for "${manifest.service}" under ${serviceDataDir} was unreadable `
          + `(${skipped.length}: ${skipped.map(s => `${s.file} (${s.reason})`).join(', ')})`,
        );
      }
      throw new Error(`No config files to back up for "${manifest.service}" under ${serviceDataDir}`);
    }
    await fs.mkdir(path.dirname(tarPath), { recursive: true });
    await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.']);
    const { size } = await fs.stat(tarPath);
    return { files: staged.length, bytes: size, skipped: skipped.map(s => s.file) };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}
