/**
 * requiresApi parser + compatibility check (#588).
 *
 * Templates declare `servicebay.requires-api.<name>: "<integer>"` for
 * each ServiceBay-internal `/api/system/<name>/*` surface their
 * `post-deploy.py` calls. The manifest parser surfaces them; the
 * compat helper refuses deploys that need an API version core can't
 * provide.
 */

import { describe, it, expect } from 'vitest';
import { parseTemplateManifest, tryParseTemplateManifest } from '@/lib/template/contract';
import { assertApiCompat, SUPPORTED_API_VERSIONS } from '@/lib/template/apiVersions';

const baseYaml = (extraAnnotations: string) => `
apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
    servicebay.label: "Example"
${extraAnnotations}
spec:
  containers:
    - name: ex
      image: example.com/ex:latest
`;

describe('parseTemplateManifest — requiresApi (#588)', () => {
  it('returns undefined when no requires-api annotation is present', () => {
    const r = parseTemplateManifest(baseYaml(''));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.requiresApi).toBeUndefined();
  });

  it('parses a single requires-api.lldap annotation', () => {
    const r = parseTemplateManifest(baseYaml('    servicebay.requires-api.lldap: "1"'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.requiresApi).toEqual({ lldap: 1 });
  });

  it('parses multiple requires-api annotations in one template', () => {
    const r = parseTemplateManifest(baseYaml(
      '    servicebay.requires-api.lldap: "1"\n' +
      '    servicebay.requires-api.authelia: "1"',
    ));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.requiresApi).toEqual({ lldap: 1, authelia: 1 });
  });

  it('rejects a non-integer requires-api value', () => {
    const r = parseTemplateManifest(baseYaml('    servicebay.requires-api.lldap: "v1"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.includes('requires-api.lldap'))).toBe(true);
  });

  it('rejects a zero / negative requires-api value', () => {
    for (const v of ['0', '-1']) {
      const r = parseTemplateManifest(baseYaml(`    servicebay.requires-api.lldap: "${v}"`));
      expect(r.ok, `value=${v}`).toBe(false);
    }
  });
});

describe('assertApiCompat (#588)', () => {
  it('passes when the template requests nothing', () => {
    expect(() => assertApiCompat('tpl', undefined)).not.toThrow();
    expect(() => assertApiCompat('tpl', {})).not.toThrow();
  });

  it('passes when the template requests versions core supports', () => {
    expect(() =>
      assertApiCompat('tpl', { lldap: SUPPORTED_API_VERSIONS.lldap, authelia: SUPPORTED_API_VERSIONS.authelia }),
    ).not.toThrow();
  });

  it('refuses when the template needs a version core does not provide', () => {
    const tooNew = SUPPORTED_API_VERSIONS.lldap + 1;
    expect(() => assertApiCompat('tpl', { lldap: tooNew })).toThrow(/lldap.*v\d+/);
  });

  it('refuses an unknown API name', () => {
    // @ts-expect-error — intentional bad input
    expect(() => assertApiCompat('tpl', { bogus: 1 })).toThrow(/unknown API/i);
  });
});

describe('bundled templates declare requiresApi where appropriate', () => {
  it('templates/auth declares lldap + authelia (its post-deploy hits both)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const yaml = fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'auth', 'template.yml'), 'utf-8');
    const manifest = tryParseTemplateManifest(yaml);
    expect(manifest?.requiresApi).toMatchObject({ lldap: 1, authelia: 1 });
  });
});
