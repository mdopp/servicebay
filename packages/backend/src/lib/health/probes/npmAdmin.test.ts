import { describe, it, expect } from 'vitest';

// Locating NPM (`findNpmAdminUrl`) moved to `lib/npm/client.ts` with #2730;
// its cases live in `lib/npm/client.test.ts`.
import { indexProxyHostBindings, isCertOrphaned } from './npmAdmin';

describe('cert → proxy-host binding (#2594)', () => {
  const hosts = [
    { id: 1, certificate_id: 7, domain_names: ['vault.example.com'] },
    { id: 2, certificate_id: 0, domain_names: ['plain.example.com'] },
  ];
  const bindings = indexProxyHostBindings(hosts);

  it('indexes both the selected cert ids and the served domains', () => {
    expect([...bindings.certIds]).toEqual([7]); // certificate_id 0 = "no cert"
    expect([...bindings.domains].sort()).toEqual(['plain.example.com', 'vault.example.com']);
  });

  it('survives a non-array / malformed body without throwing', () => {
    expect(indexProxyHostBindings(undefined).certIds.size).toBe(0);
    expect(indexProxyHostBindings([{ domain_names: 'nope' }]).domains.size).toBe(0);
  });

  it('is orphaned only when neither the id nor any domain is referenced', () => {
    expect(isCertOrphaned({ id: 7, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 7, domain_names: ['gone.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, bindings)).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['  VAULT.example.com '] }, bindings)).toBe(false);
  });

  it('treats a wildcard cert as in use while any host under it is served', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['*.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['*.other.com'] }, bindings)).toBe(true);
  });

  it('never reports orphaned when the host table is unknown, or the cert has no domains', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, null)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: [] }, bindings)).toBe(false);
  });
});
