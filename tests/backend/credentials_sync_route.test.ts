/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `/api/system/credentials` + `/sync` (#2519).
 *
 * Two things worth pinning at the HTTP boundary:
 *  - the push status the UI reads never carries the vault account's
 *    master password (it is the one new secret this feature introduces);
 *  - a failed push is a 200 with `ok: false`, not an exception — the
 *    entries stay unsecured and the reason travels to the UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const state: { config: any } = { config: {} };
const syncMock = vi.fn(async () => ({ ok: true, attempted: 1, secured: 1, at: '2026-08-13T12:00:00.000Z' }));

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

vi.mock('@/lib/vaultwarden/sync', async () => {
  const actual = await vi.importActual<any>('@/lib/vaultwarden/sync');
  return { ...actual, syncCredentialsToVault: (...args: any[]) => syncMock(...(args as [])) };
});

import { GET, vaultStatus } from '@/app/api/system/credentials/route';
import { POST as SYNC } from '@/app/api/system/credentials/sync/route';
import { POST as SAVE_VAULT, DELETE as FORGET_VAULT } from '@/app/api/system/credentials/vault/route';

const VAULT = {
  accountEmail: 'servicebay@dopp.cloud',
  password: 'the-vault-account-master-password',
  organizationId: 'org-1',
  collectionId: 'col-1',
};

const manifest = (extra: Record<string, unknown> = {}) => ({
  savedAt: '2026-08-12T08:00:00.000Z',
  credentials: [{
    service: 'Immich', url: 'https://photos.example', username: 'admin',
    password: 'plaintext-secret', importance: 'critical', template: 'immich', ...extra,
  }],
});

beforeEach(() => {
  state.config = {};
  syncMock.mockClear();
  syncMock.mockResolvedValue({ ok: true, attempted: 1, secured: 1, at: '2026-08-13T12:00:00.000Z' });
});

describe('GET /api/system/credentials — push status', () => {
  it('never returns the vault account password', async () => {
    state.config = {
      installManifest: manifest(),
      installedTemplates: { vaultwarden: { schemaVersion: 1, installedAt: 'x' } },
      credentialVault: VAULT,
    };
    const res = await GET(new NextRequest('http://test/api/system/credentials'));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('the-vault-account-master-password');
    expect(body.vault).toEqual({ installed: true, configured: true, account: 'servicebay@dopp.cloud', lastSync: null });
  });

  it('reports "not configured" when the vault account is incomplete', () => {
    expect(vaultStatus({ credentialVault: { ...VAULT, collectionId: '' } } as any))
      .toMatchObject({ configured: false });
    expect(vaultStatus({} as any)).toEqual({ installed: false, configured: false, account: null, lastSync: null });
  });

  it('surfaces the recorded failure of the last push', async () => {
    state.config = {
      installManifest: manifest(),
      installedTemplates: { vaultwarden: { schemaVersion: 1, installedAt: 'x' } },
      credentialVault: { ...VAULT, lastSync: { at: '2026-08-13T12:00:00.000Z', ok: false, reason: 'unreachable', message: 'connect ECONNREFUSED' } },
    };
    const res = await GET(new NextRequest('http://test/api/system/credentials'));
    const body = await res.json();
    expect(body.vault.lastSync).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('POST /api/system/credentials/sync', () => {
  const post = () => SYNC(new NextRequest('http://test/api/system/credentials/sync', { method: 'POST' }));

  it('runs the push and returns the resulting security summary', async () => {
    state.config = { installManifest: manifest({ password: '', securedAt: '2026-08-13T12:00:00.000Z' }) };
    const res = await post();
    const body = await res.json();
    expect(syncMock).toHaveBeenCalledWith({ trigger: 'settings' });
    expect(body).toMatchObject({ ok: true, secured: 1 });
    expect(body.summary).toMatchObject({ total: 1, secured: 1, unsecured: 0 });
  });

  it('reports a failed push as data, not as a 500 — the entries stay unsecured', async () => {
    syncMock.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'connect ECONNREFUSED', attempted: 1, secured: 0, at: 'now' } as any);
    state.config = { installManifest: manifest() };

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, reason: 'unreachable', secured: 0 });
    expect(body.summary).toMatchObject({ unsecured: 1, secured: 0 });
  });
});

describe('POST /api/system/credentials/vault — the one door for the account', () => {
  const save = (body: any) =>
    SAVE_VAULT(new NextRequest('http://test/api/system/credentials/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

  it('stores the account and its master password', async () => {
    const res = await save({ accountEmail: 'servicebay@dopp.cloud', password: 'generated-master-pw', organizationId: 'org-1', collectionId: 'col-1' });
    expect(res.status).toBe(200);
    expect(state.config.credentialVault).toMatchObject({
      accountEmail: 'servicebay@dopp.cloud', password: 'generated-master-pw', organizationId: 'org-1', collectionId: 'col-1',
    });
    // …and it is never echoed back to the caller.
    expect(JSON.stringify(await res.json())).not.toContain('generated-master-pw');
  });

  it('keeps the stored password when the field is left blank', async () => {
    state.config = { credentialVault: { ...VAULT, lastSync: { at: 'then', ok: true } } };
    await save({ accountEmail: VAULT.accountEmail, password: '', organizationId: 'org-2', collectionId: 'col-2' });
    expect(state.config.credentialVault.password).toBe(VAULT.password);
    expect(state.config.credentialVault.organizationId).toBe('org-2');
    // Same account, so the previous verdict is still about this target.
    expect(state.config.credentialVault.lastSync).toMatchObject({ ok: true });
  });

  it('refuses a first save with no password rather than storing a useless account', async () => {
    const res = await save({ accountEmail: 'servicebay@dopp.cloud', organizationId: 'org-1', collectionId: 'col-1' });
    expect(res.status).toBe(400);
    expect(state.config.credentialVault).toBeUndefined();
  });

  it('drops a stale verdict when the account changes', async () => {
    state.config = { credentialVault: { ...VAULT, lastSync: { at: 'then', ok: true } } };
    await save({ accountEmail: 'other@dopp.cloud', password: 'pw', organizationId: 'org-1', collectionId: 'col-1' });
    expect(state.config.credentialVault.lastSync).toBeUndefined();
  });

  it('forgetting the account stops future pushes without un-securing anything', async () => {
    state.config = { credentialVault: VAULT, installManifest: manifest({ password: '', securedAt: 'then' }) };
    const res = await FORGET_VAULT(new NextRequest('http://test/api/system/credentials/vault', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(state.config.credentialVault).toBeUndefined();
    expect(state.config.installManifest.credentials[0].securedAt).toBe('then');
  });
});
