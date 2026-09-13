/**
 * CLASS GATE B (#2951) — every kind of directory entry the backup walk can meet
 * is either STAGED or REPORTED. Nothing is dropped in silence.
 *
 * The bug this gate exists for: both staging walks asked exactly two questions,
 * `isDirectory()` and `isFile()`, and every other dirent kind fell off the end
 * of the `if` chain — not staged, not recursed, not reported. Certbot keeps
 * each certificate as a real file under `letsencrypt/archive/<name>/` plus a
 * relative SYMLINK at `letsencrypt/live/<name>/`, and `live/` is the path every
 * NPM vhost references. The symlinks stay inside the service's own data dir, so
 * the #2454 escape guard was never what dropped them: the walk simply had no
 * branch for a symlink. The tar shipped `archive/` and `renewal/`, reported a
 * plausible file count and `ok`, and a restore from it produced a proxy that
 * could not start one SSL vhost.
 *
 * Why the gate is written this way. A `letsencrypt` fixture would prove the one
 * case and leave the class open — the next kind nobody thought about would be
 * dropped exactly as quietly. So the enumeration is DERIVED, at runtime, from
 * `fs.Dirent`'s own predicates: whatever kinds node can report, the walk must
 * have a disposition for each of them, and each must land in `files` or in
 * `skipped`. A new predicate in a future node makes this red until someone
 * gives it a disposition.
 *
 * And it is ONE walk, not two. The worker's `engine/staging.ts` and the
 * backend's local-seed `externalBackup/producer.ts` both drive
 * `collectIncludedFiles` from `@servicebay/backup-manifest`, so this gate
 * covers both paths rather than one of them plus a copy that drifts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  collectIncludedFiles,
  direntKind,
  direntDisposition,
  DIRENT_DISPOSITIONS,
  type DirentKind,
  type DirentLike,
  type DirWalkFs,
  type ServiceBackupManifest,
} from '@servicebay/backup-manifest';
import { stageServiceBackup as stageInWorker, buildServiceBackupTar } from '../../packages/backup-worker/src/engine/staging';
import { stageServiceBackup as stageInBackend } from '@/lib/externalBackup/producer';
import { builtinManifest } from '../fixtures/builtinBackupManifests';

const execFileAsync = promisify(execFile);

/**
 * EVERY `is…()` predicate `fs.Dirent` exposes, read off the prototype at run
 * time. This is the enumeration — not a list typed out here, which is the thing
 * that goes stale.
 */
const DIRENT_PREDICATES = Object.getOwnPropertyNames(fsSync.Dirent.prototype)
  .filter(name => /^is[A-Z]/.test(name))
  .sort();

/** A dirent that answers exactly one predicate — or none, for `DT_UNKNOWN`. */
function fakeDirent(name: string, answers: string | null): DirentLike {
  const entry: Record<string, unknown> = { name };
  for (const predicate of DIRENT_PREDICATES) entry[predicate] = () => predicate === answers;
  return entry as unknown as DirentLike;
}

/** The synthetic cases the gate runs: one per predicate, plus "answers none". */
const ALL_DIRENT_CASES: (string | null)[] = [...DIRENT_PREDICATES, null];

let tmpDirs: string[] = [];
let openSockets: net.Server[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-walk-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const server of openSockets) await new Promise<void>(r => server.close(() => r()));
  openSockets = [];
  for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
  tmpDirs = [];
});
beforeEach(() => {
  tmpDirs = [];
  openSockets = [];
});

