import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { ToolServer } from './context';

/**
 * #2932 criterion 1, the FIRST of the two independent refusals — the
 * `create_proxy_route` schema itself.
 *
 * The test reads the schema off the tool as it is actually REGISTERED
 * (rather than an exported constant), so moving the validation out of
 * `create_proxy_route` fails here even if the helper survives. The second
 * refusal, inside `buildAuthSkipLocations`, is proved in
 * `lib/stackInstall/authSkipPaths.test.ts`.
 *
 * Why this is a real hole and not a cosmetic one: a `mutate`-scoped token
 * could publish a host that reads as SSO-gated in `get_proxy_routes` and in
 * the UI while every request bypassed Authelia.
 */

vi.mock('@/lib/health/domainChecks', () => ({ syncDomainChecks: async () => {} }));
vi.mock('@/lib/store/repository', () => ({ getStoreSnapshot: () => ({ proxyState: { routes: [] } }) }));
vi.mock('@/lib/config', () => ({
  getConfig: async () => ({ reverseProxy: { hosts: [] } }),
  updateConfig: async () => {},
}));
vi.mock('@/lib/reverseProxy/proxyHostProvisioning', () => ({
  provisionProxyHosts: async () => ({ kind: 'ok' }),
  removeProxyHost: async () => ({ kind: 'removed' }),
  listLiveProxyHosts: async () => ({ kind: 'ok', node: 'box', hosts: [] }),
}));

const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const stubServer: ToolServer = {
  tool(name: string, _description: string, schema: unknown, _handler: unknown) {
    schemas.set(name, schema as Record<string, z.ZodTypeAny>);
    return undefined;
  },
};

beforeEach(async () => {
  schemas.clear();
  const { registerProxyTools } = await import('./proxyTools');
  registerProxyTools({ server: stubServer });
});

/** Parse `authSkipPaths` exactly as the registered tool would. */
const parse = (paths: unknown) => {
  const field = schemas.get('create_proxy_route')?.authSkipPaths;
  if (!field) throw new Error('create_proxy_route has no authSkipPaths field');
  return field.safeParse(paths);
};

describe('create_proxy_route authSkipPaths schema (#2932)', () => {
  it('refuses the bare root — the entry that turns SSO off host-wide', () => {
    const r = parse(['/']);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('covers the whole host');
  });

  it('refuses every other spelling of "the whole host"', () => {
    for (const p of ['//', '///', '/.', '/./', '/..', '/a/..', '/a/../..', ' / ']) {
      expect(parse([p]).success, `${JSON.stringify(p)} must be refused`).toBe(false);
    }
  });

  it('refuses an entry that can terminate or escape its location block', () => {
    for (const p of [
      '/x } location / { auth_request off; include conf.d/include/proxy.conf; }',
      '/x}',
      '/x{',
      '/x;auth_request off;',
      '/x\n}\nauth_request off;',
      '/x#c',
      '/x$uri',
      '/x"y"',
      '/x\\y',
      '/x y',
    ]) {
      expect(parse([p]).success, `${JSON.stringify(p)} must be refused`).toBe(false);
    }
  });

  it('refuses a relative entry and refuses the array if ANY member is hostile', () => {
    expect(parse(['static/']).success).toBe(false);
    expect(parse(['/static/', '/']).success).toBe(false);
    expect(parse(['/static/', '/assets']).success).toBe(true);
  });

  it('still accepts the prefixes the feature exists for (#2210)', () => {
    const r = parse(['/.well-known/', '/.well-known/assetlinks.json', '/static/', '/~user/']);
    expect(r.success).toBe(true);
  });
});
