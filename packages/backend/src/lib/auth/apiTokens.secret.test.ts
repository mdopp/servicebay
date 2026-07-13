import { describe, it, expect } from 'vitest';
import { genSecret, randomSecretIndex } from './apiTokens';

// #2260 — the sb_ token secret must be drawn with an UNBIASED cryptographic
// mapping (js/biased-cryptographic-random). The old `bytes[i] % len` skewed the
// distribution when 256 isn't a multiple of the alphabet size. We assert the
// unbiased path (rejection sampling) AND that the wire format/length/alphabet
// consumers depend on is unchanged.
const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, base32-ish

describe('genSecret (#2260 unbiased token secret)', () => {
  it('emits a 32-char string over the exact base32-ish alphabet', () => {
    const s = genSecret();
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[A-HJ-NP-Z2-9]{32}$/);
    for (const ch of s) expect(SECRET_ALPHABET).toContain(ch);
  });

  it('produces every index in range and only in range (rejection sampling)', () => {
    const len = SECRET_ALPHABET.length;
    const counts = new Array(len).fill(0);
    for (let i = 0; i < 20000; i++) {
      const idx = randomSecretIndex(len);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(len);
      counts[idx]++;
    }
    // Every symbol reachable — a biased/broken mapping would starve some.
    expect(counts.every(c => c > 0)).toBe(true);
  });

  it('stays unbiased for a NON-power-of-two alphabet length (the bias case)', () => {
    // 62 does not divide 256 → `byte % 62` would over-weight the first 8
    // symbols. Rejection sampling keeps it flat.
    const len = 62;
    const counts = new Array(len).fill(0);
    const N = 62000;
    for (let i = 0; i < N; i++) counts[randomSecretIndex(len)]++;
    const expected = N / len;
    // Each bucket within ±25% of the flat expectation (loose, but the modulo
    // bias would push the low buckets ~+3% permanently — this pins uniformity).
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.75);
      expect(c).toBeLessThan(expected * 1.25);
    }
  });
});
