import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlanSidecar } from '@servicebay/disk-import-worker';

// The heavy apply (rsync/chown/catalog) lives in the worker package; stub it so
// these tests assert servicebay's HOST-apply WIRING (#1972): it reads the worker's
// plan.json from the out dir, rebases the source from the worker mountBase to the
// HOST mountpoint, runs applyPlan with the real exec, and fires Immich post-apply.
const applyPlanMock = vi.fn();
const catalogClose = vi.fn();
const provisionExternalLibrariesMock = vi.fn();
const scanLibrariesForOwnersMock = vi.fn();
// hashSourceFile runs `sha256sum <path>` through the agent exec (host-side, #1983).
const hashSourceFileMock = vi.fn();

vi.mock('@servicebay/disk-import-worker', () => ({
  applyPlan: (...args: unknown[]) => applyPlanMock(...args),
  hashSourceFile: (...a: unknown[]) => hashSourceFileMock(...a),
  ImportCatalog: class { close = catalogClose; },
  provisionExternalLibraries: (...a: unknown[]) => provisionExternalLibrariesMock(...a),
  scanLibrariesForOwners: (...a: unknown[]) => scanLibrariesForOwnersMock(...a),
  STATUS_FILE: 'status.json',
  PLAN_SIDECAR_FILE: 'plan.json',
  REPLAN_REQUEST_FILE: 'replan-request.json',
}));

