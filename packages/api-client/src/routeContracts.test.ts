/**
 * Wire contract for the api-client methods that replaced `app/actions/*`
 * (#2745).
 *
 * The server actions had no observable wire — a caller and its test could only
 * agree on a function name. These methods are the client half of a real HTTP
 * contract, so what matters is exactly this: the verb, the URL, the JSON body,
 * and that the `withApiHandler` envelope is unwrapped and validated. The server
 * half is pinned by the route tests under
 * `packages/frontend/src/app/api/system/`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchNodes,
  createNode,
  editNode,
  deleteNode,
  setNodeAsDefault,
  checkConnection,
  checkFullConnection,
  installSSHKey,
  generateLocalKey,
  getSystemUpdates,
  checkOnboardingStatus,
  saveGatewayConfig,
  savePublicDomainConfig,
  saveAutoUpdateConfig,
  saveRegistriesConfig,
  saveEmailConfig,
  skipOnboarding,
  completeStackSetup,
  forceClearInstallLock,
  TypedFetchError,
} from './index';

let seen: { url: string; method: string; body: unknown };

/** Fresh Response per call — never hand the same one to two awaits. */
function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const ok = (data: unknown) => ({ ok: true, data });
const ACK = ok({ success: true });
const NODE = { Name: 'box', URI: 'ssh://core@host', Identity: '/k', Default: true };

const STATUS = {
  needsSetup: true,
  stackSetupPending: false,
  hasGateway: false,
  hasSshKey: true,
  hasExternalLinks: false,
  installInProgress: null,
  features: { gateway: false, ssh: true, updates: false, registries: false, email: false, auth: true },
};

const EMAIL = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'u',
  pass: 'p',
  from: 'a@example.com',
  recipients: 'b@example.com, c@example.com',
};

beforeEach(() => {
  seen = { url: '', method: '', body: undefined };
});
afterEach(() => vi.unstubAllGlobals());

describe('node methods', () => {
  it.each([
    ['GET', '/api/system/nodes', undefined, () => fetchNodes(), ok([NODE])],
    [
      'POST',
      '/api/system/nodes',
      { name: 'n', destination: 'ssh://h', identity: '/k' },
      () => createNode('n', 'ssh://h', '/k'),
      ACK,
    ],
    [
      'PATCH',
      '/api/system/nodes/old',
      { name: 'new', destination: 'ssh://h', identity: '/k' },
      () => editNode('old', 'new', 'ssh://h', '/k'),
      ACK,
    ],
    ['DELETE', '/api/system/nodes/box', undefined, () => deleteNode('box'), ACK],
    ['POST', '/api/system/nodes/box/default', undefined, () => setNodeAsDefault('box'), ACK],
  ])('%s %s', async (method, url, body, call, payload) => {
    stubFetch(payload);
    await call();
    expect(seen.method).toBe(method);
    expect(seen.url).toBe(url);
    expect(seen.body).toEqual(body);
  });

  it('percent-encodes a node name so a slash cannot forge a path segment', async () => {
    stubFetch(ACK);
    await deleteNode('a/b');
    expect(seen.url).toBe('/api/system/nodes/a%2Fb');
  });

  it('unwraps the withApiHandler envelope', async () => {
    stubFetch(ok([NODE]));
    await expect(fetchNodes()).resolves.toEqual([NODE]);
  });
});

describe('ssh methods', () => {
  it.each([
    [
      '/api/system/ssh/check',
      { host: 'h', port: 22 },
      () => checkConnection('h', 22),
      ok({ success: true, isOpen: true }),
    ],
    [
      '/api/system/ssh/verify',
      { host: 'h', port: 22, user: 'u', identity: '/k' },
      () => checkFullConnection('h', 22, 'u', '/k'),
      ok({ success: false, stage: 'auth', error: 'nope' }),
    ],
    [
      '/api/system/ssh/install-key',
      { host: 'h', port: 22, user: 'u', pass: 's3cret' },
      () => installSSHKey('h', 22, 'u', 's3cret'),
      ok({ success: true, logs: ['done'] }),
    ],
    ['/api/system/ssh/key', undefined, () => generateLocalKey(), ok({ success: true, message: 'Key generated' })],
  ])('POST %s', async (url, body, call, payload) => {
    stubFetch(payload);
    await call();
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe(url);
    expect(seen.body).toEqual(body);
  });

  it('keeps the auth stage so the caller can offer key installation', async () => {
    stubFetch(ok({ success: false, stage: 'auth', error: 'SSH Authentication Failed' }));
    await expect(checkFullConnection('h', 22, 'u', '/k')).resolves.toMatchObject({ stage: 'auth' });
  });
});

describe('onboarding + system methods', () => {
  it('GET /api/system/onboarding returns the parsed status', async () => {
    stubFetch(ok(STATUS));
    await expect(checkOnboardingStatus()).resolves.toEqual(STATUS);
    expect(seen.method).toBe('GET');
  });

  it.each([
    [{ section: 'gateway', host: 'fritz.box', username: 'u', password: 'p' }, () => saveGatewayConfig('fritz.box', 'u', 'p')],
    [{ section: 'publicDomain', publicDomain: 'example.com' }, () => savePublicDomainConfig('example.com')],
    [{ section: 'autoUpdate', enabled: true }, () => saveAutoUpdateConfig(true)],
    [{ section: 'registries', enabled: false }, () => saveRegistriesConfig(false)],
    [{ section: 'email', email: EMAIL }, () => saveEmailConfig(EMAIL)],
  ])('POST /api/system/onboarding/config carries section %o', async (body, call) => {
    stubFetch(ACK);
    await call();
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/system/onboarding/config');
    expect(seen.body).toEqual(body);
  });

  it.each([
    ['setup', () => skipOnboarding()],
    ['stack', () => completeStackSetup()],
  ])('POST /api/system/onboarding/complete with target %s', async (target, call) => {
    stubFetch(ACK);
    await call();
    expect(seen.url).toBe('/api/system/onboarding/complete');
    expect(seen.body).toEqual({ target });
  });

  it('DELETE /api/system/onboarding/install-lock clears a wedged install', async () => {
    stubFetch(ACK);
    await forceClearInstallLock();
    expect(seen.method).toBe('DELETE');
    expect(seen.url).toBe('/api/system/onboarding/install-lock');
  });

  it('GET /api/system/os-updates passes the node through as a query param', async () => {
    stubFetch(ok({ count: 2, list: ['a', 'b'] }));
    await expect(getSystemUpdates('Local')).resolves.toEqual({ count: 2, list: ['a', 'b'] });
    expect(seen.url).toBe('/api/system/os-updates?node=Local');

    stubFetch(ok({ count: 0, list: [] }));
    await getSystemUpdates();
    expect(seen.url).toBe('/api/system/os-updates');
  });
});

describe('failure surfaces', () => {
  it('raises the server-authored message from an error envelope', async () => {
    stubFetch({ ok: false, error: 'validation failed', code: 'VALIDATION' }, 400);
    await expect(createNode('n', 'ssh://h', '/k')).rejects.toThrow(/validation failed/);
  });

  it('rejects a payload that does not match the contract', async () => {
    stubFetch(ok([{ Name: 'box' }]));
    await expect(fetchNodes()).rejects.toBeInstanceOf(TypedFetchError);
  });
});
