import { describe, it, expect, vi } from 'vitest';

import { runReplan, relPathUnder, toRoutingResolution, type ReplanIO } from './replan';
import { PLAN_SIDECAR_FILE, STATUS_FILE, type PlanSidecar, type WorkerStatus } from '../contract/status';
import type { ImportPlan, ImportPlanItem, ImportRecord } from './types';

/** A scanned record under /mnt/src. */
function rec(sourcePath: string, size: number): ImportRecord {
  const name = sourcePath.split('/').pop()!.toLowerCase();
  return { sourcePath, size, mtimeMs: 0, ext: name.split('.').pop() ?? '', name };
}

/** A plan item carrying just the record (replan reads only item.record). */
function item(r: ImportRecord): ImportPlanItem {
  return { record: r, category: 'documents', target: null, action: 'copy' };
}

/** Build an in-memory ReplanIO seam. `hashOf` keys by content map (path→sha). */
function makeIO(sidecar: PlanSidecar, contentByPath: Record<string, string>) {
  const written: { sidecar?: PlanSidecar; status?: WorkerStatus } = {};
  const files: Record<string, unknown> = {
    [PLAN_SIDECAR_FILE]: sidecar,
    [STATUS_FILE]: { version: 1, runId: sidecar.runId, scanned: sidecar.plan.items.length } as Partial<WorkerStatus>,
  };
  const hashOf = vi.fn((r: ImportRecord) => contentByPath[r.sourcePath] ?? r.sourcePath);
  const io: ReplanIO = {
    readJson: async <T>(f: string) => (files[f] as T) ?? null,
    writePlanSidecar: async s => {
      written.sidecar = s;
      files[PLAN_SIDECAR_FILE] = s;
    },
    writeStatus: async s => {
      written.status = s;
    },
    hashOf,
    fingerprintOf: hashOf,
    now: () => 1000,
  };
  return { io, written, hashOf };
}

describe('relPathUnder', () => {
  it('strips the mountBase prefix', () => {
    expect(relPathUnder('/mnt/src/mdopp/photos/a.jpg', '/mnt/src')).toBe('mdopp/photos/a.jpg');
    expect(relPathUnder('/mnt/src', '/mnt/src')).toBe('');
    expect(relPathUnder('/mnt/src/', '/mnt/src')).toBe(''); // trailing-slash base
  });
});

describe('toRoutingResolution', () => {
  it('builds an explicit Map + relPathOf from the wire request', () => {
    const res = toRoutingResolution({ explicit: { mdopp: { owner: 'mdopp' } }, rootDefault: { owner: 'shared' } }, '/mnt/src');
    expect(res.explicit.get('mdopp')).toEqual({ owner: 'mdopp' });
    expect(res.rootDefault).toEqual({ owner: 'shared' });
    expect(res.relPathOf(rec('/mnt/src/mdopp/x.txt', 1))).toBe('mdopp/x.txt');
  });
});

describe('runReplan — per-owner re-dedup (the #2000 architectural finding)', () => {
  // The SAME bytes live in two top-level folders. A flat (shared-scope) plan
  // dedups them — only ONE copies. Assigning each folder a different owner must
  // re-dedup PER OWNER so BOTH copy, each into its owner's area.
  const sidecar: PlanSidecar = {
    version: 1,
    runId: 'run1',
    mountBase: '/mnt/src',
    plan: {
      items: [
        item(rec('/mnt/src/alice/report.pdf', 100)),
        item(rec('/mnt/src/bob/report.pdf', 100)),
      ],
      conflicts: [],
    } as ImportPlan,
  };
  // Identical content → same hash → would dedup in a single area.
  const content = { '/mnt/src/alice/report.pdf': 'sha-X', '/mnt/src/bob/report.pdf': 'sha-X' };

  it('drops the cross-folder duplicate when both are shared (baseline)', async () => {
    const { io } = makeIO(sidecar, content);
    const plan = await runReplan({ explicit: {} }, io);
    const copies = plan.items.filter(i => i.action === 'copy');
    const dupes = plan.items.filter(i => i.action === 'skip-dupe');
    expect(copies).toHaveLength(1); // shared scope → second is a dupe
    expect(dupes).toHaveLength(1);
  });

  it('lets the same bytes land in BOTH owners’ areas when assigned per owner', async () => {
    const { io, written } = makeIO(sidecar, content);
    const plan = await runReplan(
      { explicit: { alice: { owner: 'alice' }, bob: { owner: 'bob' } } },
      io,
    );
    const copies = plan.items.filter(i => i.action === 'copy');
    expect(copies).toHaveLength(2); // per-owner dedup → both copy
    const targets = copies.map(c => c.target).sort();
    expect(targets).toEqual(['alice/documents/report.pdf', 'bob/documents/report.pdf']);
    // The sidecar was rewritten with the new plan.
    expect(written.sidecar?.plan.items.filter(i => i.action === 'copy')).toHaveLength(2);
    // The status rollup reflects the re-plan.
    expect(written.status?.planned).toBe(2);
    expect(written.status?.phase).toBe('done');
    expect(written.status?.conflicts).toBe(0);
  });

  it('routes a forced disposition + owner into data/<owner>/<category>', async () => {
    const photos: PlanSidecar = {
      ...sidecar,
      plan: { items: [item(rec('/mnt/src/cam/IMG_1.jpg', 5))], conflicts: [] },
    };
    const { io } = makeIO(photos, { '/mnt/src/cam/IMG_1.jpg': 'sha-c' });
    const plan = await runReplan(
      { explicit: { cam: { owner: 'mdopp', disposition: 'photos_immich' } } },
      io,
    );
    expect(plan.items[0].target).toBe('mdopp/photos/IMG_1.jpg');
    expect(plan.items[0].category).toBe('photos');
  });

  it('skips a folder marked skip', async () => {
    const { io } = makeIO(sidecar, content);
    const plan = await runReplan({ explicit: { alice: { disposition: 'skip' } } }, io);
    const aliceItem = plan.items.find(i => i.record.sourcePath.includes('/alice/'));
    expect(aliceItem?.action).toBe('skip-junk');
    expect(aliceItem?.target).toBeNull();
  });

  it('throws when there is no plan to re-plan', async () => {
    const { io } = makeIO(sidecar, content);
    const empty: ReplanIO = { ...io, readJson: async () => null };
    await expect(runReplan({ explicit: {} }, empty)).rejects.toThrow(/no plan/);
  });
});
