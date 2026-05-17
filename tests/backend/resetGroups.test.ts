import { describe, it, expect } from 'vitest';
import { RESET_GROUPS, DEFAULT_PRESERVE, type ResetGroup } from '@/lib/install/resetGroups';

/**
 * Regression coverage for the #568 transparency rework:
 *
 *  - the four group ids stay stable (they're persisted in `JobInput.preserve`
 *    and any rename would orphan in-flight jobs)
 *  - the default `preserve` array keeps the three system-critical groups
 *    and wipes only service-data — flipping the default in the future
 *    would silently reintroduce the May-15 data-loss regression
 *  - every group declares a non-empty `paths` array (the wipe step in
 *    the route handler dereferences these)
 */

describe('RESET_GROUPS contract', () => {
  it('declares exactly the four groups the route + UI expect', () => {
    const ids = Object.keys(RESET_GROUPS).sort();
    expect(ids).toEqual(['certs', 'identity', 'secrets', 'service-data']);
  });

  it('every group has at least one path to wipe', () => {
    for (const [id, def] of Object.entries(RESET_GROUPS)) {
      expect(def.paths.length, `group ${id} must declare paths`).toBeGreaterThan(0);
    }
  });

  it('every group has a label + description for the wizard panel', () => {
    for (const [id, def] of Object.entries(RESET_GROUPS)) {
      expect(def.label.length, `group ${id} label`).toBeGreaterThan(5);
      expect(def.description.length, `group ${id} description`).toBeGreaterThan(20);
    }
  });

  it('default preserve keeps system-critical groups and wipes only service-data', () => {
    // Lock the default in a test — flipping it back to "wipe everything"
    // would re-introduce the May-15 incident silently.
    expect([...DEFAULT_PRESERVE].sort()).toEqual(['certs', 'identity', 'secrets']);
    const wiped = (Object.keys(RESET_GROUPS) as ResetGroup[]).filter(g => !DEFAULT_PRESERVE.includes(g));
    expect(wiped).toEqual(['service-data']);
  });

  it('service-data path is /var/mnt/data/stacks (top-level — wipe excludes preserved subdirs)', () => {
    // The route handler builds `find $dataDir -mindepth 1 -maxdepth 1 ! -name X ! -name Y`,
    // which only works because service-data's path is the parent of the
    // certs + identity subdirs. Lock the relationship.
    expect(RESET_GROUPS['service-data'].paths).toEqual(['/var/mnt/data/stacks']);
    expect(RESET_GROUPS.certs.paths[0].startsWith('/var/mnt/data/stacks/')).toBe(true);
    expect(RESET_GROUPS.identity.paths[0].startsWith('/var/mnt/data/stacks/')).toBe(true);
  });

  it('secrets path is the ServiceBay state dir (separate tree from stacks/)', () => {
    expect(RESET_GROUPS.secrets.paths).toEqual(['/var/mnt/data/servicebay']);
  });
});