describe('CLASS GATE B — the dirent kinds the walk can meet (#2951)', () => {
  it('derives the kind set from `fs.Dirent` itself, and every kind has a disposition', () => {
    expect(DIRENT_PREDICATES.length).toBeGreaterThan(0);
    const kinds = new Set<DirentKind>();
    for (const predicate of DIRENT_PREDICATES) {
      const kind = direntKind(fakeDirent('x', predicate));
      // A predicate node reports must map to its OWN kind — never to the
      // catch-all, which is where a silently-dropped entry would hide.
      expect(kind, `no kind for fs.Dirent.${predicate}()`).not.toBe('unknown');
      kinds.add(kind);
    }
    // Injective: two predicates collapsing onto one kind would mean one of them
    // is being answered by the wrong branch.
    expect(kinds.size).toBe(DIRENT_PREDICATES.length);
    kinds.add(direntKind(fakeDirent('x', null)));
    // …and the disposition map covers exactly that set — no kind without a
    // disposition, and no disposition for a kind that cannot occur.
    expect([...kinds].sort()).toEqual(Object.keys(DIRENT_DISPOSITIONS).sort());
  });

  it.each(ALL_DIRENT_CASES)('a %s entry has a disposition that is not "do nothing"', predicate => {
    const disposition = direntDisposition(fakeDirent('entry', predicate));
    expect(['stage', 'recurse', 'resolve', 'skip']).toContain(disposition.action);
    if (disposition.action === 'skip') expect(disposition.reason).toMatch(/\S/);
  });

  it.each(ALL_DIRENT_CASES)(
    'the shared walk STAGES or REPORTS a %s entry — it never vanishes',
    async predicate => {
      // A stub filesystem: one entry of this kind in the included dir, holding
      // one plain file if the walk descends into it. A symlink resolves to a
      // plain file inside the root, which is the letsencrypt/live shape.
      const walkFs: DirWalkFs = {
        readdir: async relDir =>
          relDir === 'inc'
            ? [fakeDirent('entry', predicate)]
            : [fakeDirent('inside.conf', 'isFile')],
        resolveInsideRoot: async () => ({ realPath: '/root/real', isDirectory: false }),
      };
      const walked = await collectIncludedFiles(walkFs, 'inc', []);
      const accounted = [...walked.files, ...walked.skipped.map(s => s.file)];
      // Accounted for = the entry itself was staged or reported, OR the walk
      // descended into it and accounted for what was inside. A kind that
      // produces neither is the silent drop this gate forbids.
      expect(
        accounted.some(p => p === 'inc/entry' || p.startsWith('inc/entry/')),
        `fs.Dirent.${predicate}() entry was dropped in silence (walk produced ${JSON.stringify(accounted)})`,
      ).toBe(true);
    },
  );

  it('reports a symlink that does not resolve inside the service root, rather than dropping it', async () => {
    const walkFs: DirWalkFs = {
      readdir: async relDir => (relDir === 'inc' ? [fakeDirent('escape', 'isSymbolicLink')] : []),
      resolveInsideRoot: async () => null,
    };
    const walked = await collectIncludedFiles(walkFs, 'inc', []);
    expect(walked.files).toEqual([]);
    expect(walked.skipped).toEqual([
      { file: 'inc/escape', reason: expect.stringMatching(/does not resolve.*inside the service data dir/) },
    ]);
  });

  it('closes a symlink loop instead of recursing forever, and says so', async () => {
    const walkFs: DirWalkFs = {
      readdir: async () => [fakeDirent('self', 'isSymbolicLink')],
      resolveInsideRoot: async () => ({ realPath: '/root/inc', isDirectory: true }),
    };
    const walked = await collectIncludedFiles(walkFs, 'inc', []);
    expect(walked.skipped.some(s => /link loop/.test(s.reason))).toBe(true);
  });
});

/**
 * The same class, against the REAL filesystem, on BOTH staging paths. Block and
 * character devices need root to create, so they are covered by the synthetic
 * enumeration above; everything a non-root process can make is made here.
 */
describe('CLASS GATE B — both staging paths account for every entry they meet', () => {
  /** A directory holding one entry of every kind this process can create. */
  async function makeMixedFixture(): Promise<{ src: string; expected: string[] }> {
    const src = await mkTmp();
    const outside = await mkTmp();
    await fs.writeFile(path.join(outside, 'sibling-secret.txt'), 'NOT-OURS');
    await fs.mkdir(path.join(src, 'inc/nested'), { recursive: true });
    await fs.writeFile(path.join(src, 'inc/plain.conf'), 'plain');
    await fs.writeFile(path.join(src, 'inc/nested/deep.conf'), 'deep');
    await fs.writeFile(path.join(src, 'inc/target.pem'), 'TARGET');
    // The letsencrypt/live shape: a relative symlink to a real file in-root.
    await fs.symlink('target.pem', path.join(src, 'inc/link-to-file.pem'));
    await fs.symlink('nested', path.join(src, 'inc/link-to-dir'));
    await fs.symlink(path.join(outside, 'sibling-secret.txt'), path.join(src, 'inc/link-escaping'));
    await fs.symlink('nowhere.conf', path.join(src, 'inc/link-dangling'));
    await execFileAsync('mkfifo', [path.join(src, 'inc/a.fifo')]);
    // The socket file only exists while the server is listening — node unlinks
    // it on close — so the listener is held open until afterEach tears it down.
    await new Promise<void>(resolve => {
      const server = net.createServer();
      openSockets.push(server);
      server.listen(path.join(src, 'inc/a.sock'), () => resolve());
    });
    return {
      src,
      expected: [
        'inc/plain.conf',
        'inc/nested/deep.conf',
        'inc/target.pem',
        'inc/link-to-file.pem',
        'inc/link-to-dir/deep.conf',
        'inc/link-escaping',
        'inc/link-dangling',
        'inc/a.fifo',
        'inc/a.sock',
      ],
    };
  }

  const MANIFEST: ServiceBackupManifest = { service: 'walk-probe', include: ['inc'], exclude: [] };

  const PATHS: [string, (src: string, staging: string) => Promise<{ staged: string[]; skipped: { file: string }[] }>][] = [
    ['backup-worker engine/staging.ts', (src, staging) => stageInWorker(src, MANIFEST, staging)],
    ['backend local-seed externalBackup/producer.ts', (src, staging) => stageInBackend(src, MANIFEST, staging)],
  ];

  it.each(PATHS)('%s: every entry is staged or reported', async (_name, stage) => {
    const { src, expected } = await makeMixedFixture();
    const staging = await mkTmp();

    const { staged, skipped } = await stage(src, staging);
    const accounted = new Set([...staged, ...skipped.map(s => s.file)]);

    for (const entry of expected) {
      expect(accounted, `${entry} left the walk unaccounted for`).toContain(entry);
    }
    // The certificate shape specifically: an in-root symlink to a file is
    // BACKED UP, not merely reported.
    expect(staged).toContain('inc/link-to-file.pem');
    expect(staged).toContain('inc/link-to-dir/deep.conf');
    // …and the escape is reported, not silently honoured (#2454 still holds).
    expect(skipped.map(s => s.file)).toContain('inc/link-escaping');
    expect(staged).not.toContain('inc/link-escaping');
  });

  it('drives ONE walk, not a copy per path', async () => {
    const worker = await fs.readFile('packages/backup-worker/src/engine/staging.ts', 'utf8');
    const backend = await fs.readFile('packages/backend/src/lib/externalBackup/producer.ts', 'utf8');
    for (const [name, source] of [['worker', worker], ['backend', backend]] as const) {
      expect(source, `${name} does not use the shared walk`).toMatch(/collectIncludedFiles/);
      // A local re-implementation is exactly the drift this gate forbids.
      expect(source, `${name} still defines its own dirent walk`).not.toMatch(/function collectDirFiles/);
    }
  });
});

