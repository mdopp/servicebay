import { describe, it, expect } from 'vitest';
import { revisionMatchesSha } from './autoloop-dev-verify';

const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 40-char git sha
const SHORT = 'a1b2c3d4'; // harness's short sha

describe('revisionMatchesSha', () => {
  it('accepts the full revision label against the short expected sha (prefix match)', () => {
    expect(revisionMatchesSha(FULL, SHORT)).toBe(true);
  });

  it('accepts the full revision label against the full expected sha', () => {
    expect(revisionMatchesSha(FULL, FULL)).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(revisionMatchesSha(`  ${FULL.toUpperCase()}\n`, SHORT)).toBe(true);
  });

  it('rejects a different sha even if it shares no prefix', () => {
    expect(revisionMatchesSha(FULL, 'deadbeef')).toBe(false);
  });

  it('REJECTS a tag name (…:dev) as a non-match — the old bug', () => {
    expect(revisionMatchesSha('ghcr.io/mdopp/servicebay:dev', SHORT)).toBe(false);
    expect(revisionMatchesSha('dev', SHORT)).toBe(false);
  });

  it('rejects an empty revision label (image not built / not readable)', () => {
    expect(revisionMatchesSha('', SHORT)).toBe(false);
    expect(revisionMatchesSha('   ', FULL)).toBe(false);
  });

  it('rejects an empty or non-hex expected sha rather than matching everything', () => {
    expect(revisionMatchesSha(FULL, '')).toBe(false);
    expect(revisionMatchesSha(FULL, ':dev')).toBe(false);
  });
});
