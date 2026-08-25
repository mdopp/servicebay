import { describe, it, expect } from 'vitest';
import {
  bulkConfirmPhrase,
  isSelectable,
  summarizeRevokeRun,
  tokensMatchingFilter,
  type TokenView,
} from './apiTokenSelection';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const DAY = 86_400_000;

const token = (over: Partial<TokenView> & { id: string }): TokenView => ({
  name: over.id,
  scopes: ['read'],
  prefix: 'ab12',
  createdAt: new Date(NOW - DAY).toISOString(),
  createdBy: 'admin',
  ...over,
});

const FLEET: TokenView[] = [
  token({ id: 'aaaaaaaa', name: 'fresh-read', lastUsedAt: new Date(NOW - DAY).toISOString(), expiresAt: new Date(NOW + DAY).toISOString() }),
  token({ id: 'bbbbbbbb', name: 'never-used-no-expiry' }),
  token({ id: 'cccccccc', name: 'old-destroy', scopes: ['read', 'destroy'], createdAt: new Date(NOW - 200 * DAY).toISOString(), lastUsedAt: new Date(NOW - 60 * DAY).toISOString() }),
  token({ id: 'dddddddd', name: 'lapsed', expiresAt: new Date(NOW - DAY).toISOString(), lastUsedAt: new Date(NOW - 5 * DAY).toISOString() }),
];

describe('selection filters (#2608)', () => {
  it('selects all never-used tokens', () => {
    expect(tokensMatchingFilter(FLEET, 'never-used', null, NOW)).toEqual(['bbbbbbbb']);
  });

  it('selects all tokens with no expiry — the state that dominates the real box', () => {
    expect(tokensMatchingFilter(FLEET, 'no-expiry', null, NOW)).toEqual(['bbbbbbbb', 'cccccccc']);
  });

  it('selects only tokens whose expiry has already passed', () => {
    expect(tokensMatchingFilter(FLEET, 'expired', null, NOW)).toEqual(['dddddddd']);
  });

  it('selects tokens minted more than 90 days ago', () => {
    expect(tokensMatchingFilter(FLEET, 'older-90d', null, NOW)).toEqual(['cccccccc']);
  });

  // The point of the exclusion: a filter is a bulk gesture, so the one token
  // that would log the operator out must never ride along in it.
  it('never includes the session’s own token, whichever filter is used', () => {
    for (const f of ['never-used', 'no-expiry', 'expired', 'older-90d'] as const) {
      expect(tokensMatchingFilter(FLEET, f, 'bbbbbbbb', NOW)).not.toContain('bbbbbbbb');
    }
    expect(isSelectable(FLEET[1], 'bbbbbbbb')).toBe(false);
    expect(isSelectable(FLEET[1], null)).toBe(true);
  });
});

describe('bulkConfirmPhrase (#2608 friction scales with blast radius)', () => {
  it('asks for a short phrase when nothing in the selection can destroy', () => {
    expect(bulkConfirmPhrase([FLEET[0], FLEET[1]])).toBe('revoke 2');
  });

  it('makes the operator type the destroy count when the selection carries destroy/exec/reboot', () => {
    expect(bulkConfirmPhrase([FLEET[0], FLEET[2]])).toBe('revoke 2 including 1 destroy');
    expect(bulkConfirmPhrase([token({ id: 'e', scopes: ['exec'] })])).toBe('revoke 1 including 1 destroy');
    expect(bulkConfirmPhrase([token({ id: 'f', scopes: ['reboot'] })])).toBe('revoke 1 including 1 destroy');
  });
});

describe('summarizeRevokeRun (#2461 at bulk scale)', () => {
  it('always names the denominator, success or not', () => {
    expect(summarizeRevokeRun(12, 12)).toBe('12 of 12 revoked.');
    expect(summarizeRevokeRun(12, 9)).toMatch(/^9 of 12 revoked —/);
    expect(summarizeRevokeRun(12, 0)).toMatch(/^0 of 12 revoked —/);
  });

  it('never reports a bare success for a run that revoked nothing', () => {
    expect(summarizeRevokeRun(12, 0)).toMatch(/still active/);
  });
});
