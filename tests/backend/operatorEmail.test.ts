import { describe, it, expect } from 'vitest';
import { isValidOperatorEmail, operatorEmailIssue } from '@/lib/operatorEmail';

describe('isValidOperatorEmail', () => {
  it('accepts well-formed public-TLD addresses', () => {
    expect(isValidOperatorEmail('alice@example.com')).toBe(true);
    expect(isValidOperatorEmail('user.name+tag@sub.domain.co.uk')).toBe(true);
    expect(isValidOperatorEmail('  trim@example.org  ')).toBe(true);
  });

  it('rejects empty / malformed values', () => {
    expect(isValidOperatorEmail('')).toBe(false);
    expect(isValidOperatorEmail('   ')).toBe(false);
    expect(isValidOperatorEmail('plain-string')).toBe(false);
    expect(isValidOperatorEmail('no-at-sign.com')).toBe(false);
    expect(isValidOperatorEmail('@no-local-part.com')).toBe(false);
    expect(isValidOperatorEmail('missing-tld@host')).toBe(false);
    expect(isValidOperatorEmail('has spaces@example.com')).toBe(false);
  });

  it('rejects Let\'s-Encrypt-rejected TLDs', () => {
    expect(isValidOperatorEmail('admin@servicebay.local')).toBe(false);
    expect(isValidOperatorEmail('admin@home.localhost')).toBe(false);
    expect(isValidOperatorEmail('admin@anything.example')).toBe(false);
    expect(isValidOperatorEmail('admin@anything.test')).toBe(false);
    expect(isValidOperatorEmail('admin@anything.invalid')).toBe(false);
    // Case-insensitive
    expect(isValidOperatorEmail('admin@anything.LOCAL')).toBe(false);
  });
});

describe('operatorEmailIssue', () => {
  it('returns empty string for valid addresses', () => {
    expect(operatorEmailIssue('alice@example.com')).toBe('');
  });

  it('flags empty values with a required-field hint', () => {
    expect(operatorEmailIssue('')).toMatch(/required/i);
    expect(operatorEmailIssue('   ')).toMatch(/required/i);
  });

  it('flags malformed values', () => {
    expect(operatorEmailIssue('not-an-email')).toMatch(/email/i);
  });

  it('names the rejected TLD in the hint', () => {
    expect(operatorEmailIssue('admin@servicebay.local')).toMatch(/\.local/i);
    expect(operatorEmailIssue('admin@x.test')).toMatch(/\.test/i);
  });
});

describe('operator-email syntax check (ReDoS-free, #2261)', () => {
  // Behaviour parity: the linear scan must accept/reject exactly the same
  // inputs the old `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` regex did.
  const legacy = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const parityInputs = [
    'a@b.c',
    'a@b.c.d',
    'a@b..c', // legacy accepts (a . .c splits)
    'a@.b', // leading dot in domain → no label before dot
    'a@b.', // trailing dot → no label after
    'a@b', // no dot
    '@b.c', // empty local
    'a@', // empty domain
    'a.b@c.d',
    'user.name+tag@sub.domain.co.uk',
    'x@y.z@w.v', // two @ → reject
    'a b@c.d', // internal space → reject
    '',
    'plain',
  ];

  it('matches the legacy regex verdict on every parity input', () => {
    for (const s of parityInputs) {
      // isValidOperatorEmail also applies TLD rules; isolate the syntax layer
      // by using inputs whose TLDs aren't in the reject list, then compare the
      // "malformed" branch of operatorEmailIssue against the legacy regex.
      const syntacticOk = legacy.test(s.trim());
      const looksMalformed = operatorEmailIssue(s) === 'Doesn’t look like an email address';
      const requiredOrEmpty = !s || !s.trim();
      // operatorEmailIssue returns the required-hint for empty and the
      // malformed-hint for a syntactic failure; a syntactic pass yields either
      // '' or a TLD hint (never the malformed hint).
      if (requiredOrEmpty) {
        expect(looksMalformed).toBe(false);
      } else {
        expect(looksMalformed).toBe(!syntacticOk);
      }
    }
  });

  it('does not blow up on a pathological dot-free tail (ReDoS guard)', () => {
    const evil = 'a@' + 'a'.repeat(50000); // no dot → would force backtracking
    const start = Date.now();
    expect(isValidOperatorEmail(evil)).toBe(false);
    expect(operatorEmailIssue(evil)).toBe('Doesn’t look like an email address');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
