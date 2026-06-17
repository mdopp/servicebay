import { describe, it, expect } from 'vitest';
import {
  ROOT_DEFAULT,
  effectiveRule,
  autoAssignOwners,
  destinationArea,
  dedupsFor,
  parentDir,
  topLevelSegment,
} from './routing';
import { DISPOSITIONS, type Disposition, type Rule } from './types';

const BOX_USERS = ['mdopp', 'cdopp', 'ddopp'];

describe('DISPOSITIONS — full v1 enum present', () => {
  it('models all ten v1 dispositions in stable order', () => {
    const expected: Disposition[] = [
      'auto',
      'photos_immich',
      'movies_jellyfin',
      'music',
      'audiobooks',
      'podcasts',
      'documents_merge',
      'code_parallel',
      'archive_1to1',
      'skip',
    ];
    expect([...DISPOSITIONS]).toEqual(expected);
  });
});

describe('parentDir / topLevelSegment', () => {
  it('walks up one level, root is the empty string', () => {
    expect(parentDir('a/b/c')).toBe('a/b');
    expect(parentDir('a')).toBe('');
    expect(parentDir('')).toBeNull();
    expect(parentDir('a/b/')).toBe('a'); // trailing slash ignored
  });
  it('extracts the exact top-level segment', () => {
    expect(topLevelSegment('Backup-2023/Photos')).toBe('Backup-2023');
    expect(topLevelSegment('mdopp')).toBe('mdopp');
    expect(topLevelSegment('/mdopp/photos')).toBe('mdopp');
    expect(topLevelSegment('')).toBe('');
  });
});

describe('effectiveRule — defaults', () => {
  it('falls back to ROOT_DEFAULT when nothing is set', () => {
    const r = effectiveRule('Backup-2023/Photos', new Map());
    expect(r).toEqual({ ...ROOT_DEFAULT, anchor: '' });
  });
  it('honours a disk-default override at the root', () => {
    const r = effectiveRule('anything', new Map(), { owner: 'mdopp', disposition: 'archive_1to1' });
    expect(r.owner).toBe('mdopp');
    expect(r.disposition).toBe('archive_1to1');
  });
});

describe('effectiveRule — owner inherits up-tree independently of mode', () => {
  it('child inherits the nearest ancestor owner', () => {
    const explicit = new Map<string, Rule>([['Backup-2023', { owner: 'mdopp' }]]);
    expect(effectiveRule('Backup-2023/Photos/2021', explicit).owner).toBe('mdopp');
  });

  it('an explicit child owner wins over the ancestor', () => {
    const explicit = new Map<string, Rule>([
      ['Backup-2023', { owner: 'mdopp' }],
      ['Backup-2023/Photos', { owner: 'cdopp' }],
    ]);
    expect(effectiveRule('Backup-2023/Photos/sub', explicit).owner).toBe('cdopp');
    expect(effectiveRule('Backup-2023/Documents', explicit).owner).toBe('mdopp');
  });

  it('owner and mode resolve from DIFFERENT ancestors (axes are independent)', () => {
    // owner set high, mode set low — neither couples to the other.
    const explicit = new Map<string, Rule>([
      ['Backup-2023', { owner: 'mdopp' }],
      ['Backup-2023/Code', { mode: 'parallel' }],
    ]);
    const r = effectiveRule('Backup-2023/Code/proj', explicit);
    expect(r.owner).toBe('mdopp'); // inherited from Backup-2023
    expect(r.mode).toBe('parallel'); // inherited from Backup-2023/Code
    expect(r.disposition).toBe(ROOT_DEFAULT.disposition); // untouched → default
  });

  it('setting only mode on a node does NOT change the inherited owner', () => {
    const explicit = new Map<string, Rule>([
      ['Backup', { owner: 'cdopp', disposition: 'documents_merge' }],
      ['Backup/Src', { mode: 'parallel' }], // touches mode only
    ]);
    const r = effectiveRule('Backup/Src', explicit);
    expect(r.owner).toBe('cdopp'); // owner unchanged by the mode edit
    expect(r.mode).toBe('parallel');
    expect(r.disposition).toBe('documents_merge');
  });
});

describe('autoAssignOwners — exact top-level name match', () => {
  it('maps a top-level source dir named exactly like a box user to that owner', () => {
    const assigned = autoAssignOwners(['mdopp', 'cdopp', 'Backup-2023'], BOX_USERS);
    expect(assigned.get('mdopp')?.owner).toBe('mdopp');
    expect(assigned.get('cdopp')?.owner).toBe('cdopp');
    expect(assigned.has('Backup-2023')).toBe(false); // non-matching → no auto-owner
  });

  it('is overridable: an explicit owner the user already set is not clobbered', () => {
    const explicit = new Map<string, Rule>([['mdopp', { owner: 'shared' }]]);
    const assigned = autoAssignOwners(['mdopp'], BOX_USERS, explicit);
    expect(assigned.get('mdopp')?.owner).toBe('shared'); // user pick preserved
  });

  it('merges onto an existing non-owner rule without dropping its other axes', () => {
    const explicit = new Map<string, Rule>([['mdopp', { disposition: 'archive_1to1' }]]);
    const assigned = autoAssignOwners(['mdopp'], BOX_USERS, explicit);
    expect(assigned.get('mdopp')).toEqual({ disposition: 'archive_1to1', owner: 'mdopp' });
  });

  it('only matches the exact top-level segment, not deeper names', () => {
    // A nested `mdopp` is NOT auto-assigned here (top-level only per the issue).
    const assigned = autoAssignOwners(['Users/mdopp'], BOX_USERS);
    expect(assigned.has('Users/mdopp')).toBe(false);
    expect(assigned.has('Users')).toBe(false);
  });

  it('does not mutate the input map', () => {
    const explicit = new Map<string, Rule>();
    autoAssignOwners(['mdopp'], BOX_USERS, explicit);
    expect(explicit.size).toBe(0);
  });
});

describe('destinationArea + dedupsFor', () => {
  it('shared owner → shared area; user owner → user area', () => {
    expect(destinationArea('shared')).toBe('shared');
    expect(destinationArea('mdopp')).toBe('mdopp');
  });
  it('only auto + documents_merge dedup', () => {
    expect(dedupsFor('auto')).toBe(true);
    expect(dedupsFor('documents_merge')).toBe(true);
    expect(dedupsFor('code_parallel')).toBe(false);
    expect(dedupsFor('archive_1to1')).toBe(false);
    expect(dedupsFor('skip')).toBe(false);
    expect(dedupsFor('photos_immich')).toBe(false);
  });
});
