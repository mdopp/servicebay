/**
 * `npm run standards:bootstrap` CLI (#2513).
 *
 * The bootstrap step is only real if its mechanics are a command that fails
 * loudly — prose an agent re-interprets is the thing that broke (CLAUDE.md
 * § "Deterministic execution → scripts"). So the exit codes are the contract:
 * `--check` exits 1 on a repo whose CLAUDE.md has no pointer into the standards
 * catalog, and `--write` makes it exit 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, resolveClaudeMd } from '../../scripts/bootstrap-service-repo';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-service-repo.ts');

/** Run the CLI; returns `{ code, out }` instead of throwing on a non-zero exit. */
function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('standards:bootstrap argument parsing', () => {
  it('defaults to printing the servicebay block', () => {
    expect(parseArgs([])).toEqual({ mode: 'print', target: '.', flavor: 'servicebay' });
  });

  it('takes the target after --write/--check, and bare', () => {
    expect(parseArgs(['--write', '/tmp/repo'])).toEqual({ mode: 'write', target: '/tmp/repo', flavor: 'servicebay' });
    expect(parseArgs(['--check', '/tmp/repo'])).toEqual({ mode: 'check', target: '/tmp/repo', flavor: 'servicebay' });
    expect(parseArgs(['--check'])).toEqual({ mode: 'check', target: '.', flavor: 'servicebay' });
  });

  // #2701: a project that does not run on a ServiceBay box needs the generic
  // block — the flavor that carries the cross-repo working agreements.
  it('selects the generic flavor and keeps the target', () => {
    expect(parseArgs(['--flavor', 'generic', '--write', '/tmp/repo'])).toEqual({
      mode: 'write',
      target: '/tmp/repo',
      flavor: 'generic',
    });
    expect(() => parseArgs(['--flavor', 'nonsense'])).toThrow(/--flavor expects/);
  });

  it('accepts a repo dir or the CLAUDE.md path itself', () => {
    expect(resolveClaudeMd(REPO_ROOT)).toBe(path.join(REPO_ROOT, 'CLAUDE.md'));
    expect(resolveClaudeMd(path.join(REPO_ROOT, 'CLAUDE.md'))).toBe(path.join(REPO_ROOT, 'CLAUDE.md'));
  });
});

describe('standards:bootstrap CLI on a fresh service repo', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'sb-bootstrap-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('--check fails a repo with no CLAUDE.md at all', () => {
    const { code, out } = run(['--check', repo]);
    expect(code).toBe(1);
    expect(out).toMatch(/does not exist/);
  });

  it('--check fails, --write fixes it, --check then passes', () => {
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# chronicle\n\nHouse rules.\n', 'utf-8');
    expect(run(['--check', repo]).code).toBe(1);

    const written = run(['--write', repo]);
    expect(written.code).toBe(0);
    const md = readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('House rules.');
    expect(md).toContain('get_service_standards');

    expect(run(['--check', repo]).code).toBe(0);
  });

  it('--print emits the block without touching the tree', () => {
    const { code, out } = run(['--print']);
    expect(code).toBe(0);
    expect(out).toContain('get_service_standards');
    expect(existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false);
  });
}, 60_000);
