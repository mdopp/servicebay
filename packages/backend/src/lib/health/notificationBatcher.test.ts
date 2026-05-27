import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above top-level `const` declarations. `vi.hoisted`
// guarantees the mock and the reference our assertions read are the
// same vi.fn instance.
const { sendEmailAlertMock } = vi.hoisted(() => ({
  sendEmailAlertMock: vi.fn<(subject: string, message: string) => Promise<undefined>>(async () => undefined),
}));
vi.mock('@/lib/email', () => ({
  sendEmailAlert: sendEmailAlertMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NotificationBatcher } from './notificationBatcher';
import type { CheckConfig, CheckResult } from './types';

beforeEach(() => {
  sendEmailAlertMock.mockClear();
  NotificationBatcher._resetForTesting();
});

function check(id: string, name = id): CheckConfig {
  return {
    id,
    name,
    type: 'http',
    target: `http://${id}.example`,
    interval: 60,
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function result(status: 'ok' | 'fail', message?: string, checkId = 'test-check'): CheckResult {
  return { check_id: checkId, status, timestamp: '2026-01-01T00:00:00Z', message };
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('NotificationBatcher', () => {
  it('returns false when not active so callers fall through to per-event email', () => {
    expect(NotificationBatcher._activeForTesting()).toBe(false);
    expect(NotificationBatcher.enqueue('fail', check('nginx'), result('fail'))).toBe(false);
  });

  it('buffers events during the grace window and returns true', () => {
    NotificationBatcher.start({ maxMs: 5000, settleMs: 1000 });
    expect(NotificationBatcher.enqueue('fail', check('nginx'), result('fail'))).toBe(true);
    expect(NotificationBatcher._pendingForTesting()).toHaveLength(1);
  });

  it('manual flush sends digest immediately when at least one check is still failing', async () => {
    NotificationBatcher.start({ maxMs: 60_000, settleMs: 1000 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail', 'connection refused'));
    await NotificationBatcher.flush('manual');
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toContain('nginx');
    expect(body).toContain('connection refused');
    expect(NotificationBatcher._activeForTesting()).toBe(false);
  });

  it('flushes early after the settle window with no new events', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail', 'connection refused'));
    expect(sendEmailAlertMock).not.toHaveBeenCalled();
    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toContain('nginx');
    expect(body).toContain('connection refused');
    expect(NotificationBatcher._activeForTesting()).toBe(false);
  });

  it('flushes at max grace even if events keep arriving', async () => {
    NotificationBatcher.start({ maxMs: 200, settleMs: 10_000 });
    // Drip events every 50 ms — settle (10 s) never fires.
    for (let i = 0; i < 3; i++) {
      NotificationBatcher.enqueue('fail', check(`svc-${i}`), result('fail'));
      await wait(50);
    }
    expect(sendEmailAlertMock).not.toHaveBeenCalled();
    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces per check.id — latest state wins', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('nginx'), result('ok'));
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail', 'final'));
    NotificationBatcher.enqueue('fail', check('adguard'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('adguard'), result('ok'));

    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();

    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toMatch(/nginx/);
    expect(body).toContain('final');
    expect(body).not.toMatch(/Check: adguard/);
  });

  it('sends no email when every transient event recovered during boot', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('nginx'), result('ok'));
    NotificationBatcher.enqueue('fail', check('auth'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('auth'), result('ok'));

    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();

    expect(sendEmailAlertMock).not.toHaveBeenCalled();
  });

  it('uses a digest subject for >1 still-failing checks', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('fail', check('auth'), result('fail'));
    NotificationBatcher.enqueue('fail', check('adguard'), result('fail'));

    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();

    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    expect(sendEmailAlertMock.mock.calls[0][0]).toMatch(/3 health checks failing/);
  });

  it('repeated start() calls are no-ops during an active window', () => {
    NotificationBatcher.start({ maxMs: 5000, settleMs: 1000 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.start({ maxMs: 99_999, settleMs: 99_999 });
    expect(NotificationBatcher._pendingForTesting()).toHaveLength(1);
  });

  it('falls back to per-event after flush', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    await wait(150);
    await NotificationBatcher._awaitFlushForTesting();
    expect(NotificationBatcher.enqueue('fail', check('auth'), result('fail'))).toBe(false);
  });
});
