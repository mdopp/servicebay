/**
 * The filesystem seam the local-seed config staging runs on.
 *
 * Split out of `producer.ts` when the dirent-classification walk landed (#2951)
 * — the seam grew a `readdirKinds` + `resolveInsideRoot` pair and pushed that
 * module past its size budget. It is the same seam, in its own file: nothing
 * here knows about the NAS, the run tally, or the manifest contract.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
// `node:` prefix so a stray browser-polyfill in the SSR module graph can't
// shadow child_process with a no-op stub (see systemBackup.ts for the full
// story) — that would make every tar come back empty without tests noticing.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DirentLike, ResolvedWalkEntry } from '@servicebay/backup-manifest';

const execFileAsync = promisify(execFile);

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
  /** Directory entries with their FULL dirent kind (no recursion). The walk
   *  must have a disposition for every kind, which `isDir`/`isFile` cannot
   *  express — a symlink answers neither and used to fall off the end (#2951). */
  readdirKinds(dir: string): Promise<DirentLike[]>;
  /** Fully resolve `target` through symlinks; `null` unless it lands inside
   *  `rootReal` (#2454). */
  resolveInsideRoot(rootReal: string, target: string): Promise<ResolvedWalkEntry | null>;
  /** Fully resolve a path (used once, on the service data root itself). */
  realpath(target: string): Promise<string>;
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
export const localFileBackend: BackupFileBackend = {
  async readdirTypes(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
  },
  readdirKinds: dir => fs.readdir(dir, { withFileTypes: true }),
  async resolveInsideRoot(rootReal, target) {
    let realPath: string;
    try {
      realPath = await fs.realpath(target);
    } catch {
      return null; // missing, dangling symlink, or a symlink loop
    }
    if (realPath !== rootReal && !realPath.startsWith(rootReal + path.sep)) return null;
    return { realPath, isDirectory: (await fs.stat(realPath)).isDirectory() };
  },
  realpath: target => fs.realpath(target),
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
