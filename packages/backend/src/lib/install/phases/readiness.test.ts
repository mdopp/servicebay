/**
 * The two readiness waits (#2742 cut of #810/#627).
 *
 * `isServiceReady` and the happy path of `waitForDependencies` are covered
 * from `runner.test.ts`. What is asserted here is the part that only shows up
 * over time: the progress/heartbeat lines, the cap that lets a slow box
 * through instead of wedging the install, and the abort check on every
 * iteration. Timers are faked so the 3-minute caps cost nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
const isJobAbortedMock = vi.fn<(jobId: string) => boolean>();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
  isJobAborted: (jobId: string) => isJobAbortedMock(jobId),
}));

const snapshotMock = vi.fn();
vi.mock('@/lib/store/repository', () => ({ getStoreSnapshot: () => snapshotMock() }));

vi.mock('@/lib/health/serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: vi.fn().mockResolvedValue(undefined),
}));

import { settleWait, waitForDependencies } from './readiness';

type TwinService = { name: string; active?: boolean; health?: { ready: boolean } };
const twinWith = (services: TwinService[]) => ({ nodes: { Local: { services } } });

const lines = () => logMock.mock.calls.map(c => c[1]);

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  isJobAbortedMock.mockReset().mockReturnValue(false);
  snapshotMock.mockReset().mockReturnValue({ nodes: {} });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settleWait', () => {
  it('returns immediately when the run deployed nothing', async () => {
    await settleWait('job1', [], 'Local');
    expect(logMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('reports the count and finishes as soon as everything is up', async () => {
    snapshotMock.mockReturnValue(twinWith([
      { name: 'nginx', health: { ready: true } },
      { name: 'auth.service', active: true },
    ]));

    await settleWait('job1', [{ name: 'nginx' }, { name: 'auth' }], 'Local');

    expect(lines()).toEqual([
      'Waiting for services to become active... (2/2 up)',
      '✅ All 2 services active after 0s.',
    ]);
  });

  it('logs a fresh count each time one more service comes up', async () => {
    snapshotMock.mockReturnValue(twinWith([{ name: 'nginx', active: true }]));
    const wait = settleWait('job1', [{ name: 'nginx' }, { name: 'auth' }], 'Local');

    await vi.advanceTimersByTimeAsync(5_000);
    snapshotMock.mockReturnValue(twinWith([{ name: 'nginx', active: true }, { name: 'auth', active: true }]));
    await vi.advanceTimersByTimeAsync(5_000);
    await wait;

    expect(lines()).toEqual([
      'Waiting for services to become active... (1/2 up)',
      'Waiting for services to become active... (2/2 up)',
      '✅ All 2 services active after 10s.',
    ]);
  });

  it('heartbeats every 15s while the count is unchanged, so a slow pull never looks hung', async () => {
    snapshotMock.mockReturnValue(twinWith([{ name: 'nginx', active: true }]));
    const wait = settleWait('job1', [{ name: 'nginx' }, { name: 'auth' }], 'Local');

    await vi.advanceTimersByTimeAsync(20_000);
    const heartbeats = lines().filter(l => l.startsWith('Still waiting...'));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0]).toMatch(/^Still waiting\.\.\. \(1\/2 up, \d+s elapsed\)$/);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await wait;
  });

  it('gives up after the 3-minute cap and says what is still down, rather than wedging the run', async () => {
    snapshotMock.mockReturnValue(twinWith([{ name: 'nginx', active: true }]));
    const wait = settleWait('job1', [{ name: 'nginx' }, { name: 'auth' }], 'Local');

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 5_000);
    await wait;

    expect(lines().at(-1)).toMatch(/^⚠️ 1\/2 services active after \d+s — slow image pulls or a real failure/);
  });

  it('bails out the moment the operator aborts', async () => {
    isJobAbortedMock.mockReturnValue(true);
    await settleWait('job1', [{ name: 'nginx' }], 'Local');
    // No progress line, and above all no terminal verdict — the runner
    // patches `aborted`, and a "✅ all active" line here would contradict it.
    expect(logMock).not.toHaveBeenCalled();
  });
});

describe('waitForDependencies', () => {
  it('proceeds after the cap with a warning naming what never came up (#810)', async () => {
    snapshotMock.mockReturnValue(twinWith([{ name: 'nginx', health: { ready: true } }]));
    const wait = waitForDependencies('job1', { name: 'media', dependencies: ['nginx', 'auth'] }, 'Local');

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 3_000);
    await wait;

    expect(lines()[0]).toBe("Waiting for media's dependencies to become healthy: nginx, auth...");
    expect(lines().some(l => l.startsWith("Still waiting for auth to be healthy"))).toBe(true);
    expect(lines().at(-1)).toMatch(/^⚠️ media's dependencies not healthy after \d+s \(auth\)\./);
  });

  it('stops waiting on an abort instead of holding the run for the full cap', async () => {
    isJobAbortedMock.mockReturnValue(true);
    await waitForDependencies('job1', { name: 'media', dependencies: ['auth'] }, 'Local');
    // The opening line is logged before the loop; nothing after it.
    expect(lines()).toEqual(["Waiting for media's dependencies to become healthy: auth..."]);
  });
});
