import { describe, it, expect, vi } from 'vitest';
import {
  ensureWildcardRewrite,
  removeWildcardRewrite,
  wildcardForDomain,
  listRewrites,
} from './rewrites';

function mockFetch(handler: (path: string, body: unknown) => { ok: boolean; body?: unknown }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const result = handler(path, body);
    return {
      ok: result.ok,
      json: async () => result.body ?? {},
    } as Response;
  });
}

const opts = (fetchImpl: typeof fetch) => ({
  adminUrl: 'http://localhost:8083',
  username: 'admin',
  password: 'secret',
  fetchImpl,
});

describe('wildcardForDomain', () => {
  it('prepends *. to a bare domain', () => {
    expect(wildcardForDomain('home.arpa')).toBe('*.home.arpa');
  });
  it('strips leading wildcard chars before reapplying', () => {
    expect(wildcardForDomain('*.example.com')).toBe('*.example.com');
    expect(wildcardForDomain('.foo.bar')).toBe('*.foo.bar');
  });
});

describe('listRewrites', () => {
  it('returns the parsed list when AdGuard responds OK', async () => {
    const fetchImpl = mockFetch(() => ({
      ok: true,
      body: [{ domain: '*.home.arpa', answer: '10.0.0.5' }],
    }));
    const rewrites = await listRewrites(opts(fetchImpl as unknown as typeof fetch));
    expect(rewrites).toEqual([{ domain: '*.home.arpa', answer: '10.0.0.5' }]);
  });

  it('returns empty array on non-OK response', async () => {
    const fetchImpl = mockFetch(() => ({ ok: false }));
    expect(await listRewrites(opts(fetchImpl as unknown as typeof fetch))).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await listRewrites(opts(fetchImpl as unknown as typeof fetch))).toEqual([]);
  });
});

describe('ensureWildcardRewrite', () => {
  it("'added' when no matching rule exists", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchImpl = mockFetch((path, body) => {
      calls.push({ path, body });
      if (path === '/control/rewrite/list') return { ok: true, body: [] };
      return { ok: true };
    });
    const result = await ensureWildcardRewrite(
      opts(fetchImpl as unknown as typeof fetch),
      '*.home.arpa',
      '10.0.0.5',
    );
    expect(result).toBe('added');
    expect(calls.find(c => c.path === '/control/rewrite/add')?.body).toEqual({
      domain: '*.home.arpa',
      answer: '10.0.0.5',
    });
  });

  it("'unchanged' when rule already correct", async () => {
    const fetchImpl = mockFetch((path) => {
      if (path === '/control/rewrite/list') {
        return { ok: true, body: [{ domain: '*.home.arpa', answer: '10.0.0.5' }] };
      }
      throw new Error('should not call beyond list');
    });
    const result = await ensureWildcardRewrite(
      opts(fetchImpl as unknown as typeof fetch),
      '*.home.arpa',
      '10.0.0.5',
    );
    expect(result).toBe('unchanged');
  });

  it("'updated' when rule exists with different IP", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchImpl = mockFetch((path, body) => {
      calls.push({ path, body });
      if (path === '/control/rewrite/list') {
        return { ok: true, body: [{ domain: '*.home.arpa', answer: '10.0.0.99' }] };
      }
      return { ok: true };
    });
    const result = await ensureWildcardRewrite(
      opts(fetchImpl as unknown as typeof fetch),
      '*.home.arpa',
      '10.0.0.5',
    );
    expect(result).toBe('updated');
    const updateCall = calls.find(c => c.path === '/control/rewrite/update');
    expect(updateCall?.body).toEqual({
      target: { domain: '*.home.arpa', answer: '10.0.0.99' },
      update: { domain: '*.home.arpa', answer: '10.0.0.5' },
    });
  });

  it("'failed' on add error", async () => {
    const fetchImpl = mockFetch((path) => {
      if (path === '/control/rewrite/list') return { ok: true, body: [] };
      return { ok: false };
    });
    expect(
      await ensureWildcardRewrite(opts(fetchImpl as unknown as typeof fetch), '*.home.arpa', '10.0.0.5'),
    ).toBe('failed');
  });
});

describe('removeWildcardRewrite', () => {
  it("'removed' when rule exists", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchImpl = mockFetch((path, body) => {
      calls.push({ path, body });
      if (path === '/control/rewrite/list') {
        return { ok: true, body: [{ domain: '*.home.arpa', answer: '10.0.0.5' }] };
      }
      return { ok: true };
    });
    expect(
      await removeWildcardRewrite(opts(fetchImpl as unknown as typeof fetch), '*.home.arpa'),
    ).toBe('removed');
    expect(calls.find(c => c.path === '/control/rewrite/delete')?.body).toEqual({
      domain: '*.home.arpa',
      answer: '10.0.0.5',
    });
  });

  it("'absent' when rule doesn't exist", async () => {
    const fetchImpl = mockFetch(() => ({ ok: true, body: [] }));
    expect(
      await removeWildcardRewrite(opts(fetchImpl as unknown as typeof fetch), '*.home.arpa'),
    ).toBe('absent');
  });
});
