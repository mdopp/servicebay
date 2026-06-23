import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'socket.io';

const execMock = vi.fn();
const emitMock = vi.fn();

type ProgressPayload = { step: string; progress: number; message: string };
type GlobalWithUpdater = Omit<typeof global, 'updaterIO'> & { updaterIO?: Server };

vi.mock('@/lib/executor', () => ({
  getExecutor: vi.fn(() => ({ exec: execMock })),
}));

describe('performUpdate', () => {
  beforeEach(() => {
    execMock.mockReset();
    emitMock.mockReset();
    (global as GlobalWithUpdater).updaterIO = { emit: emitMock } as unknown as Server;
  });

  afterEach(() => {
    delete (global as GlobalWithUpdater).updaterIO;
    vi.clearAllMocks();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('pulls image, emits pull output, and recreates + restarts service', async () => {
    execMock.mockResolvedValue({ stdout: 'pull ok\nstatus: done', stderr: '' });

    const { performUpdate } = await import('@/lib/updater');

    await performUpdate('v1.2.3');
    await flush(); // let the detached recreate/restart run

    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'podman pull ghcr.io/mdopp/servicebay:latest',
      { timeoutMs: 5 * 60 * 1000 }
    );
    // #2063: recreate the container (rm -f) so the freshly-pulled image lands,
    // then restart via systemd.
    const cmds = execMock.mock.calls.map((c) => String(c[0]));
    expect(cmds).toContain('podman rm -f servicebay');
    expect(cmds).toContain('systemctl --user restart --no-block servicebay.service');

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