/**
 * The concrete instance the class gate generalises (#2951): NPM's certificates.
 * Synthetic bytes only — the fixture never carries real key material.
 */
describe('nginx: letsencrypt/live reaches the tar (#2951)', () => {
  it('stages the live/ symlinks the vhosts reference, not just archive/', async () => {
    const manifest = builtinManifest('nginx');
    const src = await mkTmp();
    const cert = 'npm-1';
    await fs.mkdir(path.join(src, `letsencrypt/archive/${cert}`), { recursive: true });
    await fs.mkdir(path.join(src, `letsencrypt/live/${cert}`), { recursive: true });
    await fs.mkdir(path.join(src, 'letsencrypt/renewal'), { recursive: true });
    await fs.mkdir(path.join(src, 'data'), { recursive: true });
    await fs.writeFile(path.join(src, 'data/database.sqlite'), 'db');
    await fs.writeFile(path.join(src, 'letsencrypt/renewal', `${cert}.conf`), 'renewal');
    for (const leaf of ['fullchain1.pem', 'privkey1.pem', 'cert1.pem', 'chain1.pem']) {
      await fs.writeFile(path.join(src, `letsencrypt/archive/${cert}`, leaf), `SYNTHETIC-${leaf}`);
      // Certbot's own shape: a RELATIVE link out of live/ into archive/.
      await fs.symlink(
        `../../archive/${cert}/${leaf}`,
        path.join(src, `letsencrypt/live/${cert}`, leaf.replace(/1\.pem$/, '.pem')),
      );
    }

    const staging = await mkTmp();
    const { staged, skipped } = await stageInWorker(src, manifest, staging);

    expect(staged).toContain(`letsencrypt/live/${cert}/fullchain.pem`);
    expect(staged).toContain(`letsencrypt/live/${cert}/privkey.pem`);
    expect(staged).toContain(`letsencrypt/archive/${cert}/fullchain1.pem`);
    expect(skipped).toEqual([]);
    // The bytes follow the link, so a restore has a real certificate there.
    await expect(
      fs.readFile(path.join(staging, `letsencrypt/live/${cert}/fullchain.pem`), 'utf8'),
    ).resolves.toBe('SYNTHETIC-fullchain1.pem');
  });

  it('the produced tar carries the live/ entries', async () => {
    const manifest = builtinManifest('nginx');
    const src = await mkTmp();
    await fs.mkdir(path.join(src, 'letsencrypt/archive/npm-1'), { recursive: true });
    await fs.mkdir(path.join(src, 'letsencrypt/live/npm-1'), { recursive: true });
    await fs.writeFile(path.join(src, 'letsencrypt/archive/npm-1/fullchain1.pem'), 'SYNTHETIC');
    await fs.symlink('../../archive/npm-1/fullchain1.pem', path.join(src, 'letsencrypt/live/npm-1/fullchain.pem'));

    const tarPath = path.join(await mkTmp(), 'nginx.tar');
    const built = await buildServiceBackupTar(src, manifest, tarPath);
    const { stdout } = await execFileAsync('tar', ['-tf', tarPath]);

    expect(stdout).toContain('letsencrypt/live/npm-1/fullchain.pem');
    expect(built.files).toBeGreaterThan(1);
  });
});
