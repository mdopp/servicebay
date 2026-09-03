// THE CONTRACT TEST for the servicebay <-> disk-import-worker boundary (#2747).
//
// Three JSON documents cross that boundary, and until now nothing checked either
// end against the other: the worker wrote them, servicebay cast them
// (`JSON.parse(...) as WorkerStatus`), and the route re-declared a partial copy of
// the rule shape. This test pins both ends to the ONE schema module the worker
// exports (`contract/schema.ts`):
//
//   status.json          worker -> servicebay   (and servicebay -> worker on apply)
//   plan.json            worker -> servicebay
//   replan-request.json  servicebay -> worker
//
// Fixtures come from BOTH sides and are checked against each other, not against
// hand-written literals: the worker's own engine (`buildInventory`/`buildPlan`/
// `summarizeCategories`/`runReplan`) produces the worker-side documents, and
// servicebay's own `replanImport`/`recordRunError` produce the servicebay-side ones.
// Each side's output is then validated by the shared schema AND fed to the other
// side's reader, so a one-sided shape change fails here rather than on the box.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

import {
  DISPOSITIONS,
  PLAN_SIDECAR_FILE,
  STATUS_CONTRACT_VERSION,
  STATUS_FILE,
  buildInventory,
  buildPlan,
  dispositionSchema,
  initialStatus,
  planSidecarSchema,
  replanRequestSchema,
  ruleSchema,
  runReplan,
  summarizeCategories,
  workerStatusSchema,
  type PlanSidecar,
  type ReplanIO,
  type ReplanRequest,
  type Rule,
  type ScannedFile,
  type WorkerStatus,
} from '@servicebay/disk-import-worker';

// A real temp dir stands in for DATA_DIR so servicebay's status writer/reader runs
// its actual tmp+rename path instead of a mocked fs.
const { dataDir } = vi.hoisted(() => {
  // No imports are available inside a hoisted block — build the path by hand.
  const base = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '');
  return { dataDir: `${base}/sb-disk-import-contract-${process.pid}-${Math.random().toString(36).slice(2)}` };
});
vi.mock('@/lib/dirs', () => ({ DATA_DIR: dataDir }));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Immich provisioning is not part of the wire contract; keep the module hermetic.
vi.mock('./immichProvisionEnv', () => ({ resolveImmichProvision: vi.fn() }));

// Imported AFTER the mocks: servicebay's real host-apply module — the writer of
// replan-request.json and of the `error` status doc.
import { recordRunError, replanImport, runOutDir } from './apply';

beforeAll(() => mkdirSync(dataDir, { recursive: true }));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const MOUNT_BASE = '/mnt/src';

/** A small disk: two identical photos (one dedups away), a track, one junk file. */
const SCANNED: ScannedFile[] = [
  { path: `${MOUNT_BASE}/alice/DCIM/a.jpg`, size: 100, mtimeMs: 1 },
  { path: `${MOUNT_BASE}/alice/DCIM/a-copy.jpg`, size: 100, mtimeMs: 2 },
  { path: `${MOUNT_BASE}/music/track.mp3`, size: 50, mtimeMs: 3 },
  { path: `${MOUNT_BASE}/thumbs.db`, size: 1, mtimeMs: 4 },
];

/** Size-keyed stand-ins for the real hashers (the engine only needs determinism). */
const hashOf = (r: { size: number }): string => `hash-${r.size}`;
const fingerprintOf = (r: { size: number }): string => `fp-${r.size}`;

/**
 * THE WORKER SIDE: the two documents a scan pass leaves in the out volume, built
 * by the worker's own engine exactly as `runWorker` composes them.
 */
function workerScanOutput(runId: string): { status: WorkerStatus; sidecar: PlanSidecar } {
  const plan = buildPlan(buildInventory(SCANNED), hashOf, { fingerprintOf });
  const sidecar: PlanSidecar = {
    version: STATUS_CONTRACT_VERSION,
    runId,
    plan,
    mountBase: MOUNT_BASE,
  };
  const status: WorkerStatus = {
    ...initialStatus(runId, 'dry-run'),
    phase: 'done',
    step: `Dry run complete: ${plan.items.length} items planned, nothing written.`,
    scanned: SCANNED.length,
    planned: plan.items.length,
    conflicts: plan.conflicts.length,
    categories: summarizeCategories(plan),
    totalBytes: plan.items.reduce((sum, i) => sum + i.record.size, 0),
    planSidecar: PLAN_SIDECAR_FILE,
  };
  return { status, sidecar };
}

/** In-memory `ReplanIO` over a worker scan output — the worker's re-plan seam. */
function replanIO(seed: { status: WorkerStatus; sidecar: PlanSidecar }): {
  io: ReplanIO;
  written: { status?: WorkerStatus; sidecar?: PlanSidecar };
} {
  const written: { status?: WorkerStatus; sidecar?: PlanSidecar } = {};
  const io: ReplanIO = {
    readJson: async <T>(file: string): Promise<T | null> => {
      if (file === PLAN_SIDECAR_FILE) return (written.sidecar ?? seed.sidecar) as T;
      if (file === STATUS_FILE) return (written.status ?? seed.status) as T;
      return null;
    },
    writePlanSidecar: async sidecar => {
      written.sidecar = sidecar;
    },
    writeStatus: async status => {
      written.status = status;
    },
    hashOf,
    fingerprintOf,
  };
  return { io, written };
}

