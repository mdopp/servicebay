import { describe, it, expect } from 'vitest';
import { findDuplicates, normalizeLine } from '../../scripts/check-frontend-dup';

// #2354 — pure-logic tests for the frontend duplicate-JSX detector. The core
// (findDuplicates / normalizeLine) is deterministic and importable, so we can
// assert its clustering behaviour without touching the filesystem or the tuned
// repo threshold (tests pass minLines explicitly).

describe('normalizeLine', () => {
  it('drops blank lines, comments, and import/export-from lines', () => {
    expect(normalizeLine('   ')).toBeNull();
    expect(normalizeLine('// a comment')).toBeNull();
    expect(normalizeLine('/* block */')).toBeNull();
    expect(normalizeLine(' * jsdoc continuation')).toBeNull();
    expect(normalizeLine("import { X } from 'y'")).toBeNull();
    expect(normalizeLine("export { X } from './x'")).toBeNull();
    expect(normalizeLine('export * from "./barrel"')).toBeNull();
  });

  it('collapses internal whitespace so cosmetic diffs match', () => {
    expect(normalizeLine('  foo(  a ,  b )  ')).toBe('foo( a , b )');
    expect(normalizeLine('foo(a, b)')).toBe('foo(a, b)');
  });

  it('keeps genuinely different lines distinct', () => {
    expect(normalizeLine('const a = 1;')).not.toBe(normalizeLine('const b = 2;'));
  });
});

describe('findDuplicates', () => {
  const block = (label: string) =>
    Array.from({ length: 5 }, (_, i) => `line ${label} ${i}`).join('\n');

  it('returns nothing when no window repeats', () => {
    const files = new Map<string, string>([
      ['a.tsx', block('A')],
      ['b.tsx', block('B')],
    ]);
    expect(findDuplicates(files, 5)).toEqual([]);
  });

  it('flags an identical block duplicated across two files', () => {
    const shared = block('SHARED');
    const files = new Map<string, string>([
      ['a.tsx', `const top = 1;\n${shared}\nconst tail = 2;`],
      ['b.tsx', `const other = 9;\n${shared}\nconst z = 3;`],
    ]);
    const dups = findDuplicates(files, 5);
    expect(dups.length).toBeGreaterThan(0);
    const top = dups[0];
    expect(top.occurrences.length).toBe(2);
    expect(top.occurrences.map((o) => o.file).sort()).toEqual(['a.tsx', 'b.tsx']);
    // The reported start lines point at the block (line 2 in each file).
    expect(top.occurrences.every((o) => o.line === 2)).toBe(true);
  });

  it('detects duplication WITHIN a single file (same Card rendered twice inline)', () => {
    const shared = block('INLINE');
    const files = new Map<string, string>([['a.tsx', `${shared}\nconst x = 0;\n${shared}`]]);
    const dups = findDuplicates(files, 5);
    expect(dups.length).toBeGreaterThan(0);
    expect(dups[0].occurrences.length).toBeGreaterThanOrEqual(2);
    expect(dups[0].occurrences.every((o) => o.file === 'a.tsx')).toBe(true);
  });

  it('ignores blocks shorter than the threshold', () => {
    const three = 'a\nb\nc';
    const files = new Map<string, string>([
      ['a.tsx', three],
      ['b.tsx', three],
    ]);
    expect(findDuplicates(files, 8)).toEqual([]);
  });

  it('ranks the most-duplicated block first', () => {
    const many = block('MANY');
    const twice = block('TWICE');
    const files = new Map<string, string>([
      ['a.tsx', `${many}\nx\n${twice}`],
      ['b.tsx', `${many}\ny\n${twice}`],
      ['c.tsx', many],
    ]);
    const dups = findDuplicates(files, 5);
    // MANY appears in 3 files, TWICE in 2 → MANY ranks first.
    expect(dups[0].occurrences.length).toBe(3);
  });
});
