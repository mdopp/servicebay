/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `/api/system/credentials/secured` (#2519).
 *
 * The route that ends ServiceBay's role as a second password manager: it
 * records the Vaultwarden hand-off AND deletes the local copy of the
 * secrets in the same write. The invariant worth a test is that those two
 * cannot come apart — a persisted entry is never both "secured" and still
 * carrying a password.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const state: { config: any } = { config: {} };

vi.mock('@/lib/config', async () => {
  const actual = await vi.importActual<any>('@/lib/config');
  return {
    ...actual,
    getConfig: vi.fn(async () => state.config),
    saveConfig: vi.fn(async (cfg: any) => { state.config = cfg; }),
  };
});

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));

import { POST } from '@/app/api/system/credentials/secured/route';

const cred = (service: string, extra: Record<string, unknown> = {}) => ({
  service,
  url: `https://${service}.example`,
  username: 'admin',
  password: 'plaintext-secret',
  importance: 'critical',
  template: service,
  ...extra,
});

const post = () =>
  POST(new NextRequest('http://test/api/system/credentials/secured', { method: 'POST' }));

beforeEach(() => {
  state.config = {};
});

describe('POST /api/system/credentials/secured', () => {
  it('drops every stored password and stamps the hand-off', async () => {
    state.config = {
      installManifest: { savedAt: '2026-08-12T00:00:00.000Z', credentials: [cred('immich'), cred('auth')] },
    };
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secured).toBe(2);

    const saved = state.config.installManifest.credentials;
    expect(saved).toHaveLength(2);
    expect(saved.every((c: any) => c.password === '')).toBe(true);
    expect(saved.every((c: any) => typeof c.securedAt === 'string')).toBe(true);
    // The pointer survives — Settings still lists what exists.
    expect(saved.map((c: any) => c.service).sort()).toEqual(['auth', 'immich']);
    expect(saved[0].username).toBe('admin');
    expect(body.summary).toEqual({ total: 2, secured: 2, unsecured: 0, lastSecuredAt: body.securedAt });
  });

  it('never persists an entry that is secured and still holds a secret', async () => {
    state.config = {
      installManifest: { savedAt: '2026-08-12T00:00:00.000Z', credentials: [cred('immich')] },
    };
    await post();
    const saved = state.config.installManifest.credentials;
    expect(saved.filter((c: any) => c.securedAt && c.password)).toEqual([]);
  });

  it('leaves an already-secured entry and its original timestamp alone', async () => {
    const first = '2026-08-01T00:00:00.000Z';
    state.config = {
      installManifest: {
        savedAt: first,
        credentials: [cred('auth', { password: '', securedAt: first }), cred('immich')],
      },
    };
    const body = await (await post()).json();
    expect(body.secured).toBe(1);
    const saved = state.config.installManifest.credentials;
    expect(saved.find((c: any) => c.service === 'auth').securedAt).toBe(first);
    expect(saved.find((c: any) => c.service === 'immich').securedAt).not.toBe(first);
  });

  it('is idempotent — a second call writes nothing new', async () => {
    state.config = {
      installManifest: { savedAt: '2026-08-12T00:00:00.000Z', credentials: [cred('immich')] },
    };
    await post();
    const afterFirst = JSON.stringify(state.config.installManifest);
    const body = await (await post()).json();
    expect(body.secured).toBe(0);
    expect(JSON.stringify(state.config.installManifest)).toBe(afterFirst);
  });

  it('no-ops on an empty manifest', async () => {
    const body = await (await post()).json();
    expect(body).toMatchObject({ ok: true, secured: 0 });
    expect(state.config.installManifest).toBeUndefined();
  });
});
