import { describe, it, expect } from 'vitest';
import { parseTemplateDependencies, topoSortByDependencies, resolveAlreadyInstalled } from './dependencies';

describe('resolveAlreadyInstalled', () => {
  it('counts node-deployed templates as satisfiers even when not re-selected', () => {
    // The hermes → home-assistant case: HA is deployed on the node but not in
    // this install batch. It must still satisfy the dependency.
    const set = resolveAlreadyInstalled(
      [{ name: 'hermes' }, { name: 'ollama' }],
      ['home-assistant', 'nginx', 'auth'],
    );
    expect(set.has('home-assistant')).toBe(true);

    const result = topoSortByDependencies(
      [{ name: 'hermes', dependencies: ['home-assistant'] }],
      { alreadyInstalled: set },
    );
    expect(result.ok).toBe(true);
  });

  it('also folds in batch items flagged alreadyInstalled', () => {
    const set = resolveAlreadyInstalled(
      [{ name: 'auth', alreadyInstalled: true }, { name: 'vaultwarden' }],
      [],
    );
    expect(set.has('auth')).toBe(true);
    expect(set.has('vaultwarden')).toBe(false);
  });
});

describe('parseTemplateDependencies', () => {
  it('returns empty array when annotation missing', () => {
    expect(parseTemplateDependencies('apiVersion: v1\nkind: Pod\n')).toEqual([]);
  });

  it('parses a comma-separated list', () => {
    const yaml = `
metadata:
  annotations:
    servicebay.dependencies: "nginx,auth"
`;
    expect(parseTemplateDependencies(yaml)).toEqual(['nginx', 'auth']);
  });

  it('trims whitespace between names', () => {
    const yaml = `
metadata:
  annotations:
    servicebay.dependencies: "nginx, auth ,  adguard"
`;
    expect(parseTemplateDependencies(yaml)).toEqual(['nginx', 'auth', 'adguard']);
  });

  it('returns empty array for empty/blank annotation value', () => {
    const yaml1 = `\n    servicebay.dependencies: ""\n`;
    const yaml2 = `\n    servicebay.dependencies:    \n`;
    expect(parseTemplateDependencies(yaml1)).toEqual([]);
    expect(parseTemplateDependencies(yaml2)).toEqual([]);
  });

  it('accepts a single dep without quotes', () => {
    const yaml = `\n    servicebay.dependencies: nginx\n`;
    expect(parseTemplateDependencies(yaml)).toEqual(['nginx']);
  });

  it('returns empty array on undefined input', () => {
    expect(parseTemplateDependencies(undefined)).toEqual([]);
  });
});

