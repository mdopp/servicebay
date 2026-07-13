import { describe, it, expect } from 'vitest';
import { generateRandomSecret, unbiasedCharIndex } from './randomSecret';

// #2260 — the install-flow secret pre-fill must use an UNBIASED cryptographic
// mapping (js/biased-cryptographic-random). Old `byte % 62` skewed the picks.
// Assert the unbiased path + unchanged length/alphabet (memorized-secret shape
// must stay stable per the module's contract).
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 62

describe('generateRandomSecret (#2260 unbiased)', () => {
  it('emits the requested length over the exact 62-char alphabet', () => {
    expect(generateRandomSecret()).toHaveLength(32);
    const s = generateRandomSecret(48);
    expect(s).toHaveLength(48);
    expect(s).toMatch(/^[a-zA-Z0-9]{48}$/);
    for (const ch of s) expect(CHARS).toContain(ch);
  });

  it('every index in range, all reachable (rejection sampling)', () => {
    const len = CHARS.length;
    const counts = new Array(len).fill(0);
    for (let i = 0; i < 20000; i++) {
      const idx = unbiasedCharIndex(len);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(len);
      counts[idx]++;
    }
    expect(counts.every(c => c > 0)).toBe(true);
  });

  it('stays unbiased over the 62-char alphabet (the modulo-bias case)', () => {
    const len = CHARS.length; // 62 — does not divide 256
    const counts = new Array(len).fill(0);
    const N = 62000;
    for (let i = 0; i < N; i++) counts[unbiasedCharIndex(len)]++;
    const expected = N / len;
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.75);
      expect(c).toBeLessThan(expected * 1.25);
    }
  });
});
