import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execMock = vi.fn();
const emitMock = vi.fn();

type ProgressPayload = { step: string; progress: number; message: string };
type GlobalWithUpdater = typeof global & { updaterIO?: { emit: typeof emitMock } };

vi.mock('../../src/lib/executor', () => ({
  getExecutor: vi.fn(() => ({ exec: execMock })),
}));

describe('performUpdate', () => {
  beforeEach(() => {
    execMock.mockReset();
    emitMock.mockReset();
    (global as GlobalWithUpdater).updaterIO = { emit: emitMock };
  });

  afterEach(() => {
    delete (global as GlobalWithUpdater).updaterIO;
    vi.clearAllMocks();
  });

  it('pulls image, emits pull output, and restarts service via systemctl', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'pull ok\nstatus: done', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const { performUpdate } = await import('../../src/lib/updater');

    await performUpdate('v1.2.3');

    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'podman pull ghcr.io/mdopp/servicebay:latest',
      { timeoutMs: 5 * 60 * 1000 }
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'systemctl --user restart --no-block servicebay.service'
    );

    const progressEvents = emitMock.mock.calls
      .filter(([event]) => event === 'update:progress')
      .map(([, payload]) => payload as ProgressPayload);

    const downloadEvent = progressEvents.find((p) => p.step === 'download' && p.progress === 100);
    expect(downloadEvent?.message).toContain('pull ok');

    const restartEvents = progressEvents.filter((p) => p.step === 'restart');
    expect(restartEvents.length).toBeGreaterThan(0);
    expect(restartEvents[0].progress).toBe(0);
  });
});
