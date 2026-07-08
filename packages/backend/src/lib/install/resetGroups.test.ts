import { describe, it, expect } from 'vitest';
import {
  RESET_GROUPS,
  DEFAULT_PRESERVE,
  isAlwaysWipe,
  getChildExclusions,
  type ResetGroup,
} from './resetGroups';

/**
 * These tests pin the destructive-reset semantics that caused the
 * 2026-05-15 system-wide data-loss incident. A silent drift in the
 * path topology, the preserve defaults, or the alwaysWipe flag would
 * either delete system-critical data (NPM certs / identity provider)
 * or resurrect deleted services after an OS reinstall — CI's per-PR
 * diff-coverage floor doesn't catch a regression in old, untested
 * code, so these assertions ARE the guard.
 */

describe('resetGroups — RESET_GROUPS path topology', () => {
  it('gives every group at least one absolute path under /var/mnt/data', () => {
    for (const [name, def] of Object.entries(RESET_GROUPS)) {
      expect(def.paths.length, `${name} must declare a path`).toBeGreaterThanOrEqual(1);
      for (const p of def.paths) {
        expect(p.startsWith('/var/mnt/data'), `${name} path ${p} must be absolute under /var/mnt/data`).toBe(true);
        // A relative or `~`-based path would make a `rm -rf` resolve
        // against the runner CWD — never let that regress in.
        expect(p.startsWith('/'), `${name} path ${p} must be absolute`).toBe(true);
        expect(p).not.toContain('..');
      }
    }
  });

  it('nests certs and identity under service-data (parent/child topology holds)', () => {
    // getChildExclusions relies on service-data being a strict parent of
    // both certs and identity. If someone flattens the tree this breaks.
    const serviceData = RESET_GROUPS['service-data'].paths[0];
    expect(RESET_GROUPS.certs.paths[0].startsWith(serviceData + '/')).toBe(true);
    expect(RESET_GROUPS.identity.paths[0].startsWith(serviceData + '/')).toBe(true);
  });
});

describe('resetGroups — getChildExclusions', () => {
  it('service-data excludes exactly the nginx-proxy-manager and auth basenames', () => {
    // The whole point: a `service-data` wipe must SKIP the certs
    // (nginx-proxy-manager) and identity (auth) child dirs, which are
    // preserved by default. If this derivation drifts, a clean install
    // would delete NPM certs or the identity provider.
    const excl = getChildExclusions('service-data');
    expect(excl.sort()).toEqual(['auth', 'nginx-proxy-manager']);
  });

  it('returns only direct-child basenames, never deep paths', () => {
    const excl = getChildExclusions('service-data');
    for (const e of excl) {
      expect(e).not.toContain('/');
    }
  });

  it('returns nothing for a leaf group with no nested siblings', () => {
    // secrets' path (/var/mnt/data/servicebay) has quadlet-backup nested
    // under it, so it DOES exclude that child. certs/identity are leaves.
    expect(getChildExclusions('certs')).toEqual([]);
    expect(getChildExclusions('identity')).toEqual([]);
  });

  it('secrets excludes quadlet-backup (its nested child group)', () => {
    // /var/mnt/data/servicebay/quadlet-backup is a direct child of the
    // secrets path, so sizing/wiping secrets must account for it separately.
    expect(getChildExclusions('secrets')).toEqual(['quadlet-backup']);
  });

  it('never excludes a group from itself', () => {
    for (const group of Object.keys(RESET_GROUPS) as ResetGroup[]) {
      const excl = getChildExclusions(group);
      const myBasenames = RESET_GROUPS[group].paths.map(p => p.split('/').pop());
      for (const e of excl) {
        expect(myBasenames).not.toContain(e);
      }
    }
  });

  it('is symmetric with the topology — an excluded child is a real nested group', () => {
    // Guards against getChildExclusions inventing a basename that doesn't
    // correspond to a declared group nested under the parent.
    for (const group of Object.keys(RESET_GROUPS) as ResetGroup[]) {
      const parentPaths = RESET_GROUPS[group].paths;
      for (const child of getChildExclusions(group)) {
        const matchesSomeNestedGroup = (Object.keys(RESET_GROUPS) as ResetGroup[])
          .filter(g => g !== group)
          .some(g =>
            RESET_GROUPS[g].paths.some(cp =>
              parentPaths.some(pp => cp === `${pp}/${child}`),
            ),
          );
        expect(matchesSomeNestedGroup, `${child} excluded from ${group} must be a real nested group`).toBe(true);
      }
    }
  });
});

describe('resetGroups — DEFAULT_PRESERVE', () => {
  it('preserves exactly the three system-critical groups', () => {
    // Dropping any entry silently turns preserve into wipe. Pin all three.
    expect([...DEFAULT_PRESERVE].sort()).toEqual(['certs', 'identity', 'secrets']);
  });

  it('does NOT preserve service-data by default (the "clean" in clean install)', () => {
    expect(DEFAULT_PRESERVE).not.toContain('service-data');
  });

  it('does NOT list quadlet-backup (it is alwaysWipe, cannot be preserved)', () => {
    expect(DEFAULT_PRESERVE).not.toContain('quadlet-backup');
  });

  it('only names real declared groups', () => {
    for (const g of DEFAULT_PRESERVE) {
      expect(Object.keys(RESET_GROUPS)).toContain(g);
    }
  });
});

describe('resetGroups — isAlwaysWipe', () => {
  it('is true only for quadlet-backup', () => {
    // quadlet-backup MUST always wipe or an OS reinstall resurrects
    // deleted services. No other group may become alwaysWipe silently.
    const alwaysWiped = (Object.keys(RESET_GROUPS) as ResetGroup[]).filter(isAlwaysWipe);
    expect(alwaysWiped).toEqual(['quadlet-backup']);
  });

  it('is false for every preserve-able group', () => {
    for (const g of DEFAULT_PRESERVE) {
      expect(isAlwaysWipe(g)).toBe(false);
    }
    expect(isAlwaysWipe('service-data')).toBe(false);
  });
});
