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
  kernel: [] as string[],
  removeResult: { kind: 'removed' } as Record<string, unknown>,
  provisionResult: { kind: 'ok' } as Record<string, unknown>,
}));

vi.mock('@/lib/health/domainChecks', () => ({
  syncDomainChecks: async (opts?: { removedDomains?: string[] }) => { calls.sync.push(opts); },
}));
vi.mock('@/lib/store/repository', () => ({ getStoreSnapshot: () => ({ proxyState: { routes: [] } }) }));
vi.mock('@/lib/config', () => ({
  getConfig: async () => calls.config,
  updateConfig: async (patch: unknown) => { calls.updated.push(patch); },
}));
vi.mock('@/lib/stackInstall/forwardAuth', () => ({ AUTHELIA_FORWARD_AUTH_SENTINEL: '#auth' }));
// #2731 — the tools call the provisioning kernel directly (no loopback HTTP);
// the kernel owns the reconcile on its own success paths.
vi.mock('@/lib/reverseProxy/proxyHostProvisioning', () => ({
  provisionProxyHosts: async () => { calls.kernel.push('provision'); return calls.provisionResult; },
  removeProxyHost: async () => { calls.kernel.push('remove'); return calls.removeResult; },
  listLiveProxyHosts: async () => ({ kind: 'ok', node: 'box', hosts: [] }),
}));

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
  calls.kernel = [];
  calls.config = { reverseProxy: { hosts: [{ domain: 'gone.dopp.cloud', forwardPort: 1 }] } };
  calls.removeResult = { kind: 'removed', domain: 'gone.dopp.cloud', id: 1 };
  calls.provisionResult = { kind: 'ok', success: true, created: [], failed: [], certs: [], lanRestricted: [], nginxOffline: [], adminUrl: 'http://npm', node: 'box' };
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


  it('create_proxy_route delegates the reconcile to the provisioning kernel (#2726)', async () => {
    // #2726 removed `add_proxy_route`, so route creation has exactly one path:
    // `provisionProxyHosts` (the same kernel POST /api/system/nginx/proxy-hosts
    // is a thin handler over), which reconciles itself. The tool must NOT
    // reconcile a second time here, and must not write config itself.
    calls.provisionResult = { ...calls.provisionResult, created: ['new.dopp.cloud'] };
    await call('create_proxy_route', { domain: 'new.dopp.cloud', forwardPort: 8080, exposure: 'public' });
    expect(calls.kernel).toEqual(['provision']);
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
    calls.removeResult = { kind: 'not-found' };
    await call('remove_proxy_route', { domain: 'gone.dopp.cloud', removeNpmHost: true });
    // The kernel bailed before its own reconcile, so the tool does it,
    // and it must name the domain — the polled route table has not caught up.
    expect(calls.sync).toEqual([{ removedDomains: ['gone.dopp.cloud'] }]);
  });

  it('a successful live removal delegates the reconcile to the kernel', async () => {
    await call('remove_proxy_route', { domain: 'gone.dopp.cloud', removeNpmHost: true });
    expect(calls.kernel).toEqual(['remove']);
    // No double reconcile here: `removeProxyHost` is the one path every live
    // removal takes and it reconciles there (proxyHostProvisioning.ts).
    expect(calls.sync).toEqual([]);
  });
});
