import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SECRET_LENGTH,
  DEVICE_SAFE_SECRET_LENGTH,
  SECRET_CHARS,
  generateRandomSecret,
  unbiasedCharIndex,
} from './randomSecret';

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

// #2577 — the alphabet is a CONTRACT, not an accident: generated secrets are
// pasted into IoT firmware credential fields, device apps and shell one-liners.
// A symbol that any of those mangles surfaces as "wrong username or password"
// at the device, which points the operator at themselves. These cases exist so
// a future "make secrets stronger by adding punctuation" edit fails here first.
describe('device-safe generation (#2577)', () => {
  it('the alphabet is exactly the 62 alphanumerics — no symbol can drift in', () => {
    expect(SECRET_CHARS).toBe(CHARS);
    expect(SECRET_CHARS).toHaveLength(62);
    expect(SECRET_CHARS).toMatch(/^[a-zA-Z0-9]+$/);
    // No duplicates — a repeated char would silently skew the distribution.
    expect(new Set(SECRET_CHARS).size).toBe(SECRET_CHARS.length);
    // Spelled out, because these are the exact classes that broke a device:
    // quotes/backslash (shell + YAML), whitespace (form trimming), and the
    // punctuation URL/HTTP-Basic encoders like to transform.
    for (const bad of ['"', "'", '\\', '`', '$', '@', ':', '/', '%', '#', '&', '!', '+', '=', ' ']) {
      expect(SECRET_CHARS).not.toContain(bad);
    }
    // …and the generator only ever emits from it.
    expect(generateRandomSecret(512)).toMatch(/^[a-zA-Z0-9]{512}$/);
  });

  it('carries strength in length: the device-safe profile is shorter but still ~142 bits', () => {
    expect(DEFAULT_SECRET_LENGTH).toBe(32);
    expect(DEVICE_SAFE_SECRET_LENGTH).toBe(24);

    const bits = (len: number) => len * Math.log2(SECRET_CHARS.length);
    // Shown, not claimed: both profiles are astronomically past any
    // brute-force reach against a hashed, network-rate-limited credential.
    expect(bits(DEFAULT_SECRET_LENGTH)).toBeGreaterThan(190);
    expect(bits(DEVICE_SAFE_SECRET_LENGTH)).toBeGreaterThan(142);
    // A floor, so nobody "fixes" a fussy device by shrinking this to 8.
    expect(bits(DEVICE_SAFE_SECRET_LENGTH)).toBeGreaterThan(128);
    // Adding the 33 ASCII symbols to a 24-char value would buy ~15 bits —
    // less than adding 3 more alphanumeric characters, at the cost of
    // devices that cannot accept it. That is the whole trade in one line.
    expect(bits(DEVICE_SAFE_SECRET_LENGTH + 3)).toBeGreaterThan(
      (DEVICE_SAFE_SECRET_LENGTH) * Math.log2(95),
    );
  });

  it('generates the device-safe profile at the requested length', () => {
    const s = generateRandomSecret(DEVICE_SAFE_SECRET_LENGTH);
    expect(s).toHaveLength(24);
    expect(s).toMatch(/^[a-zA-Z0-9]{24}$/);
  });
});
