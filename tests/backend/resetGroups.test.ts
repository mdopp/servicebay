import { describe, it, expect } from 'vitest';
import {
  RESET_GROUPS,
  DEFAULT_PRESERVE,
  isAlwaysWipe,
  getChildExclusions,
  type ResetGroup,
} from '@/lib/install/resetGroups';

/**
 * Regression coverage for the #568 transparency rework:
 *
 *  - the group ids stay stable (they're persisted in `JobInput.preserve`
 *    and any rename would orphan in-flight jobs)
 *  - the default `preserve` array keeps the three system-critical groups
 *    and wipes only service-data + alwaysWipe groups — flipping the
 *    default in the future would silently reintroduce the May-15
 *    data-loss regression
 *  - every group declares a non-empty `paths` array (the wipe step in
 *    the route handler dereferences these)
 *  - `getChildExclusions` derives parent→child relationships from the
 *    path topology so /info `du --exclude` and /reset `find ! -name`
 *    can't drift out of sync with a hand-maintained exclusion list
 */

describe('RESET_GROUPS contract', () => {
  it('declares exactly the five groups the route + UI expect', () => {
    const ids = Object.keys(RESET_GROUPS).sort();
    expect(ids).toEqual(['certs', 'identity', 'quadlet-backup', 'secrets', 'service-data']);
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

  it('default preserve keeps system-critical groups; service-data + alwaysWipe wipe', () => {
    // Lock the default in a test — flipping it back to "wipe everything"
    // would re-introduce the May-15 incident silently.
    expect([...DEFAULT_PRESERVE].sort()).toEqual(['certs', 'identity', 'secrets']);
    const wiped = (Object.keys(RESET_GROUPS) as ResetGroup[]).filter(g => !DEFAULT_PRESERVE.includes(g));
    expect(wiped.sort()).toEqual(['quadlet-backup', 'service-data']);
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

  it('quadlet-backup is alwaysWipe and lives under the secrets path', () => {
    // The alwaysWipe flag is what stops the operator from preserving
    // stale Quadlet units across an OS reinstall. And living under
    // secrets/ is what used to make its ~800 MB get counted (wrongly)
    // as part of the "kept" secrets group in the wizard.
    expect(isAlwaysWipe('quadlet-backup')).toBe(true);
    expect(isAlwaysWipe('secrets')).toBe(false);
    expect(RESET_GROUPS['quadlet-backup'].paths[0].startsWith('/var/mnt/data/servicebay/')).toBe(true);
  });
});

describe('getChildExclusions', () => {
  it('returns the basenames of other groups whose paths are direct children', () => {
    // service-data owns /var/mnt/data/stacks; certs + identity live
    // inside it as direct children — both must be excluded so the
    // per-group sizes don't double-count.
    const svc = getChildExclusions('service-data').sort();
    expect(svc).toEqual(['auth', 'nginx-proxy-manager']);
  });

  it('returns quadlet-backup for the secrets group', () => {
    // The bug the #568 follow-up fixed: secrets used to show
    // /var/mnt/data/servicebay including quadlet-backup's ~800 MB,
    // even though quadlet-backup gets wiped regardless. The exclusion
    // must come back so the displayed "kept" size is honest.
    expect(getChildExclusions('secrets')).toEqual(['quadlet-backup']);
  });

  it('returns empty for leaf groups with no children', () => {
    expect(getChildExclusions('certs')).toEqual([]);
    expect(getChildExclusions('identity')).toEqual([]);
    expect(getChildExclusions('quadlet-backup')).toEqual([]);
  });
});
