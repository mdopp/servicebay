import { describe, it, expect } from 'vitest';
import { parseTemplateDependencies, topoSortByDependencies } from './dependencies';

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
});