vi.mock('@/lib/dirs', () => ({ DATA_DIR: '/app/data' }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const resolveImmichProvisionMock = vi.fn();
vi.mock('./immichProvisionEnv', () => ({
  resolveImmichProvision: () => resolveImmichProvisionMock(),
}));

// Capture status.json writes; stub plan.json reads.
//
// MODEL the real tmp→rename atomic write so the #2044 race test is faithful: a
// write's bytes only become the "persisted" status.json on `rename` (the commit),
// not on the tmp `writeFile`. `tmpData` holds the in-flight tmp bytes; `committed`
// holds what a poller would actually read; `renameGate` lets a test stall a specific
// commit so a late progress rename can be ordered AFTER the done rename.
const { writes, committed, writeGate } = vi.hoisted(() => ({
  writes: [] as Array<{ file: string; data: string }>,
  committed: { value: '' },
  // A test sets `.hold` to a gate: given the bytes a tmp-write is about to stage, it
  // returns a promise that write awaits (stalling that one writeOutStatus call mid
  // flight) or null to proceed. Lets a test interleave a fire-and-forget progress
  // write so its commit attempt lands AFTER the `done` tick (#2044).
  writeGate: { hold: null as null | ((data: string) => Promise<void> | null) },
}));
vi.mock('node:fs/promises', () => {
  // Model the real tmp→rename atomic write: bytes are staged to a tmp file and only
  // become the persisted status.json on `rename` (the commit). `committed.value` is
  // what a poller would actually read.
  const tmpStage = { value: '' };
  const fsMock = {
    readFile: vi.fn(async (file: string) => {
      if (file.endsWith('plan.json')) return JSON.stringify(hoistedSidecar());
      if (file.endsWith('status.json')) throw new Error('no status yet');
      throw new Error(`unexpected read ${file}`);
    }),
    writeFile: vi.fn(async (file: string, data: string) => {
      // status writes go via tmp + rename; record under the final name either way.
      writes.push({ file: file.replace(/\.tmp$/, ''), data });
      const gate = writeGate.hold?.(data);
      if (gate) await gate; // stall this writeOutStatus call mid-flight if gated
      if (file.endsWith('.tmp')) tmpStage.value = data;
      else committed.value = data; // direct (fallback-path) write commits immediately
    }),
    rename: vi.fn(async () => {
      committed.value = tmpStage.value; // the commit point
    }),
    mkdir: vi.fn(async () => {}),
  };
  return { ...fsMock, default: fsMock };
});

/** Plan fixture the fs mock returns for plan.json (hoisted-safe). */
function hoistedSidecar() {
  return {
    version: 1,
    runId: 'run1',
    mountBase: '/mnt/src',
    plan: {
      items: [
        { category: 'photos', action: 'copy', target: 'photos/a.jpg', record: { sourcePath: '/mnt/src/dcim/a.jpg', size: 10, mtimeMs: 1, ext: 'jpg', name: 'a.jpg' } },
      ],
      conflicts: [],
    },
  };
}

import { applyImport, rebasePlanSource, replanImport, triggerScan } from './apply';

function recordOf(sourcePath: string) {
  return { sourcePath, size: 10, mtimeMs: 1, ext: 'jpg', name: 'a.jpg' };
}

function sidecarFixture(): PlanSidecar {
  return {
    version: 1,
    runId: 'run1',
    mountBase: '/mnt/src',
    plan: {
      items: [
        { category: 'photos', action: 'copy', target: 'photos/a.jpg', record: recordOf('/mnt/src/dcim/a.jpg') },
      ],
      conflicts: [],
    } as PlanSidecar['plan'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  committed.value = '';
  writeGate.hold = null;
  applyPlanMock.mockResolvedValue({ applied: 1, photoOwners: ['shared'] });
  resolveImmichProvisionMock.mockResolvedValue({
    cfg: { serverUrl: 'http://127.0.0.1:2283', adminApiKey: 'k' },
    boxUsers: [],
  });
  provisionExternalLibrariesMock.mockResolvedValue({ libraryIdByOwner: new Map([['shared', 'lib1']]), unmatchedUsers: [] });
  scanLibrariesForOwnersMock.mockResolvedValue(undefined);
  hashSourceFileMock.mockResolvedValue('a'.repeat(64));
});

describe('rebasePlanSource', () => {
  it('rewrites source paths from the worker mountBase to the host mountpoint', () => {
    const plan = rebasePlanSource(sidecarFixture(), '/run/servicebay/disk-import/sda1');
    expect(plan.items[0].record.sourcePath).toBe('/run/servicebay/disk-import/sda1/dcim/a.jpg');
    // target / action untouched
    expect(plan.items[0].target).toBe('photos/a.jpg');
  });

  it('leaves a non-matching source path as-is', () => {
    const sc = sidecarFixture();
    sc.plan.items[0].record.sourcePath = '/somewhere/else/a.jpg';
    const plan = rebasePlanSource(sc, '/run/servicebay/disk-import/sda1');
    expect(plan.items[0].record.sourcePath).toBe('/somewhere/else/a.jpg');
  });
});

describe('triggerScan', () => {
  it('detached-execs the scan walk in the serve container over the live mount', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await triggerScan(exec, 'disk-import-worker-run1', 973);
    const argv = exec.mock.calls[0][0] as string[];
    expect(argv.slice(0, 4)).toEqual(['podman', 'exec', '-d', 'disk-import-worker-run1']);
    expect(argv).toContain('--mount');
    expect(argv).toContain('/mnt/src');
    expect(argv).toContain('--out');
    expect(argv).toContain('/out');
    expect(argv).toContain('973');
  });

  it('throws when the scan trigger exits non-zero', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
    await expect(triggerScan(exec, 'c', 973)).rejects.toThrow(/scan trigger failed/);
  });
});

describe('replanImport', () => {
  it('writes the rules IN the container then LAUNCHES --replan DETACHED (#2009)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const request = { explicit: { alice: { owner: 'alice' } }, rootDefault: { owner: 'shared' } };
    const preUpdatedAt = await replanImport({ exec, runId: 'run1', container: 'disk-import-worker-run1', request });
    // Returns the pre-launch status timestamp so the poller can spot the NEW done.
    expect(typeof preUpdatedAt).toBe('number');

    // 1st exec: write replan-request.json INSIDE the container (not servicebay fs —
    // a servicebay write is unreadable by the worker due to SELinux MCS).
    const writeArgv = exec.mock.calls[0][0] as string[];
    expect(writeArgv.slice(0, 4)).toEqual(['podman', 'exec', 'disk-import-worker-run1', 'node']);
    expect(writeArgv).toContain('/out/replan-request.json');
    expect(writeArgv).toContain(JSON.stringify(request));
    // No servicebay fs write of the request.
    expect(writes.find(w => w.file.endsWith('replan-request.json'))).toBeUndefined();

    // 2nd exec: the one-shot --replan over /out, launched DETACHED (`-d`) so the
    // multi-minute re-plan doesn't block the POST (#2009).
    const replanArgv = exec.mock.calls[1][0] as string[];
    expect(replanArgv.slice(0, 4)).toEqual(['podman', 'exec', '-d', 'disk-import-worker-run1']);
    expect(replanArgv).toContain('--replan');
    expect(replanArgv).toContain('/out');
  });

  it('throws when the worker re-plan launch exits non-zero', async () => {
    // 1st exec (write request) succeeds; 2nd (--replan launch) fails.
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no plan' });
    await expect(
      replanImport({ exec, runId: 'run1', container: 'c', request: { explicit: {} } }),
    ).rejects.toThrow(/re-plan launch failed/);
  });

  it('throws when writing the replan request into the container fails', async () => {
    const exec = vi.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'denied' });
    await expect(
      replanImport({ exec, runId: 'run1', container: 'c', request: { explicit: {} } }),
    ).rejects.toThrow(/writing replan request failed/);
  });
});