describe('worker -> servicebay: status.json + plan.json', () => {
  it('the documents the worker engine produces satisfy the shared schemas', () => {
    const { status, sidecar } = workerScanOutput('run-scan');

    // Parse the SERIALIZED bytes — that is what actually crosses the volume.
    const parsedStatus = workerStatusSchema.parse(JSON.parse(JSON.stringify(status)));
    const parsedSidecar = planSidecarSchema.parse(JSON.parse(JSON.stringify(sidecar)));

    expect(parsedStatus).toEqual(status);
    expect(parsedSidecar).toEqual(sidecar);
    // The fixture is a real plan, not an empty one: the duplicate photo deduped.
    expect(parsedSidecar.plan.items.length).toBe(SCANNED.length);
    expect(parsedSidecar.plan.items.map(i => i.action)).toContain('skip-dupe');
    expect(parsedStatus.categories.map(c => c.category)).toContain('photos');
  });

  it('servicebay reads a worker-written status.json and writes one back that still validates', async () => {
    const runId = 'run-roundtrip';
    const { status } = workerScanOutput(runId);
    const outDir = runOutDir(runId);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, STATUS_FILE), JSON.stringify(status), 'utf-8');

    // servicebay's own reader+writer (the detached-apply failure path).
    await recordRunError(runId, 'rsync failed');

    const back = workerStatusSchema.parse(
      JSON.parse(readFileSync(path.join(outDir, STATUS_FILE), 'utf-8')),
    );
    expect(back.phase).toBe('error');
    expect(back.error).toBe('rsync failed');
    // The worker's fields survive servicebay's rewrite — same document, same shape.
    expect(back.runId).toBe(runId);
    expect(back.categories).toEqual(status.categories);
    expect(back.totalBytes).toBe(status.totalBytes);
  });

  it('rejects a plan sidecar that lost a required field', () => {
    const { sidecar } = workerScanOutput('run-bad');
    const { mountBase: _dropped, ...withoutMountBase } = sidecar;
    expect(planSidecarSchema.safeParse(withoutMountBase).success).toBe(false);
    expect(workerStatusSchema.safeParse({ ...workerScanOutput('x').status, version: 2 }).success).toBe(
      false,
    );
  });
});

describe('servicebay -> worker: replan-request.json', () => {
  const request: ReplanRequest = {
    explicit: {
      'alice': { owner: 'alice', disposition: 'photos_immich' },
      'music': { disposition: 'music', mode: 'merge' },
    },
    rootDefault: { owner: 'shared' },
  };

  /** The exact bytes servicebay puts on the wire for the worker to read. */
  async function servicebayWireBytes(): Promise<string> {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await replanImport({ exec, runId: 'run-replan', container: 'disk-import-worker-run-replan', request });
    const writeArgv = exec.mock.calls[0][0] as string[];
    return writeArgv[writeArgv.length - 1];
  }

  it('the request servicebay writes into the container satisfies the shared schema', async () => {
    const parsed = replanRequestSchema.parse(JSON.parse(await servicebayWireBytes()));
    expect(parsed).toEqual(request);
  });

  it('the worker executes servicebay-authored bytes and answers with valid documents', async () => {
    const parsed = replanRequestSchema.parse(JSON.parse(await servicebayWireBytes()));
    const { io, written } = replanIO(workerScanOutput('run-replan'));

    await runReplan(parsed, io);

    const sidecar = planSidecarSchema.parse(JSON.parse(JSON.stringify(written.sidecar)));
    const status = workerStatusSchema.parse(JSON.parse(JSON.stringify(written.status)));
    expect(status.phase).toBe('done');
    expect(sidecar.runId).toBe('run-replan');
    // The routing servicebay asked for actually took effect: alice's photos are
    // now in her area, so this is a real execution of the request, not a no-op.
    const alice = sidecar.plan.items.filter(i => i.record.sourcePath.includes('/alice/'));
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.some(i => (i.target ?? '').startsWith('alice/'))).toBe(true);
  });

  it('rejects a rule axis neither side knows about', () => {
    expect(ruleSchema.safeParse({ owner: 'alice' }).success).toBe(true);
    expect(ruleSchema.safeParse({ owner: 'alice', destination: 'nas' }).success).toBe(false);
    expect(ruleSchema.safeParse({ disposition: 'not_a_disposition' }).success).toBe(false);
  });
});

describe('one schema, no re-declaration', () => {
  it('the disposition enum is the engine DISPOSITIONS list, in order', () => {
    expect(dispositionSchema.options).toEqual([...DISPOSITIONS]);
  });

  it('the schemas and the TypeScript contract types are the same shape', () => {
    // Compile-time assertions (checked by `npm run typecheck`, not at runtime):
    // each pair is assignable BOTH ways, so a field added, removed or retyped on
    // one side without the other is a tsc error rather than a box surprise.
    const status = [
      (v: z.infer<typeof workerStatusSchema>): WorkerStatus => v,
      (v: WorkerStatus): z.infer<typeof workerStatusSchema> => v,
    ];
    const sidecar = [
      (v: z.infer<typeof planSidecarSchema>): PlanSidecar => v,
      (v: PlanSidecar): z.infer<typeof planSidecarSchema> => v,
    ];
    const replan = [
      (v: z.infer<typeof replanRequestSchema>): ReplanRequest => v,
      (v: ReplanRequest): z.infer<typeof replanRequestSchema> => v,
    ];
    const rule = [
      (v: z.infer<typeof ruleSchema>): Rule => v,
      (v: Rule): z.infer<typeof ruleSchema> => v,
    ];
    expect([status, sidecar, replan, rule].every(pair => pair.length === 2)).toBe(true);
  });
});
