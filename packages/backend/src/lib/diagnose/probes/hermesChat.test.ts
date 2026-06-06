/**
 * `hermes_chat` probe (#1761) — verifies it distinguishes an API-KEY
 * MISMATCH (Hermes 401 → fail + reconcile action) from a genuine outage
 * (transport error → warn, no false "key mismatch" claim), and skips when
 * hermes isn't installed. Also checks the reconcile heal-action is registered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  configuredRef: { value: true },
  reconcile: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));
vi.mock('@/lib/hermes/client', () => {
  class FakeHermesError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    HermesError: FakeHermesError,
    resolveHermesConnection: vi.fn(() => ({ baseUrl: 'http://127.0.0.1:8642', apiKey: 'k' })),
    HermesClient: class {
      get configured() {
        return mocks.configuredRef.value;
      }
      listSessions = mocks.listSessions;
    },
  };
});
vi.mock('@/lib/hermes/reconcileHermesApiKey', () => ({
  reconcileHermesApiKey: mocks.reconcile,
}));

import { checkHermesChat } from './hermesChat';
import { getConfig } from '@/lib/config';
import { HermesError } from '@/lib/hermes/client';
import { actionsForProbe, dispatchProbeAction } from '../actions';

describe('checkHermesChat (#1761)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configuredRef.value = true;
    vi.mocked(getConfig).mockResolvedValue({ installedTemplates: { hermes: {} } } as never);
  });

  it('skips (info) when hermes is not installed', async () => {
    vi.mocked(getConfig).mockResolvedValue({ installedTemplates: {} } as never);
    const r = await checkHermesChat();
    expect(r.status).toBe('info');
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it('is ok when Hermes is reachable and authenticates', async () => {
    mocks.listSessions.mockResolvedValue([]);
    const r = await checkHermesChat();
    expect(r.status).toBe('ok');
  });

  it('fails with a DISTINCT key-mismatch detail on a Hermes 401', async () => {
    mocks.listSessions.mockRejectedValue(new HermesError('Hermes returned 401', 401));
    const r = await checkHermesChat();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/drifted|401/i);
    expect(r.hint).toMatch(/reconcile/i);
  });

  it('warns (not fail, no key-mismatch claim) on a genuine outage', async () => {
    mocks.listSessions.mockRejectedValue(new HermesError('Hermes is unreachable'));
    const r = await checkHermesChat();
    expect(r.status).toBe('warn');
    expect(r.detail).not.toMatch(/drifted/i);
    expect(r.hint).toMatch(/connectivity/i);
  });

  it('warns when installed but no key is stored yet', async () => {
    mocks.configuredRef.value = false;
    const r = await checkHermesChat();
    expect(r.status).toBe('warn');
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });
});

describe('reconcile_hermes_api_key heal-action (#1761)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is registered on the hermes_chat probe', () => {
    const ids = actionsForProbe('hermes_chat').map(a => a.id);
    expect(ids).toContain('reconcile_hermes_api_key');
  });

  it('dispatches the reconcile and reports the changed outcome', async () => {
    mocks.reconcile.mockResolvedValue({ outcome: 'changed', message: 'Adopted the key.' });
    const res = await dispatchProbeAction({
      probeId: 'hermes_chat',
      actionId: 'reconcile_hermes_api_key',
      node: 'Local',
    });
    expect(res.ok).toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledWith('Local');
  });

  it('reports a failed outcome (not-found) as ok:false', async () => {
    mocks.reconcile.mockResolvedValue({ outcome: 'not-found', message: 'no key' });
    const res = await dispatchProbeAction({
      probeId: 'hermes_chat',
      actionId: 'reconcile_hermes_api_key',
      node: 'Local',
    });
    expect(res.ok).toBe(false);
  });
});
