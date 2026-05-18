/**
 * Stack manifest parser — #624.
 *
 * Validates the shape both `getStackManifest` (registry runtime) and the
 * `stack_consistency` build-time lint rely on. Each test is a single
 * input + expected outcome — failures point at one rule.
 */
import { describe, it, expect } from 'vitest';
import { parseStackManifest, tryParseStackManifest } from './stackContract';

const VALID_BASIC = `apiVersion: v1
kind: Stack
metadata:
  name: basic
  annotations:
    servicebay.label: "Core services"
    servicebay.tier: "core"
    servicebay.lifecycle: "atomic-wipe"
    servicebay.depends-on-stacks: ""
spec:
  templates: [nginx, auth, adguard]
`;

const VALID_FEATURE = `apiVersion: v1
kind: Stack
metadata:
  name: immich
  annotations:
    servicebay.label: "Immich (Photos + AI search)"
    servicebay.depends-on-stacks: "basic"
spec:
  templates:
    - immich
`;

describe('parseStackManifest — happy paths', () => {
  it('parses a complete core stack manifest', () => {
    const r = parseStackManifest(VALID_BASIC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toEqual({
      name: 'basic',
      label: 'Core services',
      tier: 'core',
      lifecycle: 'atomic-wipe',
      dependsOnStacks: [],
      templates: ['nginx', 'auth', 'adguard'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('parses a feature stack and applies defaults (tier=feature, lifecycle=wipeable)', () => {
    const r = parseStackManifest(VALID_FEATURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.tier).toBe('feature');
    expect(r.manifest.lifecycle).toBe('wipeable');
    expect(r.manifest.dependsOnStacks).toEqual(['basic']);
    expect(r.manifest.templates).toEqual(['immich']);
  });

  it('handles comma-separated depends-on-stacks lists', () => {
    const yamlText = VALID_FEATURE.replace('"basic"', '"basic, identity ,  media "');
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.dependsOnStacks).toEqual(['basic', 'identity', 'media']);
  });

  it('tryParseStackManifest returns the manifest on success', () => {
    expect(tryParseStackManifest(VALID_BASIC)?.name).toBe('basic');
  });
});

describe('parseStackManifest — structural errors', () => {
  it('rejects non-mapping top-level documents', () => {
    const r = parseStackManifest('- a\n- b\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/must be a YAML mapping/);
  });

  it('rejects malformed YAML with the parser error', () => {
    const r = parseStackManifest('apiVersion: v1\n  bad: indent\n: missing-key');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/not valid YAML/);
  });

  it('rejects missing apiVersion / kind', () => {
    const r = parseStackManifest(`metadata:
  name: x
  annotations:
    servicebay.label: "x"
spec:
  templates: [foo]
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /apiVersion/.test(e))).toBe(true);
    expect(r.errors.some(e => /kind/.test(e))).toBe(true);
  });

  it('rejects missing metadata.name', () => {
    const r = parseStackManifest(`apiVersion: v1
kind: Stack
metadata:
  annotations:
    servicebay.label: "x"
spec:
  templates: [foo]
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /metadata\.name/.test(e))).toBe(true);
  });

  it('rejects missing servicebay.label', () => {
    const r = parseStackManifest(`apiVersion: v1
kind: Stack
metadata:
  name: x
spec:
  templates: [foo]
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /servicebay\.label/.test(e))).toBe(true);
  });
});

describe('parseStackManifest — annotation validation', () => {
  it('rejects unknown tier values', () => {
    const yamlText = VALID_BASIC.replace('"core"', '"platform"');
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/servicebay\.tier.*core.*feature/);
  });

  it('rejects unknown lifecycle values', () => {
    const yamlText = VALID_BASIC.replace('"atomic-wipe"', '"reincarnate"');
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/servicebay\.lifecycle.*atomic-wipe.*wipeable/);
  });

  it('warns when atomic-wipe is used on a non-core tier', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
    servicebay.tier: "feature"
    servicebay.lifecycle: "atomic-wipe"
spec:
  templates: [foo]
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some(w => /atomic-wipe.*core/.test(w))).toBe(true);
  });
});

describe('parseStackManifest — spec.templates validation', () => {
  it('rejects a missing spec.templates field', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
spec:
  somethingElse: 1
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /spec\.templates/.test(e))).toBe(true);
  });

  it('rejects an empty spec.templates list', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
spec:
  templates: []
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /spec\.templates.* is empty/.test(e))).toBe(true);
  });

  it('rejects non-string entries in spec.templates', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
spec:
  templates:
    - foo
    - 42
    - ""
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /spec\.templates\[1\]/.test(e))).toBe(true);
    expect(r.errors.some(e => /spec\.templates\[2\]/.test(e))).toBe(true);
  });

  it('rejects duplicate templates', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
spec:
  templates: [a, b, a, c, b]
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /duplicates.*a.*b/.test(e))).toBe(true);
  });
});

describe('parseStackManifest — self-dep', () => {
  it('rejects a stack that lists itself in depends-on-stacks', () => {
    const yamlText = `apiVersion: v1
kind: Stack
metadata:
  name: foo
  annotations:
    servicebay.label: "Foo"
    servicebay.depends-on-stacks: "bar, foo"
spec:
  templates: [foo]
`;
    const r = parseStackManifest(yamlText);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => /cannot depend on itself/.test(e))).toBe(true);
  });
});
