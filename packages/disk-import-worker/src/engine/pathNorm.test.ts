import { describe, it, expect } from 'vitest';
import { normPath } from './pathNorm';

describe('normPath (backtracking-free path normalisation, #2255)', () => {
  it('strips leading and trailing slash runs by default', () => {
    expect(normPath('/a/b/')).toBe('a/b');
    expect(normPath('///a/b///')).toBe('a/b');
    expect(normPath('a/b')).toBe('a/b');
  });

  it('preserves internal slashes verbatim (only leading/trailing runs are touched)', () => {
    expect(normPath('a//b')).toBe('a//b');
    expect(normPath('/a//b/')).toBe('a//b');
  });

  it('handles empty and all-slash input', () => {
    expect(normPath('')).toBe('');
    expect(normPath('/')).toBe('');
    expect(normPath('////')).toBe('');
  });

  it('converts backslashes to forward slashes when asked', () => {
    expect(normPath('a\\b\\c', { backslashToSlash: true })).toBe('a/b/c');
    expect(normPath('\\a\\b\\', { backslashToSlash: true })).toBe('a/b');
  });

  it('leaves backslashes alone when the option is off (topLevelSegment behaviour)', () => {
    expect(normPath('a\\b')).toBe('a\\b');
  });

  it('KEEPS the leading slash when stripLeading is false (mountBase base case)', () => {
    // lazyTree.ts:98 deliberately keeps the leading slash so an absolute source
    // path (`/mnt/src/...`) still matches the mount base.
    expect(normPath('/mnt/src/', { backslashToSlash: true, stripLeading: false })).toBe('/mnt/src');
    expect(normPath('/mnt/src///', { backslashToSlash: true, stripLeading: false })).toBe('/mnt/src');
    expect(normPath('C:\\mnt\\src\\', { backslashToSlash: true, stripLeading: false })).toBe('C:/mnt/src');
  });

  it('matches the old chained-regex behaviour exactly across sample inputs', () => {
    const oldNormDir = (rel: string) => rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const oldBase = (b: string) => b.replace(/\\/g, '/').replace(/\/+$/, '');
    const oldTop = (d: string) => d.replace(/^\/+/, '').replace(/\/+$/, '');
    const samples = ['', '/', '//', 'a', '/a', 'a/', '/a/', 'a/b/c', '\\a\\b', '/mnt/src/', 'a//b', '///x///'];
    for (const s of samples) {
      expect(normPath(s, { backslashToSlash: true })).toBe(oldNormDir(s));
      expect(normPath(s, { backslashToSlash: true, stripLeading: false })).toBe(oldBase(s));
      expect(normPath(s)).toBe(oldTop(s));
    }
  });
});
