import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isTrivialLine,
  parseDiff,
  readDiffFacts,
  tallyNewLines,
  verdict,
  type DiffCoverageConfig,
  type LineCoverage,
} from './check-diff-coverage';

const CONFIG: DiffCoverageConfig = { minLineCoverage: 70, minChangedLines: 10 };

// ---------------------------------------------------------------------------
// Fixture helpers: a throwaway git repo, so the move fixtures exercise the same
// `git diff` output CI parses rather than a hand-written approximation of it.
// ---------------------------------------------------------------------------
const repos: string[] = [];

function newRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'diffcov-'));
  repos.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf-8',
  });
}

function write(dir: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text.endsWith('\n') ? text : `${text}\n`);
}

function commit(dir: string, msg: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** A 12-line, non-trivial function — the thing a god-module cut relocates. */
const MOVED_FUNCTION = [
  'export function formatBytes(bytes: number): string {',
  '    const units = ["B", "KiB", "MiB", "GiB", "TiB"];',
  '    let value = Math.max(0, Number(bytes) || 0);',
  '    let unitIndex = 0;',
  '    while (value >= 1024 && unitIndex < units.length - 1) {',
  '        value = value / 1024;',
  '        unitIndex = unitIndex + 1;',
  '    }',
  '    const rounded = Math.round(value * 10) / 10;',
  '    const suffix = units[unitIndex];',
  '    return `${rounded} ${suffix}`;',
  '}',
];

/** Lines that are neither punctuation nor short — i.e. the exemptable ones. */
const MOVED_SUBSTANTIVE = MOVED_FUNCTION.filter(l => !isTrivialLine(l.trim()));

/** Mark every line of `rel` in [from,to] executable, and `coveredLines` covered. */
function coverage(
  dir: string,
  entries: { rel: string; from: number; to: number; covered?: number[] }[],
): Map<string, LineCoverage> {
  const map = new Map<string, LineCoverage>();
  for (const e of entries) {
    const executable = new Set<number>();
    for (let ln = e.from; ln <= e.to; ln++) executable.add(ln);
    map.set(path.resolve(dir, e.rel), { executable, covered: new Set(e.covered ?? []) });
  }
  return map;
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('isTrivialLine', () => {
  it('rejects punctuation, bare imports, comments and very short statements', () => {
    for (const l of ['}', '});', ')', '', '} else {', 'return;', '// note', '* doc', 'import { x } from "y";'])
      expect(isTrivialLine(l)).toBe(true);
  });

  it('accepts real statements', () => {
    expect(isTrivialLine('const rounded = Math.round(value * 10) / 10;')).toBe(false);
    expect(isTrivialLine('export function formatBytes(bytes: number): string {')).toBe(false);
  });
});

describe('parseDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -4,1 +4,2 @@',
    '-const removedButSubstantive = computeSomething(input);',
    '+const addedLineNumberFour = computeSomething(input);',
    '+const addedLineNumberFive = computeSomething(other);',
    '',
  ].join('\n');

  it('maps added lines to their new-side line numbers with their text', () => {
    const facts = parseDiff(diff, '/repo');
    const added = facts.addedByFile.get(path.resolve('/repo', 'src/a.ts'))!;
    expect([...added.keys()]).toEqual([4, 5]);
    expect(added.get(4)).toBe('const addedLineNumberFour = computeSomething(input);');
  });

  it('feeds removed lines into the move pool without mistaking the --- header for one', () => {
    const facts = parseDiff(diff, '/repo');
    expect(facts.basePool.has('const removedButSubstantive = computeSomething(input);')).toBe(true);
    expect([...facts.basePool].some(l => l.startsWith('a/src'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The #2762 acceptance fixtures.
// ---------------------------------------------------------------------------
describe('a verbatim move', () => {
  let dir: string;
  let base: string;

  beforeAll(() => {
    dir = newRepo();
    write(dir, 'src/runner.ts', ['export const NAME = "runner";', ...MOVED_FUNCTION].join('\n'));
    base = commit(dir, 'base');
    // The god-module cut: the function leaves runner.ts verbatim for phases/.
    write(dir, 'src/runner.ts', 'export const NAME = "runner";');
    write(dir, 'src/phases/format.ts', MOVED_FUNCTION.join('\n'));
    commit(dir, 'cut');
  });

  it('does not fail the floor on the moved lines alone, and reports them as exempt', () => {
    const facts = readDiffFacts(base, dir);
    // Worst case: the move lost its coverage attribution entirely.
    const tally = tallyNewLines(facts, coverage(dir, [{ rel: 'src/phases/format.ts', from: 1, to: 12 }]), dir);
    expect(tally.exemptMoved).toBe(MOVED_SUBSTANTIVE.length);
    expect(tally.totalNew).toBe(MOVED_FUNCTION.length - MOVED_SUBSTANTIVE.length);
    expect(verdict(tally, CONFIG).pass).toBe(true);
  });

  it('still exempts when the donor file was deleted outright, not just shrunk', () => {
    // A deleted file is invisible to the `--diff-filter=ACMR` diff, so its
    // lines reach the pool only through the `--name-status` pass. The move
    // target here is an existing file, so git cannot pair the two as a rename.
    const d = newRepo();
    write(d, 'src/gone.ts', MOVED_FUNCTION.join('\n'));
    write(d, 'src/keep.ts', 'export const NAME = "keep";');
    const b = commit(d, 'base');
    unlinkSync(path.join(d, 'src/gone.ts'));
    write(d, 'src/keep.ts', ['export const NAME = "keep";', ...MOVED_FUNCTION].join('\n'));
    commit(d, 'cut');

    const facts = readDiffFacts(b, d);
    const tally = tallyNewLines(facts, coverage(d, [{ rel: 'src/keep.ts', from: 2, to: 13 }]), d);
    expect(tally.exemptMoved).toBe(MOVED_SUBSTANTIVE.length);
    expect(verdict(tally, CONFIG).pass).toBe(true);
  });

  it('counts a moved line that IS covered as covered — the exemption never pads the numerator', () => {
    const facts = readDiffFacts(base, dir);
    const tally = tallyNewLines(
      facts,
      coverage(dir, [{ rel: 'src/phases/format.ts', from: 1, to: 12, covered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }]),
      dir,
    );
    expect(tally.exemptMoved).toBe(0);
    expect(tally.coveredNew).toBe(12);
    expect(tally.totalNew).toBe(12);
  });
});

describe('genuinely new logic', () => {
  it('still fails the floor when it is uncovered (no regression in the gate)', () => {
    const dir = newRepo();
    write(dir, 'src/keep.ts', 'export const NAME = "keep";');
    const base = commit(dir, 'base');
    write(dir, 'src/fresh.ts', MOVED_FUNCTION.join('\n')); // same text, but nothing left the tree
    commit(dir, 'new logic');

    const tally = tallyNewLines(readDiffFacts(base, dir), coverage(dir, [{ rel: 'src/fresh.ts', from: 1, to: 12 }]), dir);
    expect(tally.exemptMoved).toBe(0);
    expect(tally.totalNew).toBe(12);
    const v = verdict(tally, CONFIG);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('below-floor');
  });

  it('is not rescued by a move happening in the same diff', () => {
    const dir = newRepo();
    write(dir, 'src/runner.ts', ['export const NAME = "runner";', ...MOVED_FUNCTION].join('\n'));
    const base = commit(dir, 'base');
    write(dir, 'src/runner.ts', 'export const NAME = "runner";');
    write(dir, 'src/phases/format.ts', MOVED_FUNCTION.join('\n'));
    write(
      dir,
      'src/phases/brandnew.ts',
      Array.from({ length: 12 }, (_, i) => `export const freshConstantNumber${i} = computeSomething(${i});`).join('\n'),
    );
    commit(dir, 'cut plus new logic');

    const tally = tallyNewLines(
      readDiffFacts(base, dir),
      coverage(dir, [
        { rel: 'src/phases/format.ts', from: 1, to: 12 },
        { rel: 'src/phases/brandnew.ts', from: 1, to: 12, covered: [1, 2, 3, 4, 5] },
      ]),
      dir,
    );
    expect(tally.exemptMoved).toBe(MOVED_SUBSTANTIVE.length);
    expect(tally.totalNew).toBe(12 + (MOVED_FUNCTION.length - MOVED_SUBSTANTIVE.length));
    const v = verdict(tally, CONFIG);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('below-floor');
  });
});
