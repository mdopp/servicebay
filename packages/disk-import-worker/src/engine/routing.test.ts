import { describe, it, expect } from 'vitest';
import {
  ROOT_DEFAULT,
  effectiveRule,
  autoAssignOwners,
  destinationArea,
  dedupsFor,
  parentDir,
  topLevelSegment,
  buildFolderTree,
  resolveTargetPath,
  dirOfRel,
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

describe('dirOfRel', () => {
  it('returns the directory of a relative path; root for a top-level file', () => {
    expect(dirOfRel('a/b/c.jpg')).toBe('a/b');
    expect(dirOfRel('c.jpg')).toBe('');
    expect(dirOfRel('a/b/')).toBe('a');
  });
});

describe('effectiveRule — base-root anchor (#2006 follow-up)', () => {
  it('a base-marked folder becomes the anchor (its name is dropped)', () => {
    const explicit = new Map<string, Rule>([['backup_2025', { base: true }]]);
    expect(effectiveRule('backup_2025/docs', explicit).anchor).toBe('backup_2025');
  });

  it('base does NOT inherit down-tree like owner — only the marked folder anchors', () => {
    const explicit = new Map<string, Rule>([['backup_2025', { base: true }]]);
    // A sibling subtree with its own deeper structure still anchors at backup_2025.
    expect(effectiveRule('backup_2025/docs/2021', explicit).anchor).toBe('backup_2025');
    // An unrelated top-level folder is unaffected (no base above it → root anchor).
    expect(effectiveRule('Photos/2021', explicit).anchor).toBe('');
  });

  it('base:false is not a base mark', () => {
    const explicit = new Map<string, Rule>([['backup_2025', { base: false }]]);
    expect(effectiveRule('backup_2025/docs', explicit).anchor).toBe('');
  });

  it('a deeper owner/disposition anchor still wins over a shallower base', () => {
    const explicit = new Map<string, Rule>([
      ['backup_2025', { base: true }],
      ['backup_2025/Work', { owner: 'mdopp' }],
    ]);
    expect(effectiveRule('backup_2025/Work/report.pdf', explicit).anchor).toBe('backup_2025/Work');
  });

  it('end-to-end: two backup roots stripped → same target (then content dedup collapses)', () => {
    const explicit = new Map<string, Rule>([
      ['backup_2025', { base: true }],
      ['backup_2026', { base: true }],
    ]);
    const a = resolveTargetPath('backup_2025/docs/note.txt', 'documents', effectiveRule('backup_2025/docs', explicit));
    const b = resolveTargetPath('backup_2026/docs/note.txt', 'documents', effectiveRule('backup_2026/docs', explicit));
    expect(a).toBe('documents/docs/note.txt');
    expect(b).toBe('documents/docs/note.txt');
  });
});

describe('resolveTargetPath — layout is category-driven (#2006)', () => {
  it('music (flat category) flattens to the folder by basename; shared omits the owner segment', () => {
    expect(resolveTargetPath('Backup/sub/track.mp3', 'music', { owner: 'shared', anchor: '' }))
      .toBe('music/track.mp3');
  });
  it('photos (preserve category) keep the source subtree below the anchor', () => {
    expect(resolveTargetPath('Backup/IMG.jpg', 'photos', { owner: 'shared', anchor: '' }))
      .toBe('photos/Backup/IMG.jpg');
  });
  it('user owner prefixes; preserve keeps the subtree below the anchor', () => {
    expect(
      resolveTargetPath('Code/src/main.ts', 'documents', { owner: 'mdopp', anchor: 'Code' }),
    ).toBe('mdopp/documents/src/main.ts');
  });

  // #1929 — the owner is request-supplied (edited routing tree); a malicious
  // owner must never be threaded into the target's first path segment. The
  // apply-time jail (resolveShareTarget) would catch the poisoned target too,
  // but resolveTargetPath rejects it at the boundary (defence in depth) so an
  // escaping target is never even formed.
  it('rejects a traversal owner before building a target', () => {
    for (const evil of ['..', '../etc', '../../etc/cron.d', '.']) {
      expect(() =>
        resolveTargetPath('Backup/IMG.jpg', 'photos', { owner: evil, anchor: '' }),
      ).toThrow(/invalid owner segment/);
    }
  });

  it('rejects an owner carrying a path separator, backslash, or NUL', () => {
    for (const evil of ['a/b', 'a\\b', 'mdopp/../cdopp', 'x\0y', '']) {
      expect(() =>
        resolveTargetPath('Backup/IMG.jpg', 'photos', { owner: evil, anchor: '' }),
      ).toThrow(/invalid owner segment/);
    }
  });
});

describe('resolveTargetPath — audiobooks Bookshelf flatten (#2028)', () => {
  const ab = (rel: string, anchor = '') =>
    resolveTargetPath(rel, 'audiobooks', { owner: 'shared', anchor });

  it('a plain Author/Book/track is kept unchanged', () => {
    expect(ab('Author/Book/01.mp3')).toBe('audiobooks/Author/Book/01.mp3');
  });

  it('flattens a single disc folder into the book folder with a disc prefix', () => {
    expect(ab('Author/Book/CD1/01.mp3')).toBe('audiobooks/Author/Book/d01-01.mp3');
    expect(ab('Author/Book/CD2/01.mp3')).toBe('audiobooks/Author/Book/d02-01.mp3');
  });

  it('collapses a DOUBLE-nested disc folder (CD1/CD1) to one prefix from the outer disc', () => {
    expect(ab('Bro.Code/CD1/CD1/01 Track 1.mp3')).toBe('audiobooks/Bro.Code/d01-01 Track 1.mp3');
  });

  it('two discs’ same-named tracks never collide in the flat book folder', () => {
    expect(ab('Book/CD1/01.mp3')).toBe('audiobooks/Book/d01-01.mp3');
    expect(ab('Book/CD2/01.mp3')).toBe('audiobooks/Book/d02-01.mp3');
  });

  it('recognises Disc/Disk/Part/Vol + German Teil/Folge disc wrappers', () => {
    expect(ab('Book/Disc 3/t.mp3')).toBe('audiobooks/Book/d03-t.mp3');
    expect(ab('Book/Disk1/t.mp3')).toBe('audiobooks/Book/d01-t.mp3');
    expect(ab('Book/Part 2/t.mp3')).toBe('audiobooks/Book/d02-t.mp3');
    expect(ab('Book/Vol. 4/t.mp3')).toBe('audiobooks/Book/d04-t.mp3');
    expect(ab('Book/Teil 5/t.mp3')).toBe('audiobooks/Book/d05-t.mp3');
  });

  it('caps audio depth at Author/Book/ — extra-deep non-disc dirs are trimmed to the deepest two', () => {
    expect(ab('a/b/Author/Book/01.mp3')).toBe('audiobooks/Author/Book/01.mp3');
    expect(ab('a/b/Author/Book/CD1/01.mp3')).toBe('audiobooks/Author/Book/d01-01.mp3');
  });

  it('a bare disc wrapper with no number flattens without a prefix', () => {
    expect(ab('Book/CD/01.mp3')).toBe('audiobooks/Book/01.mp3');
  });

  it('owner prefix + anchor still apply under the flatten', () => {
    expect(resolveTargetPath('mdopp/Book/CD1/01.mp3', 'audiobooks', { owner: 'mdopp', anchor: 'mdopp' }))
      .toBe('mdopp/audiobooks/Book/d01-01.mp3');
  });
});

describe('buildFolderTree (#1915)', () => {
  const files = [
    { dir: '', category: 'documents' as const, size: 1 },
    { dir: 'mdopp', category: 'photos' as const, size: 2 },
    { dir: 'mdopp/Filme', category: 'movies' as const, size: 3 },
  ];

  it('returns just the root node for an EMPTY scan (no crash on 0 files)', () => {
    const tree = buildFolderTree([], new Map());
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ dir: '', files: 0, bytes: 0, categories: [] });
  });

  it('emits one connected node per dir incl. the root, with tallies + categories', () => {
    const tree = buildFolderTree(files, new Map());
    expect(tree.map(n => n.dir)).toEqual(['', 'mdopp', 'mdopp/Filme']);
    const mdopp = tree.find(n => n.dir === 'mdopp')!;
    expect(mdopp.files).toBe(1);
    expect(mdopp.bytes).toBe(2);
    expect(mdopp.categories).toEqual(['photos']);
  });

  it('attaches explicit + resolved rules; resolved inherits down-tree', () => {
    const explicit = new Map<string, Rule>([['mdopp', { owner: 'mdopp' }]]);
    const tree = buildFolderTree(files, explicit);
    const mdopp = tree.find(n => n.dir === 'mdopp')!;
    const child = tree.find(n => n.dir === 'mdopp/Filme')!;
    expect(mdopp.explicit).toEqual({ owner: 'mdopp' });
    expect(mdopp.resolved.owner).toBe('mdopp');
    // The child inherits the owner (no explicit rule of its own).
    expect(child.explicit).toEqual({});
    expect(child.resolved.owner).toBe('mdopp');
  });

  it('seeds the root from the disk-default owner', () => {
    const tree = buildFolderTree(files, new Map(), { owner: 'cdopp' });
    expect(tree.find(n => n.dir === '')!.resolved.owner).toBe('cdopp');
    expect(tree.find(n => n.dir === 'mdopp/Filme')!.resolved.owner).toBe('cdopp');
  });
});