describe('topoSortByDependencies', () => {
  it('keeps input order when there are no dependencies', () => {
    const result = topoSortByDependencies([
      { name: 'nginx', dependencies: [] },
      { name: 'auth', dependencies: [] },
      { name: 'adguard', dependencies: [] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ordered.map(i => i.name)).toEqual(['nginx', 'auth', 'adguard']);
  });

  it('moves deps in front of dependents', () => {
    // input order is "wrong" — dependents listed first
    const result = topoSortByDependencies([
      { name: 'vaultwarden', dependencies: ['nginx', 'auth'] },
      { name: 'media', dependencies: ['nginx', 'auth'] },
      { name: 'nginx', dependencies: [] },
      { name: 'auth', dependencies: [] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.ordered.map(i => i.name);
      expect(names.indexOf('nginx')).toBeLessThan(names.indexOf('vaultwarden'));
      expect(names.indexOf('nginx')).toBeLessThan(names.indexOf('media'));
      expect(names.indexOf('auth')).toBeLessThan(names.indexOf('vaultwarden'));
      expect(names.indexOf('auth')).toBeLessThan(names.indexOf('media'));
    }
  });

  it('returns missing when a dep is not selected and not already-installed', () => {
    const result = topoSortByDependencies([
      { name: 'vaultwarden', dependencies: ['nginx', 'auth'] },
      { name: 'nginx', dependencies: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'missing') {
      expect(result.item).toBe('vaultwarden');
      expect(result.missing).toEqual(['auth']);
    } else {
      throw new Error('expected missing failure');
    }
  });

  it('treats alreadyInstalled deps as satisfied', () => {
    const result = topoSortByDependencies(
      [{ name: 'vaultwarden', dependencies: ['nginx', 'auth'] }],
      { alreadyInstalled: new Set(['nginx', 'auth']) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ordered.map(i => i.name)).toEqual(['vaultwarden']);
  });

  it('detects cycles', () => {
    const result = topoSortByDependencies([
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'cycle') {
      expect(result.involved.sort()).toEqual(['a', 'b']);
    } else {
      throw new Error('expected cycle failure');
    }
  });

  it('is stable across same-depth ties', () => {
    // adguard and auth both have no deps and don't depend on each other.
    // Input order is auth-first; output should preserve that.
    const result = topoSortByDependencies([
      { name: 'auth', dependencies: [] },
      { name: 'adguard', dependencies: [] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ordered.map(i => i.name)).toEqual(['auth', 'adguard']);
  });

  // #796 — infrastructure-tier items must precede every feature-tier
  // item in the result, regardless of input order, because a feature
  // that registers against e.g. NPM before its credentials are
  // verified can lose its registration to a late infrastructure-level
  // self-heal.
  describe('tier-implicit edges (#796)', () => {
    it('puts all infrastructure items before any feature item', () => {
      // Reproduces the bug timeline: ollama+hermes (feature) appear
      // first in the input, but should run AFTER nginx/auth/adguard
      // (infrastructure) regardless.
      const result = topoSortByDependencies([
        { name: 'ollama', dependencies: [], tier: 'feature' },
        { name: 'hermes', dependencies: [], tier: 'feature' },
        { name: 'nginx', dependencies: [], tier: 'infrastructure' },
        { name: 'auth', dependencies: [], tier: 'infrastructure' },
        { name: 'adguard', dependencies: ['nginx', 'auth'], tier: 'infrastructure' },
        { name: 'vaultwarden', dependencies: [], tier: 'feature' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const order = result.ordered.map(i => i.name);
      const lastInfra = Math.max(
        order.indexOf('nginx'),
        order.indexOf('auth'),
        order.indexOf('adguard'),
      );
      const firstFeature = Math.min(
        order.indexOf('ollama'),
        order.indexOf('hermes'),
        order.indexOf('vaultwarden'),
      );
      expect(lastInfra).toBeLessThan(firstFeature);
    });

    it('still respects explicit deps within the infrastructure tier', () => {
      // adguard explicitly depends on nginx+auth; that ordering must
      // hold inside the infra block even with the implicit cross-tier
      // edge.
      const result = topoSortByDependencies([
        { name: 'adguard', dependencies: ['nginx', 'auth'], tier: 'infrastructure' },
        { name: 'nginx', dependencies: [], tier: 'infrastructure' },
        { name: 'auth', dependencies: [], tier: 'infrastructure' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const order = result.ordered.map(i => i.name);
      expect(order.indexOf('nginx')).toBeLessThan(order.indexOf('adguard'));
      expect(order.indexOf('auth')).toBeLessThan(order.indexOf('adguard'));
    });

    it('handles a set with no infrastructure (feature-only)', () => {
      const result = topoSortByDependencies([
        { name: 'a', dependencies: [], tier: 'feature' },
        { name: 'b', dependencies: ['a'], tier: 'feature' },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.ordered.map(i => i.name)).toEqual(['a', 'b']);
    });

    it('defaults to feature tier when omitted (back-compat)', () => {
      // Existing callers that don't set `tier` should behave exactly
      // as before — sort by declared deps only.
      const result = topoSortByDependencies([
        { name: 'b', dependencies: ['a'] },
        { name: 'a', dependencies: [] },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.ordered.map(i => i.name)).toEqual(['a', 'b']);
    });
  });
});
