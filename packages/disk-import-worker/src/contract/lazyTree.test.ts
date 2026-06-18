import { describe, it, expect } from 'vitest';
import { lazyChildren } from './lazyTree';
import type { ImportPlan, ImportPlanItem } from '../engine/types';

function item(sourcePath: string, size: number, category: ImportPlanItem['category'], target: string | null = 'x'): ImportPlanItem {
  return {
    record: { sourcePath, size, mtimeMs: 0, ext: '', name: sourcePath.split('/').pop() ?? '' },
    category,
    target,
    action: target === null ? 'skip-junk' : 'copy',
  };
}

function plan(items: ImportPlanItem[]): ImportPlan {
  return { items, conflicts: [] };
}

const MOUNT = '/mnt/src';

describe('lazyChildren', () => {
  it('returns only the immediate children of the root, with subtree rollups', () => {
    const p = plan([
      item(`${MOUNT}/photos/a.jpg`, 100, 'photos'),
      item(`${MOUNT}/photos/2023/b.jpg`, 200, 'photos'),
      item(`${MOUNT}/music/c.mp3`, 50, 'music'),
    ]);
    const level = lazyChildren(p, '', MOUNT);
    expect(level.totalFiles).toBe(3);
    expect(level.children.map(c => c.dir)).toEqual(['music', 'photos']);
    const photos = level.children.find(c => c.dir === 'photos')!;
    expect(photos.totalFiles).toBe(2); // recursive: a.jpg + 2023/b.jpg
    expect(photos.totalBytes).toBe(300);
    expect(photos.hasChildren).toBe(true); // has the 2023/ subdir
    const music = level.children.find(c => c.dir === 'music')!;
    expect(music.hasChildren).toBe(false);
  });

  it('drills one level on demand without materialising the whole tree', () => {
    const p = plan([
      item(`${MOUNT}/photos/a.jpg`, 100, 'photos'),
      item(`${MOUNT}/photos/2023/b.jpg`, 200, 'photos'),
      item(`${MOUNT}/photos/2023/c.jpg`, 300, 'photos'),
    ]);
    const level = lazyChildren(p, 'photos', MOUNT);
    expect(level.parent).toBe('photos');
    expect(level.children.map(c => c.dir)).toEqual(['photos/2023']);
    expect(level.children[0].totalFiles).toBe(2);
    expect(level.children[0].totalBytes).toBe(500);
    expect(level.children[0].name).toBe('2023');
  });

  it('excludes junk (target === null) from the tree', () => {
    const p = plan([
      item(`${MOUNT}/photos/a.jpg`, 100, 'photos'),
      item(`${MOUNT}/photos/thumbs.db`, 1, 'junk', null),
    ]);
    const level = lazyChildren(p, '', MOUNT);
    expect(level.totalFiles).toBe(1);
    expect(level.children.find(c => c.dir === 'photos')!.totalFiles).toBe(1);
  });

  it('handles an empty plan', () => {
    const level = lazyChildren(plan([]), '', MOUNT);
    expect(level.children).toEqual([]);
    expect(level.totalFiles).toBe(0);
  });
});
