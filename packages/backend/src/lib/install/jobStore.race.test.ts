/**
 * createJob serialization (#1100).
 *
 * Without the in-process lock, two parallel POSTs to /api/install/start
 * could both pass the route's `getCurrentJob()` pre-check and both
 * write a job — two installs would then race on shared host state
 * (systemd quadlets, nginx blocks, podman networks) with no operator
 * visibility. The lock + re-check inside `createJob` ensures the
 * second parallel caller sees the first's write and throws
 * `InstallInProgressError`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { vi } from 'vitest';

// Mock DATA_DIR to a process-scoped tmpdir so the test exercises the
// real filesystem path (no fs mock) without colliding with the dev box.
vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-jobstore-race-${process.pid}`),
}));

const TEST_DIR = path.join(os.tmpdir(), `sb-jobstore-race-${process.pid}`);

import { createJob, getCurrentJob, InstallInProgressError, type JobInput } from './jobStore';

function mkInput(): JobInput {
  return {
    items: [{ name: 'stub', checked: true }],
    variables: [],
    cleanInstall: false,
    cleanInstallConfirm: '',
    templateSource: 'test',
    host: 'localhost',
  };
}

beforeEach(async () => {
  await fs.rm(path.join(TEST_DIR, 'install-jobs'), { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'install-jobs'), { recursive: true });
});

describe('createJob serialization (#1100)', () => {
  it('rejects a second concurrent createJob with InstallInProgressError', async () => {
    const results = await Promise.allSettled([
      createJob({ source: 'a', input: mkInput() }),
      createJob({ source: 'b', input: mkInput() }),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(InstallInProgressError);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    expect((failure.reason as InstallInProgressError).existingJobId).toBe(winner.id);
  });

  it('lets a fresh createJob succeed once the previous job is no longer active', async () => {
    const first = await createJob({ source: 'first', input: mkInput() });
    // Flip the first job out of an active phase. `getCurrentJob` only
    // considers running / needs_credentials, so a `done` job clears
    // the gate.
    const statePath = path.join(TEST_DIR, 'install-jobs', `${first.id}.json`);
    const raw = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    raw.phase = 'done';
    await fs.writeFile(statePath, JSON.stringify(raw));
    // Drop the mem-cache entry so getCurrentJob re-reads from disk.
    // (The job-store re-reads via listJobs, which always hits disk —
    // so this is belt-and-braces.)
    const second = await createJob({ source: 'second', input: mkInput() });
    expect(second.id).not.toBe(first.id);
    const active = await getCurrentJob();
    expect(active?.id).toBe(second.id);
  });

  it('survives a thrown error in one createJob without breaking the chain', async () => {
    // The lock pattern uses .then(fn, fn) + .catch(() => undefined) so
    // a rejection on one call mustn't strand subsequent calls.
    const a = await createJob({ source: 'a', input: mkInput() });
    // A second concurrent call should reject — but a third call
    // afterwards (with the first job gone) must still succeed.
    await expect(createJob({ source: 'b', input: mkInput() }))
      .rejects.toBeInstanceOf(InstallInProgressError);
    // Mark `a` done so the next caller is allowed through.
    const statePath = path.join(TEST_DIR, 'install-jobs', `${a.id}.json`);
    const raw = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    raw.phase = 'done';
    await fs.writeFile(statePath, JSON.stringify(raw));
    const c = await createJob({ source: 'c', input: mkInput() });
    expect(c.source).toBe('c');
  });
});
