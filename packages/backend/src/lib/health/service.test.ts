/**
 * `HealthService` bootstrap-on-sync regression test (#935).
 *
 * The service-health bootstrap reads deployed services off the twin.
 * On a fresh process start (e.g. `systemctl --user restart servicebay`)
 * the agent hasn't synced yet, so an eager call at `HealthService.init`
 * finds an empty twin and registers no probes. The poller then sits
 * idle forever and every template's `services[].health` stays
 * undefined → the stacks API reports `ready=unknown` indefinitely.
 *
 * The fix waits for each node's `initialSyncComplete` to flip before
 * running bootstrap for that node. This test drives that race
 * explicitly: init with an empty twin, then flip the flag and assert
 * the bootstrap fires exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { bootstrapMock } = vi.hoisted(() => ({
  bootstrapMock: vi.fn().mockResolvedValue({ registered: [], skipped: [] }),
}));
vi.mock('./serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: bootstrapMock,
}));

// Keep the heavy init paths inert — we're only exercising the
// twin-subscription branch.
vi.mock('./init', () => ({ initializeDefaultChecks: vi.fn().mockResolvedValue(undefined) }));
const { getResultsMock, runMock, sendEmailMock } = vi.hoisted(() => ({
  getResultsMock: vi.fn((_id: string) => [] as unknown[]),
  runMock: vi.fn((_check: unknown) => undefined as unknown),
  sendEmailMock: vi.fn((_subject: string, _message: string) => Promise.resolve()),
}));
vi.mock('./store', () => ({
  HealthStore: { getChecks: () => [], getResults: (id: string) => getResultsMock(id) },
}));
vi.mock('./runner', () => ({
  CheckRunner: { run: (check: unknown) => runMock(check) },
}));
vi.mock('@/lib/email', () => ({
  sendEmailAlert: (subject: string, message: string) => sendEmailMock(subject, message),
}));
vi.mock('./notificationBatcher', () => ({
  NotificationBatcher: { start: vi.fn(), enqueue: () => false },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HealthService } from './service';
import type { CheckConfig, CheckResult } from './types';
import { DigitalTwinStore } from '@/lib/store/twin';
// Pre-warm the dynamic-import path used by `runServiceHealthBootstrap`
// so the first listener invocation in a test doesn't race
// `flushMicrotasks` against module loading.
await import('./serviceHealthBootstrap');

const flushMicrotasks = async () => {
  // Combine setImmediate + Promise resolutions to drain both the
  // macrotask queue (dynamic import resolution lands here in Vitest)
  // and any chained .then microtasks the bootstrap creates.
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(r => setImmediate(r));
    await Promise.resolve();
  }
};

beforeEach(() => {
  bootstrapMock.mockClear();
  // Reset the singleton's static state between tests so each `init`
  // call starts from a clean slate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HealthService as any).bootstrappedNodes = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsub = (HealthService as any).twinUnsubscribe;
  if (typeof unsub === 'function') unsub();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HealthService as any).twinUnsubscribe = null;
  // Clear the twin singleton's node state without rebuilding it.
  const twin = DigitalTwinStore.getInstance();
  twin.nodes = {};
});

// Stub Socket.IO server — only the `emit` method is used and HealthService
// calls it from the check scheduler, not the bootstrap path under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeIo = { emit: vi.fn() } as any;

describe('HealthService bootstrap-on-sync (#935)', () => {
  it('re-runs bootstrap after the agent flips initialSyncComplete', async () => {
    // Cold boot: twin is empty, init sees no synced nodes.
    await HealthService.init(fakeIo);
    expect(bootstrapMock).not.toHaveBeenCalled();

    // Agent finishes syncing → twin sets initialSyncComplete → listener
    // fires → bootstrap runs.
    const twin = DigitalTwinStore.getInstance();
    twin.registerNode('Local');
    twin.updateNode('Local', { initialSyncComplete: true });
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledWith('Local');
  });

  it('does not re-bootstrap the same node on subsequent twin updates', async () => {
    await HealthService.init(fakeIo);
    const twin = DigitalTwinStore.getInstance();
    twin.registerNode('Local');
    twin.updateNode('Local', { initialSyncComplete: true });
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledTimes(1);

    // Subsequent agent syncs keep flipping the twin — bootstrap must
    // not refire for an already-bootstrapped node.
    twin.updateNode('Local', { initialSyncComplete: true });
    twin.setNodeConnection('Local', true);
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });

  it('bootstraps each node independently as it finishes syncing', async () => {
    await HealthService.init(fakeIo);
    const twin = DigitalTwinStore.getInstance();
    twin.registerNode('Local');
    twin.registerNode('Remote');
    twin.updateNode('Local', { initialSyncComplete: true });
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledWith('Local');
    expect(bootstrapMock).toHaveBeenCalledTimes(1);

    twin.updateNode('Remote', { initialSyncComplete: true });
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledWith('Remote');
    expect(bootstrapMock).toHaveBeenCalledTimes(2);
  });

  it('runs immediately for nodes already past initial sync at init time', async () => {
    // Hot re-init: a previous install pass marked Local synced before
    // HealthService.init landed (the install runner path #810).
    const twin = DigitalTwinStore.getInstance();
    twin.registerNode('Local');
    twin.updateNode('Local', { initialSyncComplete: true });
    bootstrapMock.mockClear();

    await HealthService.init(fakeIo);
    await flushMicrotasks();
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock).toHaveBeenCalledWith('Local');
  });
});

describe('HealthService.runAndEmit alert gating (#1651)', () => {
  const check: CheckConfig = { id: 'domain:photos', name: 'Photos', type: 'domain' } as CheckConfig;
  const failResult: CheckResult = { check_id: 'domain:photos', status: 'fail', message: 'down', latency: 0, timestamp: 't' };
  const okResult: CheckResult = { check_id: 'domain:photos', status: 'ok', message: '', latency: 1, timestamp: 't' };
  // runAndEmit is a private static; reach it via cast (established pattern below).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runAndEmit = (c: CheckConfig) => (HealthService as any).runAndEmit(c);

  beforeEach(() => {
    runMock.mockReset();
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    getResultsMock.mockReset().mockReturnValue([]);
    fakeIo.emit.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HealthService as any).io = fakeIo;
  });

  it('does not alert on a single fail below the domain threshold (3)', async () => {
    runMock.mockResolvedValue(failResult);
    getResultsMock.mockReturnValue([failResult]); // streak of 1
    await runAndEmit(check);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fakeIo.emit).not.toHaveBeenCalledWith('health:alert', expect.objectContaining({ type: 'error' }));
    // The silent update still broadcasts.
    expect(fakeIo.emit).toHaveBeenCalledWith('health:update', { checkId: 'domain:photos', result: failResult });
  });

  it('alerts (emit + email) on the third consecutive fail', async () => {
    runMock.mockResolvedValue(failResult);
    getResultsMock.mockReturnValue([failResult, failResult, failResult]); // streak of 3
    await runAndEmit(check);
    expect(fakeIo.emit).toHaveBeenCalledWith('health:alert', expect.objectContaining({ type: 'error' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toContain('Photos');
  });

  it('sends a recovery alert only when a prior fail alert was sent', async () => {
    runMock.mockResolvedValue(okResult);
    // ok now, preceded by a fail streak that met the threshold.
    getResultsMock.mockReturnValue([okResult, failResult, failResult, failResult]);
    await runAndEmit(check);
    expect(fakeIo.emit).toHaveBeenCalledWith('health:alert', expect.objectContaining({ type: 'success' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a recovery alert when the prior fail never reached the threshold', async () => {
    runMock.mockResolvedValue(okResult);
    // ok now, only one prior fail (below the 3 threshold) → no alert was sent.
    getResultsMock.mockReturnValue([okResult, failResult]);
    await runAndEmit(check);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fakeIo.emit).not.toHaveBeenCalledWith('health:alert', expect.objectContaining({ type: 'success' }));
  });

  it('swallows a CheckRunner failure without throwing', async () => {
    runMock.mockRejectedValue(new Error('probe blew up'));
    await expect(runAndEmit(check)).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
