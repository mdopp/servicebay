import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolServer } from './context';

/**
 * #2654 — a proxy-route mutation reconciles the auto-managed `domain:<host>`
 * health checks immediately. Before this, `syncDomainChecks` ran only at boot
 * and on a 60s `setInterval`, so for up to a minute after a route change
 * `get_health_checks` answered from a route table the caller had already
 * changed — and `delete_health_check` on the id it listed answered
 * "No check with id … found".
 *
 * The chosen fix is the reconcile TRIGGER (remove the stale state), not a
 * tolerant delete: an idempotent delete would leave the list advertising a dead
 * route's check, and making delete succeed on any absent id would make it
 * disagree with `run_check_now`, which must still reject a nonexistent id.
 */

const calls = vi.hoisted(() => ({
  sync: [] as ({ removedDomains?: string[] } | undefined)[],
  config: { reverseProxy: { hosts: [] as { domain: string; forwardPort: number }[] } },
  updated: [] as unknown[],
  fetches: [] as { path: string; method?: string }[],
  deleteStatus: 200,
  deleteBody: {} as Record<string, unknown>,
}));

vi.mock('@/lib/health/domainChecks', () => ({
  syncDomainChecks: async (opts?: { removedDomains?: string[] }) => { calls.sync.push(opts); },
}));
vi.mock('@/lib/store/repository', () => ({ getStoreSnapshot: () => ({ proxyState: { routes: [] } }) }));
vi.mock('@/lib/config', () => ({
  getConfig: async () => calls.config,
  updateConfig: async (patch: unknown) => { calls.updated.push(patch); },
}));
vi.mock('@/lib/auth/internalToken', () => ({ getInternalApiToken: () => 't' }));
vi.mock('@/lib/stackInstall/forwardAuth', () => ({ AUTHELIA_FORWARD_AUTH_SENTINEL: '#auth' }));

interface CapturedTool {
  handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}
const tools = new Map<string, CapturedTool>();
const stubServer: ToolServer = {
  tool(name: string, _description: string, _schema: unknown, handler: CapturedTool['handler']) {
    tools.set(name, { handler });
    return undefined;
  },
};

beforeEach(async () => {
  tools.clear();
  calls.sync = [];
  calls.updated = [];
  calls.fetches = [];
  calls.config = { reverseProxy: { hosts: [{ domain: 'gone.dopp.cloud', forwardPort: 1 }] } };
  calls.deleteStatus = 200;
  calls.deleteBody = { removed: true };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.fetches.push({ path: String(url), method: init?.method });
    return {
      ok: calls.deleteStatus < 400,
      status: calls.deleteStatus,
      json: async () => calls.deleteBody,
    } as unknown as Response;
  });
  const { registerProxyTools } = await import('./proxyTools');
  registerProxyTools({ server: stubServer });
});

const call = async (name: string, args: unknown) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler(args);
};

describe('proxy-route mutations reconcile the domain checks (#2654)', () => {
  it('registers no add_proxy_route — creation has ONE kernel path (#2726)', () => {
    expect(tools.has('create_proxy_route')).toBe(true);
    expect(tools.has('add_proxy_route')).toBe(false);
  });


  it('create_proxy_route delegates the reconcile to the POST endpoint (#2726)', async () => {
    // #2726 removed `add_proxy_route`, so route creation has exactly one path:
    // POST /api/system/nginx/proxy-hosts, which reconciles in route.ts. The tool
    // must NOT reconcile a second time here, and must not write config itself.
    calls.deleteBody = { created: ['new.dopp.cloud'], failed: [], certs: [] };
    await call('create_proxy_route', { domain: 'new.dopp.cloud', forwardPort: 8080, exposure: 'public' });
    expect(calls.fetches.some(f => f.method === 'POST')).toBe(true);
    expect(calls.updated).toEqual([]);
    expect(calls.sync).toEqual([]);
  });

  it('remove_proxy_route (config-only) reconciles WITHOUT claiming a removal', async () => {
    // The live NPM host still exists, so the check legitimately stays — it just
    // has to be rebuilt from the route now that the config entry is gone.
    await call('remove_proxy_route', { domain: 'gone.dopp.cloud', removeNpmHost: false });
    expect(calls.sync).toHaveLength(1);
    expect(calls.sync[0]?.removedDomains).toBeUndefined();
  });

  it('remove_proxy_route retires the check when NPM has no such host', async () => {
    calls.deleteStatus = 404;
    calls.deleteBody = { reason: 'not_found' };
    await call('remove_proxy_route', { domain: 'gone.dopp.cloud', removeNpmHost: true });
    // The DELETE endpoint bailed before its own reconcile, so the tool does it,
    // and it must name the domain — the polled route table has not caught up.
    expect(calls.sync).toEqual([{ removedDomains: ['gone.dopp.cloud'] }]);
  });

  it('a successful live removal delegates the reconcile to the DELETE endpoint', async () => {
    await call('remove_proxy_route', { domain: 'gone.dopp.cloud', removeNpmHost: true });
    expect(calls.fetches.some(f => f.method === 'DELETE')).toBe(true);
    // No double reconcile here: /api/system/nginx/proxy-hosts DELETE is the one
    // path every live removal takes and it reconciles there (route.ts).
    expect(calls.sync).toEqual([]);
  });
});
