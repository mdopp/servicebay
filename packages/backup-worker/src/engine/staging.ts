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
} from './serviceManifest';

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
 * Resolve a manifest include that may carry a trailing-`*` glob in its leaf
 * component (e.g. `.storage/lovelace*`) to the concrete relative paths under
 * `serviceDataDir`. A plain include resolves to itself. Only a single
 * trailing-`*` on the leaf is supported (#1595/#1596).
 */
async function resolveIncludeGlob(serviceDataDir: string, include: string): Promise<string[]> {
  if (!include.includes('*')) return [include];
  const dir = path.posix.dirname(include);
  const leaf = path.posix.basename(include);
  if (leaf.indexOf('*') !== leaf.length - 1) return [include];
  const prefix = leaf.slice(0, -1);
  const parentAbs = path.join(serviceDataDir, dir);
  if (!(await pathExists(parentAbs))) return [];
  const entries = await fs.readdir(parentAbs, { withFileTypes: true });
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

/**
 * Copy the manifest-selected config files from `serviceDataDir` into
 * `stagingDir`, applying excludes and strip/transform rules. Returns the sorted
 * list of relative paths actually staged. Plain (byte-for-byte) copies keep
 * binary config intact; only strip/transform targets are read as text.
 */
export async function stageServiceBackup(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  stagingDir: string,
): Promise<string[]> {
  const staged: string[] = [];
  const includes: string[] = [];
  for (const include of manifest.include) {
    includes.push(...(await resolveIncludeGlob(serviceDataDir, include)));
  }
  for (const include of includes) {
    if (isExcluded(include, manifest.exclude)) continue;
    const absInclude = path.join(serviceDataDir, include);
    if (!(await pathExists(absInclude))) continue;
    const isDir = (await fs.stat(absInclude)).isDirectory();
    const relFiles = isDir
      ? await collectDirFiles(serviceDataDir, include, manifest.exclude)
      : [include];
    for (const rel of relFiles) {
      const tarRel = manifest.renames?.[rel] ?? rel;
      const needsRewrite =
        manifest.strip?.some(r => r.file === rel) ||
        manifest.transform?.some(r => r.file === rel);
      const dest = path.join(stagingDir, tarRel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (needsRewrite) {
        const content = await fs.readFile(path.join(serviceDataDir, rel), 'utf8');
        const stripped = applyStripRules(manifest, rel, content);
        await fs.writeFile(dest, applyTransformRules(manifest, rel, stripped));
      } else {
        await fs.copyFile(path.join(serviceDataDir, rel), dest);
      }
      staged.push(tarRel);
    }
  }
  return staged.sort();
}

/** Result of staging + tarring one service's config. */
export interface BuiltServiceTar {
  /** Number of config files staged into the tar. */
  files: number;
  /** Tar size in bytes. */
  bytes: number;
}

/**
 * Stage a service's config into a fresh temp dir, tar it to `tarPath`, and return
 * the file/size rollup. Throws when nothing matched the manifest (the caller maps
 * that to a "skip" — the service has no config on disk yet).
 */
export async function buildServiceBackupTar(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
  tarPath: string,
): Promise<BuiltServiceTar> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-bw-'));
  try {
    const staged = await stageServiceBackup(serviceDataDir, manifest, stagingDir);
    if (staged.length === 0) {
      throw new Error(`No config files to back up for "${manifest.service}" under ${serviceDataDir}`);
    }
    await fs.mkdir(path.dirname(tarPath), { recursive: true });
    await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.']);
    const { size } = await fs.stat(tarPath);
    return { files: staged.length, bytes: size };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}
