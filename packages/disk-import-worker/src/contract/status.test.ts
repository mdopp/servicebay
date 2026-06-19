import { describe, it, expect } from 'vitest';

import {
  STATUS_CONTRACT_VERSION,
  STATUS_FILE,
  PLAN_SIDECAR_FILE,
  initialStatus,
  summarizeCategories,
  type WorkerStatus,
} from './status';
import type { ImportPlan } from '../engine/types';

function rec(sourcePath: string, size: number) {
  return { sourcePath, size, mtimeMs: 0, ext: '', name: sourcePath };
}

describe('status contract', () => {
  it('initialStatus is a compact scanning doc with zeroed counts', () => {
    const s = initialStatus('run-1', 'dry-run', 1000);
    expect(s.version).toBe(STATUS_CONTRACT_VERSION);
    expect(s.phase).toBe('scanning');
    expect(s.runId).toBe('run-1');
    expect(s.mode).toBe('dry-run');
    expect(s.scanned).toBe(0);
    expect(s.planned).toBe(0);
    expect(s.applied).toBe(0);
    expect(s.planSidecar).toBeNull();
    expect(s.error).toBeNull();
    expect(s.startedAt).toBe(1000);
  });

  it('status doc holds NO inventory/plan items inline (stays compact)', () => {
    const s: WorkerStatus = initialStatus('r', 'apply');
    // The contract must never grow per-file arrays — only scalars + the small rollup.
    expect(Object.keys(s)).not.toContain('items');
    expect(Object.keys(s)).not.toContain('plan');
    expect(Object.keys(s)).not.toContain('inventory');
    expect(Array.isArray(s.categories)).toBe(true);
  });

  it('summarizeCategories rolls up counts/bytes per category, sorted, no records', () => {
    const plan: ImportPlan = {
      items: [
        { record: rec('a.jpg', 10), category: 'photos', target: 'photos/a.jpg', action: 'copy' },
        { record: rec('b.jpg', 20), category: 'photos', target: 'photos/b.jpg', action: 'skip-dupe' },
        { record: rec('c.mp3', 5), category: 'music', target: 'music/c.mp3', action: 'copy' },
        { record: rec('d.mp3', 7), category: 'music', target: 'music/d.mp3', action: 'conflict' },
      ],
      conflicts: [],
    };
    const rollup = summarizeCategories(plan);
    expect(rollup.map(r => r.category)).toEqual(['music', 'photos']); // sorted
    const photos = rollup.find(r => r.category === 'photos')!;
    expect(photos).toEqual({ category: 'photos', files: 2, bytes: 30, copy: 1, skipDupe: 1, conflict: 0, renamed: 0 });
    const music = rollup.find(r => r.category === 'music')!;
    expect(music).toEqual({ category: 'music', files: 2, bytes: 12, copy: 1, skipDupe: 0, conflict: 1, renamed: 0 });
    // Rollup entries are scalar-only — no file records leak in.
    expect(Object.keys(photos)).not.toContain('record');
  });

  it('counts a disambiguated copy under both copy and renamed (#2006)', () => {
    const plan: ImportPlan = {
      items: [
        { record: rec('a.jpg', 10), category: 'photos', target: 'photos/a.jpg', action: 'copy' },
        { record: rec('b.jpg', 10), category: 'photos', target: 'photos/a (2).jpg', action: 'copy', renamed: true },
      ],
      conflicts: [],
    };
    const photos = summarizeCategories(plan).find(r => r.category === 'photos')!;
    // The renamed file IS imported (copy) and ALSO tallied as renamed (a subset).
    expect(photos).toMatchObject({ files: 2, copy: 2, renamed: 1, conflict: 0 });
  });

  it('exposes stable file-name constants for the shared volume', () => {
    expect(STATUS_FILE).toBe('status.json');
    expect(PLAN_SIDECAR_FILE).toBe('plan.json');
  });
});
