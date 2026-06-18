import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlanSidecar } from '@servicebay/disk-import-worker';

vi.mock('@/lib/dirs', () => ({ DATA_DIR: '/app/data' }));

const listLldapUsersMock = vi.fn();
vi.mock('@/lib/lldap/client', () => ({
  listLldapUsers: () => listLldapUsersMock(),
}));

const { sidecarRef } = vi.hoisted(() => ({ sidecarRef: { current: null as PlanSidecar | null } }));
vi.mock('node:fs/promises', () => {
  const m = {
    readFile: vi.fn(async (file: string) => {
      if (file.endsWith('plan.json')) return JSON.stringify(sidecarRef.current);
      throw new Error(`unexpected read ${file}`);
    }),
  };
  return { ...m, default: m };
});

import { buildReviewTree, relDirOf } from './tree';

function planItem(sourcePath: string, category: string, size: number) {
  const name = sourcePath.split('/').pop()!.toLowerCase();
  return {
    record: { sourcePath, size, mtimeMs: 0, ext: name.split('.').pop() ?? '', name },
    category,
    target: null,
    action: 'copy',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listLldapUsersMock.mockResolvedValue({
    ok: true,
    users: [
      { id: 'mdopp', displayName: 'Mark' },
      { id: 'cdopp', displayName: 'Clara' },
    ],
  });
  sidecarRef.current = {
    version: 1,
    runId: 'run1',
    mountBase: '/mnt/src',
    plan: {
      items: [
        planItem('/mnt/src/mdopp/photos/a.jpg', 'photos', 100),
        planItem('/mnt/src/Backup/doc.pdf', 'documents', 50),
      ],
      conflicts: [],
    },
  } as PlanSidecar;
});

describe('relDirOf', () => {
  it('returns the source-relative dir under the mountBase', () => {
    expect(relDirOf('/mnt/src/mdopp/photos/a.jpg', '/mnt/src')).toBe('mdopp/photos');
    expect(relDirOf('/mnt/src/a.jpg', '/mnt/src')).toBe('');
  });
});

describe('buildReviewTree', () => {
  it('auto-assigns a top-level folder named like a box user', async () => {
    const review = await buildReviewTree('run1');
    const mdoppNode = review.tree.find(n => n.dir === 'mdopp');
    expect(mdoppNode?.resolved.owner).toBe('mdopp');
    // explicit owner seeded by the auto-assign (overridable in the UI).
    expect(mdoppNode?.explicit.owner).toBe('mdopp');
  });

  it('offers shared + every box user as owner options', async () => {
    const review = await buildReviewTree('run1');
    expect(review.owners.map(o => o.id)).toEqual(['shared', 'mdopp', 'cdopp']);
  });

  it('previews data/<owner>/<category>/… per folder', async () => {
    const review = await buildReviewTree('run1');
    // mdopp/photos inherits owner mdopp from the auto-assigned parent.
    const photos = review.tree.find(n => n.dir === 'mdopp/photos');
    expect(photos?.preview).toBe('data/mdopp/photos/…');
    // Backup is shared by default → no owner segment.
    const backup = review.tree.find(n => n.dir === 'Backup');
    expect(backup?.preview).toBe('data/documents/…');
  });

  it('applies an explicit edit + the disk-default owner', async () => {
    const review = await buildReviewTree('run1', {
      diskDefaultOwner: 'cdopp',
      explicit: new Map([['Backup', { disposition: 'photos_immich' }]]),
    });
    const backup = review.tree.find(n => n.dir === 'Backup');
    // owner inherits the disk default (cdopp); disposition forced to photos.
    expect(backup?.preview).toBe('data/cdopp/photos/…');
  });

  it('previews a skip folder as not-imported', async () => {
    const review = await buildReviewTree('run1', {
      explicit: new Map([['Backup', { disposition: 'skip' }]]),
    });
    const backup = review.tree.find(n => n.dir === 'Backup');
    expect(backup?.preview).toBe('(skipped — not imported)');
  });
});
