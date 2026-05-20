/**
 * Unit tests for the unified template manifest parser (#585).
 *
 * Exercises every rule the contract claims to enforce. The big-picture
 * "every bundled template parses cleanly" assertion lives in
 * template_consistency.test.ts; this file focuses on edge cases for
 * the parser itself.
 */

import { describe, it, expect } from 'vitest';
import { parseTemplateManifest, tryParseTemplateManifest } from '@/lib/template/contract';

function fixture(annotations: Record<string, string | number>, opts: { quotes?: 'double' | 'single' | 'bare' } = {}) {
  const quotes = opts.quotes ?? 'double';
  const fmt = (v: string | number): string => {
    if (typeof v === 'number') return String(v);
    if (quotes === 'double') return `"${v}"`;
    if (quotes === 'single') return `'${v}'`;
    return String(v);
  };
  const lines = Object.entries(annotations).map(([k, v]) => `    ${k}: ${fmt(v)}`);
  return `apiVersion: v1
kind: Pod
metadata:
  name: example
  annotations:
${lines.join('\n')}
spec:
  containers:
    - name: ex
      image: example.com/ex:latest
`;
}

describe('parseTemplateManifest — happy path', () => {
  it('parses a fully-annotated template', () => {
    const r = parseTemplateManifest(
      fixture({
        'servicebay.label': 'Example',
        'servicebay.ports': '8080/tcp',
        'servicebay.schema-version': '2',
        'servicebay.tier': 'feature',
        'servicebay.dependencies': 'nginx,auth',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({
      label: 'Example',
      ports: '8080/tcp',
      schemaVersion: 2,
      tier: 'feature',
      dependencies: ['nginx', 'auth'],
    });
  });

  it('applies defaults for every optional field', () => {
    const r = parseTemplateManifest(fixture({ 'servicebay.label': 'Just Label' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toEqual({
      label: 'Just Label',
      tier: 'feature',
      schemaVersion: 1,
      dependencies: [],
      configMount: undefined,
      ports: undefined,
    });
  });

  it('accepts annotations with single quotes and bare strings', () => {
    for (const quotes of ['double', 'single', 'bare'] as const) {
      const r = parseTemplateManifest(fixture({ 'servicebay.label': 'Quoted' }, { quotes }));
      expect(r.ok, `quotes=${quotes}`).toBe(true);
      if (r.ok) expect(r.manifest.label).toBe('Quoted');
    }
  });

  it('trims whitespace in dependency lists and drops empties', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X', 'servicebay.dependencies': '  nginx , , auth ,' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.dependencies).toEqual(['nginx', 'auth']);
  });
});

describe('parseTemplateManifest — required fields', () => {
  it('flags missing servicebay.label as an error', () => {
    const r = parseTemplateManifest(fixture({ 'servicebay.tier': 'feature' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('servicebay.label'))).toBe(true);
  });

  it('config-mount is required when hasMustacheConfigs is true', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X' }),
      { hasMustacheConfigs: true },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('servicebay.config-mount'))).toBe(true);
  });

  it('config-mount is optional when hasMustacheConfigs is false', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X' }),
      { hasMustacheConfigs: false },
    );
    expect(r.ok).toBe(true);
  });

  it('config-mount satisfies the requirement when present', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X', 'servicebay.config-mount': '/etc/myapp' }),
      { hasMustacheConfigs: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.configMount).toBe('/etc/myapp');
  });
});

describe('parseTemplateManifest — invalid values', () => {
  it('rejects an unknown tier', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X', 'servicebay.tier': 'platform' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('servicebay.tier') && e.includes('platform'))).toBe(true);
  });

  it('rejects a non-integer schema-version', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.label': 'X', 'servicebay.schema-version': '1.5' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('servicebay.schema-version'))).toBe(true);
  });

  it('rejects a zero/negative schema-version', () => {
    for (const v of ['0', '-1']) {
      const r = parseTemplateManifest(
        fixture({ 'servicebay.label': 'X', 'servicebay.schema-version': v }),
      );
      expect(r.ok, `schema-version=${v}`).toBe(false);
    }
  });

  it('collects multiple errors in one pass instead of bailing on the first', () => {
    const r = parseTemplateManifest(
      fixture({ 'servicebay.tier': 'platform', 'servicebay.schema-version': 'one' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // label missing + tier invalid + schema-version invalid
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('tryParseTemplateManifest', () => {
  it('returns the manifest on success', () => {
    const m = tryParseTemplateManifest(fixture({ 'servicebay.label': 'X' }));
    expect(m?.label).toBe('X');
  });

  it('returns null on failure', () => {
    const m = tryParseTemplateManifest(fixture({}));
    expect(m).toBeNull();
  });
});
