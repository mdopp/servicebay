/**
 * Security tests for the backup restore extract path (#580).
 *
 * Builds crafted tar archives that exercise the three classic escape
 * vectors and confirms `safeTarExtract` refuses each. Also round-trips
 * a normal archive end-to-end to make sure the hardening flags don't
 * break the legitimate path.
 *
 * Requires GNU tar on $PATH. CI runners and the FCoS host both ship
 * it. Skipped automatically if not present.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeTarExtract } from '../../src/lib/systemBackup';

function tarPresent(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_TAR = tarPresent();
const maybeIt = HAS_TAR ? it : it.skip;

function mktmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sb-backup-test-${prefix}-`));
}

/** Build a tarball by running tar from inside `workingDir` so the
 *  entries appear with relative paths. Simpler + more robust than
 *  juggling -C / -T argument order. */
function makeArchive(opts: {
  prefix: string;
  workingDir: string;
  entries: string[];
}): string {
  const archive = path.join(mktmpDir(opts.prefix), 'archive.tar.gz');
  execFileSync('tar', ['-czf', archive, ...opts.entries], {
    cwd: opts.workingDir,
    stdio: 'pipe',
  });
  return archive;
}

describe('safeTarExtract — security regression suite (#580)', () => {
  let scratchRoot: string;
  let sentinelDir: string;
  let sentinelFile: string;

  beforeAll(() => {
    // Sentinel file lives OUTSIDE the extraction destination. If any of
    // the crafted archives manages to escape, they could overwrite this.
    // Tests assert the sentinel survives unchanged.
    scratchRoot = mktmpDir('scratch');
    sentinelDir = path.join(scratchRoot, 'outside');
    fs.mkdirSync(sentinelDir, { recursive: true });
    sentinelFile = path.join(sentinelDir, 'sentinel.txt');
    fs.writeFileSync(sentinelFile, 'ORIGINAL_CONTENTS');
  });

  maybeIt('round-trip: a normal archive extracts cleanly with no warnings', async () => {
    const src = mktmpDir('src');
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(src, 'nested'));
    fs.writeFileSync(path.join(src, 'nested', 'b.txt'), 'world');
    const archive = makeArchive({
      prefix: 'normal',
      workingDir: src,
      entries: ['a.txt', 'nested'],
    });
    const dest = mktmpDir('dest-normal');
    await safeTarExtract(archive, dest);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(dest, 'nested', 'b.txt'), 'utf8')).toBe('world');
  });

  maybeIt('refuses an archive with an absolute path entry', async () => {
    // Use `-P` to preserve the leading `/`. Without `-P`, GNU tar
    // strips it during pack and the test wouldn't represent the
    // attack we care about (a hand-crafted or third-party tar).
    const src = mktmpDir('absolute-src');
    fs.writeFileSync(path.join(src, 'evil.txt'), 'EVIL');
    const archive = path.join(mktmpDir('absolute'), 'archive.tar.gz');
    // Build by referencing the absolute path of the file inside `src`.
    execFileSync('tar', ['-czPf', archive, path.join(src, 'evil.txt')]);

    const dest = mktmpDir('dest-absolute');
    await expect(safeTarExtract(archive, dest)).rejects.toThrow(/absolute path/);
    // Destination must be empty — extraction never started.
    const after = fs.readdirSync(dest);
    expect(after).toEqual([]);
  });

  maybeIt('refuses an archive with `../` traversal segments', async () => {
    // GNU tar strips `../` from member names on pack ("Removing leading
    // '../' from member names"), so we can't construct this case
    // through stock tar — we have to hand-craft the archive. Use
    // Python's tarfile which lets us write arbitrary names into the
    // header. This is the exact shape a malicious actor would ship.
    const archive = path.join(mktmpDir('traversal'), 'archive.tar.gz');
    execFileSync('python3', ['-c', `
import tarfile, io
tf = tarfile.open(${JSON.stringify(archive)}, 'w:gz')
info = tarfile.TarInfo(name='subdir/../../escaped.txt')
data = b'EVIL'
info.size = len(data)
tf.addfile(info, io.BytesIO(data))
tf.close()
`]);

    const dest = mktmpDir('dest-traversal');
    await expect(safeTarExtract(archive, dest)).rejects.toThrow(/traversal/);
    // Nothing should land in dest, and the sentinel outside must survive.
    expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('ORIGINAL_CONTENTS');
  });

  maybeIt('refuses an archive whose symlink targets outside the destination', async () => {
    const src = mktmpDir('symlink-src');
    // Create a symlink in src/ pointing at the sentinel outside our
    // extraction destination. Archive includes only the link, not the
    // target — so the pre-pass passes (the entry is a relative name)
    // and the post-extraction walk catches the escape.
    const linkPath = path.join(src, 'bad-link');
    fs.symlinkSync(sentinelFile, linkPath);
    const archive = makeArchive({
      prefix: 'symlink',
      workingDir: src,
      entries: ['bad-link'],
    });

    const dest = mktmpDir('dest-symlink');
    await expect(safeTarExtract(archive, dest)).rejects.toThrow(/escapes the extraction directory/);
    // The post-extract symlink walk failed → safeTarExtract cleaned
    // up the staging dir.
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('ORIGINAL_CONTENTS');
  });

  maybeIt('refuses a relative symlink that resolves outside (../../sentinel)', async () => {
    const src = mktmpDir('relsym-src');
    // A relative symlink whose target traverses out of the destination
    // when resolved post-extraction. Different shape from the absolute
    // symlink above — the link target itself is relative.
    const upPath = path.relative(src, sentinelFile);
    fs.symlinkSync(upPath, path.join(src, 'rel-link'));
    const archive = makeArchive({
      prefix: 'relsym',
      workingDir: src,
      entries: ['rel-link'],
    });

    const dest = mktmpDir('dest-relsym');
    await expect(safeTarExtract(archive, dest)).rejects.toThrow();
    expect(fs.readFileSync(sentinelFile, 'utf8')).toBe('ORIGINAL_CONTENTS');
  });
});
