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
