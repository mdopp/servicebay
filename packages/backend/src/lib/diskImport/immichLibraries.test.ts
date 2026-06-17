import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/lldap/client', () => ({
  listLldapUsers: vi.fn(),
}));
vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/install/savedSecrets', () => ({ loadSavedSecrets: vi.fn() }));
vi.mock('./reconcileImmichApiKey', () => ({
  IMMICH_ADMIN_API_KEY_VAR: 'IMMICH_ADMIN_API_KEY',
  reconcileImmichApiKey: vi.fn(),
}));

import { listLldapUsers } from '@/lib/lldap/client';
import { getConfig } from '@/lib/config';
import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import { reconcileImmichApiKey } from './reconcileImmichApiKey';
import {
  provisionExternalLibraries,
  scanLibrariesForOwners,
  resolveImmichAdminConfig,
  userImportPath,
  sharedImportPath,
  type ImmichAdminConfig,
} from './immichLibraries';

const CFG: ImmichAdminConfig = { serverUrl: 'http://127.0.0.1:2283', adminApiKey: 'admin-key' };

/** A minimal fetch mock keyed by `METHOD path` → {status, body}. */
function mockFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const path = u.slice(u.indexOf('/', 'http://'.length));
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected fetch ${method} ${path}`);
    return {
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('import path mapping', () => {
  it('maps a box user to <MOUNT>/<user>/photos and shared to <MOUNT>/photos', () => {
    expect(userImportPath('mdopp')).toBe('/mnt/photos/mdopp/photos');
    expect(sharedImportPath()).toBe('/mnt/photos/photos');
  });
});

describe('provisionExternalLibraries', () => {
  it('creates per-user + Shared libraries with one admin key, mapping folders', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [
        { id: 'mdopp', email: 'm@x' },
        { id: 'cdopp', email: 'c@x' },
      ],
    });
    const created: Array<{ ownerId: string; name: string; importPaths: string[] }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const path = u.slice(u.indexOf('/', 7));
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/api/users') {
          return { status: 200, json: async () => [
            { id: 'iu-m', email: 'm@x', name: 'mdopp' },
            { id: 'iu-c', email: 'c@x', name: 'cdopp' },
          ] } as Response;
        }
        if (method === 'GET' && path === '/api/users/me') {
          return { status: 200, json: async () => ({ id: 'admin-id' }) } as Response;
        }
        if (method === 'GET' && path === '/api/libraries') {
          return { status: 200, json: async () => [] } as Response;
        }
        if (method === 'POST' && path === '/api/libraries') {
          const b = JSON.parse(String(init?.body));
          created.push(b);
          return { status: 201, json: async () => ({ id: `lib-${b.name}` }) } as Response;
        }
        throw new Error(`unexpected ${method} ${path}`);
      }),
    );

    const res = await provisionExternalLibraries(CFG);

    expect(res.libraryIdByOwner.get('shared')).toBe('lib-Shared');
    expect(res.libraryIdByOwner.get('mdopp')).toBe('lib-mdopp');
    expect(res.libraryIdByOwner.get('cdopp')).toBe('lib-cdopp');
    expect(res.unmatchedUsers).toEqual([]);

    const shared = created.find(c => c.name === 'Shared')!;
    expect(shared.ownerId).toBe('admin-id');
    expect(shared.importPaths).toEqual(['/mnt/photos/photos']);
    const m = created.find(c => c.name === 'mdopp')!;
    expect(m.ownerId).toBe('iu-m');
    expect(m.importPaths).toEqual(['/mnt/photos/mdopp/photos']);
  });

  it('reuses an existing matching library (idempotent) and flags unmatched users', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'mdopp', email: 'm@x' }, { id: 'ghost', email: 'g@x' }],
    });
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'GET /api/users': { status: 200, body: [{ id: 'iu-m', email: 'm@x', name: 'mdopp' }] },
        'GET /api/users/me': { status: 200, body: { id: 'admin-id' } },
        'GET /api/libraries': {
          status: 200,
          body: [
            { id: 'existing-shared', ownerId: 'admin-id', name: 'Shared', importPaths: ['/mnt/photos/photos'] },
            { id: 'existing-m', ownerId: 'iu-m', name: 'mdopp', importPaths: ['/mnt/photos/mdopp/photos'] },
          ],
        },
      }),
    );

    const res = await provisionExternalLibraries(CFG);
    expect(res.libraryIdByOwner.get('shared')).toBe('existing-shared');
    expect(res.libraryIdByOwner.get('mdopp')).toBe('existing-m');
    expect(res.unmatchedUsers).toEqual(['ghost']); // no Immich account
  });

  it('throws if the box-user directory is unavailable', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({ ok: false, reason: 'unreachable', message: 'down' });
    await expect(provisionExternalLibraries(CFG)).rejects.toThrow(/box users/);
  });
});

describe('scanLibrariesForOwners', () => {
  it('scans each owner library once, dedups, and skips unknown owners', async () => {
    const scanned: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        scanned.push(u.slice(u.indexOf('/api')));
        return { status: 204, json: async () => null } as Response;
      }),
    );
    const map = new Map([['mdopp', 'lib-m'], ['shared', 'lib-s']]);
    await scanLibrariesForOwners(CFG, map, ['mdopp', 'shared', 'mdopp', 'nobody']);
    expect(scanned).toEqual(['/api/libraries/lib-m/scan', '/api/libraries/lib-s/scan']);
  });
});

describe('resolveImmichAdminConfig', () => {
  it('reconciles + returns the stored admin key when present', async () => {
    vi.mocked(reconcileImmichApiKey).mockResolvedValue({ outcome: 'aligned', message: '' });
    vi.mocked(getConfig).mockResolvedValue({} as never);
    vi.mocked(loadSavedSecrets).mockReturnValue({ IMMICH_ADMIN_API_KEY: 'stored-key' });

    const cfg = await resolveImmichAdminConfig('http://127.0.0.1:2283');
    expect(reconcileImmichApiKey).toHaveBeenCalledWith('http://127.0.0.1:2283');
    expect(cfg).toEqual({ serverUrl: 'http://127.0.0.1:2283', adminApiKey: 'stored-key' });
  });

  it('returns null when no key could be stored', async () => {
    vi.mocked(reconcileImmichApiKey).mockResolvedValue({ outcome: 'error', message: '' });
    vi.mocked(getConfig).mockResolvedValue({} as never);
    vi.mocked(loadSavedSecrets).mockReturnValue({});
    expect(await resolveImmichAdminConfig('http://127.0.0.1:2283')).toBeNull();
  });
});