describe('applyImport', () => {
  const exec = vi.fn();

  it('runs applyPlan with the real exec, the HOST mountpoint, and the rebased plan', async () => {
    await applyImport({ exec, runId: 'run1', mountpoint: '/run/servicebay/disk-import/sda1', shareGid: 1024 });

    expect(applyPlanMock).toHaveBeenCalledTimes(1);
    const [plan, opts] = applyPlanMock.mock.calls[0];
    expect(opts.mountpoint).toBe('/run/servicebay/disk-import/sda1');
    expect(opts.shareGid).toBe(1024);
    // The exec is WRAPPED to inject a generous per-op timeout (a multi-GB file's
    // rsync/hash blows the agent's 30s default → #2010-class apply failure). It
    // still delegates to the real exec, and a per-call NUMBER overrides the default.
    opts.exec(['rsync', 'a', 'b'], { sudo: true });
    expect(exec).toHaveBeenLastCalledWith(['rsync', 'a', 'b'], { sudo: true, timeoutMs: 1_800_000 });
    // REGRESSION: runSha256sum passes an explicit `{ timeoutMs: undefined }`; the
    // wrap must NOT let that clobber the default back to undefined (that re-broke
    // the apply at 30s). undefined/absent → default; a real number still wins.
    opts.exec(['sha256sum', 'big.zip'], { timeoutMs: undefined });
    expect(exec).toHaveBeenLastCalledWith(['sha256sum', 'big.zip'], { timeoutMs: 1_800_000 });
    opts.exec(['x'], { timeoutMs: 5_000 });
    expect(exec).toHaveBeenLastCalledWith(['x'], { timeoutMs: 5_000 });
    // the plan handed to applyPlan reads the source from the HOST mount
    expect(plan.items[0].record.sourcePath).toBe('/run/servicebay/disk-import/sda1/dcim/a.jpg');
  });

  it('passes a HOST-exec hashOf (sha256sum via exec, never an in-process readFileSync) — #1983', async () => {
    await applyImport({ exec, runId: 'run1', mountpoint: '/run/servicebay/disk-import/sda1', shareGid: 1024 });

    const [, opts] = applyPlanMock.mock.calls[0];
    // hashOf resolves a record's sha by handing the rebased HOST path to the
    // worker's host-side hasher (sha256sum through exec) — the fix for the
    // ENOENT-zero-bytes bug. It delegates EXCLUSIVELY to hashSourceFile(exec, …);
    // apply.ts imports no fs read (the old readFileSync(hostPath) is gone), so the
    // source bytes can only flow through the host exec.
    const sha = await opts.hashOf({ sourcePath: '/run/servicebay/disk-import/sda1/dcim/a.jpg' });
    expect(sha).toBe('a'.repeat(64));
    // Hashes via the host exec (the wrapped one, with the generous timeout), never fs.
    expect(hashSourceFileMock).toHaveBeenCalledWith(expect.any(Function), '/run/servicebay/disk-import/sda1/dcim/a.jpg');
    const wrapped = hashSourceFileMock.mock.calls[0][0] as (a: string[], o?: object) => unknown;
    wrapped(['sha256sum', 'x']);
    expect(exec).toHaveBeenCalledWith(['sha256sum', 'x'], { timeoutMs: 1_800_000 });
  });

  it('fires the Immich provision + scan for the photo owners after apply', async () => {
    await applyImport({ exec, runId: 'run1', mountpoint: '/run/servicebay/disk-import/sda1', shareGid: 1024 });
    expect(provisionExternalLibrariesMock).toHaveBeenCalled();
    expect(scanLibrariesForOwnersMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Map),
      ['shared'],
    );
  });

  it('skips Immich when no photos were written', async () => {
    applyPlanMock.mockResolvedValue({ applied: 1, photoOwners: [] });
    const r = await applyImport({ exec, runId: 'run1', mountpoint: '/m', shareGid: 1024 });
    expect(provisionExternalLibrariesMock).not.toHaveBeenCalled();
    expect(r.immichNote).toBe('');
  });

  it('writes an applying-phase then a done-phase status.json for the tile poll', async () => {
    await applyImport({ exec, runId: 'run1', mountpoint: '/m', shareGid: 1024 });
    const phases = writes.map(w => (JSON.parse(w.data) as { phase: string }).phase);
    expect(phases).toContain('applying');
    expect(phases.at(-1)).toBe('done');
  });

  it('keeps the terminal status when a late progress write lands after done (#2044)', async () => {
    // Reproduce the race: applyPlan fires a fire-and-forget `onProgress` write
    // (phase:applying) whose disk write is STALLED until after the `done` tick has
    // committed. Without the monotonic-updatedAt guard the stale `applying` write
    // would clobber `done` and strand the tile on "Applying…"; with it the late write
    // is detected as superseded and dropped before it can commit.
    let releaseLateWrite!: () => void;
    const lateWriteResumed = new Promise<void>(res => (releaseLateWrite = res));
    let progressFired = false;

    applyPlanMock.mockImplementation(async (_plan, opts: { onProgress: (p: { copied: number }) => void }) => {
      // Stall ONLY the progress write (the one staging applied:7) mid-flight, so the
      // subsequent `done` tick wins the commit race.
      writeGate.hold = (data: string) =>
        (JSON.parse(data) as { applied: number }).applied === 7 ? lateWriteResumed : null;
      opts.onProgress({ copied: 7 }); // fire-and-forget progress write (phase:applying)
      writeGate.hold = null; // the `done` tick is not gated
      progressFired = true;
      return { applied: 9, photoOwners: [] };
    });

    await applyImport({ exec, runId: 'run1', mountpoint: '/m', shareGid: 1024 });
    expect(progressFired).toBe(true);

    // The `done` tick has committed; status.json is terminal.
    expect((JSON.parse(committed.value) as { phase: string }).phase).toBe('done');

    // NOW let the stalled progress write resume — the late, stale write.
    releaseLateWrite();
    await new Promise(r => setTimeout(r, 0)); // flush the resumed write's microtasks

    // It must NOT have overwritten the terminal status — the tile stays on done.
    const persisted = JSON.parse(committed.value) as { phase: string; applied: number };
    expect(persisted.phase).toBe('done');
    expect(persisted.applied).toBe(9);
  });

  it('records an error-phase status and rethrows on a real apply failure', async () => {
    applyPlanMock.mockRejectedValue(new Error('rsync failed (code 1)'));
    await expect(applyImport({ exec, runId: 'run1', mountpoint: '/m', shareGid: 1024 })).rejects.toThrow('rsync failed');
    const last = JSON.parse(writes.at(-1)!.data) as { phase: string; error: string };
    expect(last.phase).toBe('error');
    expect(last.error).toContain('rsync failed');
    expect(catalogClose).toHaveBeenCalled();
  });

  it('does not fail apply when Immich provisioning throws (best-effort)', async () => {
    provisionExternalLibrariesMock.mockRejectedValue(new Error('immich down'));
    const r = await applyImport({ exec, runId: 'run1', mountpoint: '/m', shareGid: 1024 });
    expect(r.applied).toBe(1);
    expect(r.immichNote).toContain('skipped');
  });
});
