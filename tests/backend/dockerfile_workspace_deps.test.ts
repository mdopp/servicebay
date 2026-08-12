/**
 * Workspace manifests must be COPY'd before every `npm ci` in the images
 * (#2422).
 *
 * `npm ci` against a workspace root resolves `workspaces: ["packages/*"]` from
 * the on-disk tree, not from the lockfile. If a Dockerfile stage copies only
 * the ROOT package.json + package-lock.json, the glob matches nothing, npm
 * installs the root deps only and exits 0 — no warning. Everything declared in
 * packages/backend/package.json (ssh2, better-sqlite3, node-pty, nodemailer)
 * silently vanishes, and the pre-bundled server dies on first import with
 * "Cannot find module 'ssh2'".
 *
 * The production Dockerfile has carried that fix since #767; Dockerfile.dev
 * never got it and the dev container was unbootable until #2422. This test is
 * the guard for both — and for the next workspace member somebody adds under
 * packages/ without touching the images.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCKERFILES = ['Dockerfile', 'Dockerfile.dev'];

/** Workspace members on disk — every `packages/<name>/package.json`. */
function workspaceMembers(): string[] {
  const dir = path.join(REPO_ROOT, 'packages');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json')))
    .map((e) => e.name)
    .sort();
}

/** Split a Dockerfile into build stages; each `FROM` starts a new one. */
function stages(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (/^\s*FROM\s/i.test(line)) {
      current = [];
      out.push(current);
    }
    if (current) current.push(line);
  }
  return out;
}

describe('Dockerfile workspace dependency install (#2422)', () => {
  it('copies every workspace package.json before each `npm ci`', () => {
    const members = workspaceMembers();
    expect(members.length, 'expected workspace members under packages/').toBeGreaterThan(0);

    const problems: string[] = [];

    for (const file of DOCKERFILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      for (const stage of stages(text)) {
        const npmCi = stage.findIndex((l) => /^\s*RUN\s.*\bnpm ci\b/.test(l));
        if (npmCi === -1) continue;
        const before = stage.slice(0, npmCi);
        for (const m of members) {
          const copied = before.some((l) =>
            new RegExp(`^\\s*COPY\\s.*\\bpackages/${m}/package\\.json\\b`).test(l),
          );
          if (!copied) problems.push(`${file}: packages/${m}/package.json not copied before \`npm ci\``);
        }
      }
    }

    expect(
      problems,
      `Workspace manifests missing before \`npm ci\`:\n  ${problems.join('\n  ')}\n\n` +
        'Without them the workspaces glob resolves to nothing, npm ci installs only root deps ' +
        '(exit 0, no warning), and the image ships without ssh2/better-sqlite3/node-pty/nodemailer.',
    ).toEqual([]);
  });

  it('never hard-COPYs a concrete packages/<member>/node_modules across stages (#2528)', () => {
    // npm's hoisting decision is not stable across lockfile changes. When the
    // nodemailer ^9.0.3 → ^9.0.5 bump (547090c3) re-hoisted it to the root, the
    // deps stage stopped producing packages/backend/node_modules entirely and
    // `COPY --from=deps /app/packages/backend/node_modules ...` failed the whole
    // build with "not found" — three consecutive red release.yml runs, :dev
    // stale for 13 days. A stage that needs those modules must copy the whole
    // packages/ tree (which always exists) and merge what it finds.
    const problems: string[] = [];
    for (const file of DOCKERFILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
      for (const line of text.split('\n')) {
        if (/^\s*COPY\s.*\bpackages\/[A-Za-z0-9._-]+\/node_modules\b/.test(line)) {
          problems.push(`${file}: ${line.trim()}`);
        }
      }
    }

    expect(
      problems,
      `Dockerfile COPY of a concrete workspace node_modules path:\n  ${problems.join('\n  ')}\n\n` +
        'That directory only exists when npm happens to deoptimize hoisting for that ' +
        'workspace. Copy `/app/packages` and merge the node_modules you find instead.',
    ).toEqual([]);
  });

  it('Dockerfile.dev merges workspace-scoped node_modules into the root', () => {
    // npm deoptimizes hoisting for some packages (nodemailer today) and leaves
    // them in packages/backend/node_modules. dist-server/server.cjs require()s
    // them as externals and node resolves those from /app/node_modules only.
    const text = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.dev'), 'utf-8');
    expect(
      /packages\/\*\/node_modules/.test(text),
      'Dockerfile.dev must merge packages/*/node_modules into the root node_modules — ' +
        'otherwise a non-hoisted runtime dep (nodemailer) is unreachable from dist-server/server.cjs.',
    ).toBe(true);
  });
});
