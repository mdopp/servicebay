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
    expect(sendEmailAlertMock.mock.calls[0][0]).toMatch(/3 checks still failing/);
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

describe('NotificationBatcher root-cause coalescing (#1652)', () => {
  function svc(name: string): CheckConfig {
    return { id: `svc-${name}`, name: `Service: ${name}`, type: 'service', target: name, interval: 60, enabled: true, created_at: 't' };
  }
  function domain(id: string, target: string): CheckConfig {
    return { id, name: `Domain — ${id}`, type: 'domain', target, interval: 60, enabled: true, created_at: 't', domainConfig: { expectedScheme: 'https', isPublic: true } };
  }
  const gateway: CheckConfig = { id: 'gw', name: 'Internet Gateway', type: 'ping', target: '192.168.178.1', interval: 60, enabled: true, created_at: 't' };

  it('digest collapses the restart cascade to root failures only when the graph is wired', async () => {
    const serviceDeps = new Map<string, string[]>([
      ['authelia', []], ['immich', ['authelia']],
    ]);
    NotificationBatcher.setRootCauseResolution({
      serviceDeps,
      hosts: [{ domain: 'photos.dopp.cloud', service: 'immich', forwardPort: 1, created: true }],
    });
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    // Whole cascade fails at boot: gateway + Authelia + the photos domain.
    NotificationBatcher.enqueue('fail', gateway, result('fail'));
    NotificationBatcher.enqueue('fail', svc('authelia'), result('fail'));
    NotificationBatcher.enqueue('fail', domain('domain:photos', 'photos.dopp.cloud'), result('fail'));
    await NotificationBatcher.flush('manual');
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const body = sendEmailAlertMock.mock.calls[0][1];
    // Only the gateway (the deepest root) survives; downstream symptoms drop.
    expect(body).toContain('Internet Gateway');
    expect(body).not.toContain('photos.dopp.cloud');
  });

  it('without a wired graph the digest lists every still-failing check (legacy)', async () => {
    NotificationBatcher.start({ maxMs: 10_000, settleMs: 50 });
    NotificationBatcher.enqueue('fail', gateway, result('fail'));
    NotificationBatcher.enqueue('fail', svc('authelia'), result('fail'));
    await NotificationBatcher.flush('manual');
    const body = sendEmailAlertMock.mock.calls[0][1];
    expect(body).toContain('Internet Gateway');
    expect(body).toContain('Service: authelia');
  });
});

describe('NotificationBatcher restart/update digest (#1653)', () => {
  const baseRestart = {
    currentVersion: '4.94.0',
    previousVersion: '4.93.1',
    versionChanged: true,
    bootAt: Date.now() - 192_000, // ~3m12s ago
    lastSeenAt: Date.now() - 192_000,
    changelog: ['**health:** per-type failureThreshold before alerting'],
  };

  it('subject leads with the version change and lists still-failing checks', async () => {
    NotificationBatcher._setRestartContextForTesting({ ...baseRestart });
    NotificationBatcher.start({ maxMs: 60_000, settleMs: 1000 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('fail', check('adguard'), result('fail'));
    await NotificationBatcher.flush('manual');
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toContain('updated to v4.94.0');
    expect(subject).toMatch(/2 checks still failing \(nginx, adguard\)/);
    expect(body).toContain('Updated to v4.94.0 (was v4.93.1)');
    expect(body).toMatch(/Recovered in \d/);
    expect(body).toContain('per-type failureThreshold');
  });

  it('sends on a version change even when nothing is still failing', async () => {
    NotificationBatcher._setRestartContextForTesting({ ...baseRestart });
    NotificationBatcher.start({ maxMs: 60_000, settleMs: 1000 });
    // Everything came back cleanly — but the version changed, so we still
    // tell the operator "we updated".
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('nginx'), result('ok'));
    await NotificationBatcher.flush('manual');
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toContain('updated to v4.94.0');
    expect(body).toContain('All health checks recovered cleanly');
  });

  it('stays silent on a plain no-version-change clean restart', async () => {
    NotificationBatcher._setRestartContextForTesting({
      ...baseRestart,
      previousVersion: '4.94.0',
      versionChanged: false,
      changelog: [],
    });
    NotificationBatcher.start({ maxMs: 60_000, settleMs: 1000 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    NotificationBatcher.enqueue('recovery', check('nginx'), result('ok'));
    await NotificationBatcher.flush('manual');
    expect(sendEmailAlertMock).not.toHaveBeenCalled();
  });

  it('sends on remaining failure even with no version change', async () => {
    NotificationBatcher._setRestartContextForTesting({
      ...baseRestart,
      previousVersion: '4.94.0',
      versionChanged: false,
      changelog: [],
    });
    NotificationBatcher.start({ maxMs: 60_000, settleMs: 1000 });
    NotificationBatcher.enqueue('fail', check('nginx'), result('fail'));
    await NotificationBatcher.flush('manual');
    expect(sendEmailAlertMock).toHaveBeenCalledTimes(1);
    const [subject, body] = sendEmailAlertMock.mock.calls[0];
    expect(subject).toContain('1 check still failing');
    expect(body).toContain('no version change');
  });
});
