/**
 * `rekey_admin` action — the non-destructive NPM admin re-key
 * (credential-reconciliation increment 2). Generates a fresh password,
 * rewrites NPM's bcrypt hash in place (proxy routes preserved), verifies
 * it, and persists it. The mechanic was validated live before shipping;
 * these tests pin the orchestration + failure handling.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  services: [{ name: 'nginx-web', active: true, ports: [{ host: '81', container: '81' }] }] as any[],
  exec: vi.fn(),
  updated: undefined as any,
  fetchStatus: 200,
};

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(async () => ({ sendCommand: (...a: any[]) => state.exec(...a) })) },
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(async () => state.services) },
}));
vi.mock('@/lib/config', () => ({
  updateConfig: vi.fn(async (patch: any) => { state.updated = patch; }),
}));
vi.mock('@/lib/health/store', () => ({ HealthStore: { getLastResult: () => null, getChecks: () => [] } }));

const fetchMock = vi.fn(async () => ({ ok: state.fetchStatus < 400, status: state.fetchStatus } as Response));
vi.stubGlobal('fetch', fetchMock);

import { dispatchProbeAction } from '../actions';
import { updateConfig } from '@/lib/config';
import './npmDataStale';

// First exec call = locate container; second = the bcrypt rewrite.
function wireExec(rewriteOut: string, rewriteCode = 0) {
  state.exec.mockReset();
  state.exec
    .mockResolvedValueOnce({ code: 0, stdout: 'nginx-nginx-proxy-manager docker.io/jc21/nginx-proxy-manager:latest\n', stderr: '' })
    .mockResolvedValueOnce({ code: rewriteCode, stdout: rewriteOut, stderr: '' });
}

beforeEach(() => {
  state.services = [{ name: 'nginx-web', active: true, ports: [{ host: '81', container: '81' }] }];
  state.updated = undefined;
  state.fetchStatus = 200;
  fetchMock.mockClear();
  (updateConfig as any).mockClear?.();
});

const run = () => dispatchProbeAction({ probeId: 'npm_data_stale', actionId: 'rekey_admin', node: 'Local' });

describe('rekey_admin (NPM admin auto re-key)', () => {
  it('rewrites the hash, verifies, and persists the fresh password (no wipe)', async () => {
    wireExec('email=mdopp79@gmail.com;updated=1');
    const res = await run();
    expect(res.ok).toBe(true);
    // Persisted under reverseProxy.npm with the DB's authoritative email + a fresh 32-char secret.
    expect(state.updated?.reverseProxy?.npm?.email).toBe('mdopp79@gmail.com');
    expect((state.updated?.reverseProxy?.npm?.password || '').length).toBe(32);
    // Verified against NPM before persisting.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does NOT persist if NPM rejects the freshly-set password (401)', async () => {
    wireExec('email=a@b.c;updated=1');
    state.fetchStatus = 401;
    const res = await run();
    expect(res.ok).toBe(false);
    expect(state.updated).toBeUndefined();
  });

  it('fails cleanly when there is no admin row to re-key', async () => {
    wireExec('noadmin');
    const res = await run();
    expect(res.ok).toBe(false);
    expect(state.updated).toBeUndefined();
  });
});
