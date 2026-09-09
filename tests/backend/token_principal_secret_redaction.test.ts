/**
 * Class gate: no HTTP route hands box-derived service files or log text to a
 * **token** principal in the clear (#2943).
 *
 * `GET /api/services/<name>` and `.../logs` carry `tokenScope: 'read'` and used to
 * return `ServiceManager.getServiceFiles` / the journals verbatim, while their MCP
 * twins (`get_service_files`, `get_logs`) had redacted since #321. `read` is the tier
 * `/napi/pair/redeem` hands to any paired companion device for 30 days, so that was a
 * live secret-disclosure path.
 *
 * Two per-route patches would drift the moment a third route is opened to a token
 * principal, so this file is the gate over the whole class rather than over the two
 * routes. It has three layers:
 *
 *  1. **Discovery** — every `route.ts` under the app dir that pulls box-derived text
 *     (`SECRET_SOURCE_MARKERS`) is found on disk and must appear in `DECLARED`. A new
 *     route joining the class fails this suite until someone declares which side of
 *     the line it is on. Nothing joins silently.
 *  2. **Behaviour** — every route `DECLARED` as returning that text is *driven*: the
 *     real handler runs against mocks that emit a canary secret, once as a token
 *     principal (canary must be gone, `<redacted>` must be there) and once as a cookie
 *     operator (canary must survive verbatim). The probe table is keyed off `DECLARED`,
 *     so a newly declared route cannot be added without an assertion.
 *  3. **Exemption discipline** — a route that reads box text but does not return it
 *     (`returnsBoxText: false`) must say why, in writing, at the declaration site. That
 *     half is a reviewed declaration, not a machine proof: whether a handler *emits*
 *     what it read is not decidable from the call alone, so it is asserted by a human
 *     reading one line in this table.
 *
 * Why the class is "token principal" and not "route with `tokenScope`": the token→session
 * bridge (`POST /api/auth/session-from-token`) mints a **cookie** whose `user` is
 * `token:<name>`, and `proxy.ts` applies no scope check to a session cookie. So a `read`
 * token reaches a cookie-only route too, and `cookieScope: 'read'` — not `tokenScope` —
 * is what the container-log routes needed: it makes the principal visible to the handler
 * without opening a Bearer branch.
 *
 * Out of class: `/api/logs/query` (ServiceBay's own structured log store). That text is
 * redacted at the write sink instead — see `journal_env_redaction` /
 * `logdb_env_redaction` — so it never holds a rendered secret to begin with.
 *
 * Every secret in this file is a synthetic canary. No real credential appears here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { REDACTION_SENTINEL } from '@/lib/mcp/redact';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const APP_DIR = path.join(REPO_ROOT, 'packages/frontend/src/app');

/**
 * Calls that pull box-derived text — rendered service files, journals, container
 * logs — into a route handler. Presence of one of these in a `route.ts` puts the
 * module in the class; whether it *returns* what it read is the `DECLARED` question.
 */
const SECRET_SOURCE_MARKERS = [
  'getServiceFiles',
  'getServiceLogs',
  'getPodmanLogs',
  'podman logs',
  'journalctl',
];

interface Declaration {
  /** Does this route hand the box-derived text back to the caller? */
  returnsBoxText: boolean;
  /** Why — read at review time, so it has to actually say something. */
  reason: string;
}

const DECLARED: Record<string, Declaration> = {
  'api/services/[name]/route.ts': {
    returnsBoxText: true,
    reason: 'GET returns getServiceFiles — the rendered pod spec / Quadlet unit, secrets inline.',
  },
  'api/services/[name]/logs/route.ts': {
    returnsBoxText: true,
    reason: 'GET returns the service journal and the podman log, both of which catch first-run password dumps.',
  },
  'api/containers/[id]/logs/route.ts': {
    returnsBoxText: true,
    reason: 'GET returns `podman logs` stdout for one container.',
  },
  'api/containers/[id]/logs/stream/route.ts': {
    returnsBoxText: true,
    reason: 'GET returns the same `podman logs` stdout as a plain-text body.',
  },
  'api/services/[name]/action-stream/route.ts': {
    returnsBoxText: false,
    reason: 'Destructures `yamlPath` only — a path, never the file body; the parsed YAML is walked for image refs and the images are what it streams.',
  },
  'api/system/authelia/oidc-clients/route.ts': {
    returnsBoxText: false,
    reason: 'Reads the auth pod spec to locate Authelia\'s config hostPath; the response is the added/skipped client-id summary, never the manifest.',
  },
  'api/system/authelia/oidc-clients/[client_id]/route.ts': {
    returnsBoxText: false,
    reason: 'Same hostPath lookup as its parent route; responds with the client record it edited, never the manifest it read.',
  },
};

/** Every `route.ts` under the app dir, as an app-relative posix path. */
function allRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allRouteFiles(full, acc);
    else if (entry.name === 'route.ts') acc.push(path.relative(APP_DIR, full).split(path.sep).join('/'));
  }
  return acc;
}

const discovered = allRouteFiles(APP_DIR)
  .filter(rel => {
    const source = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
    return SECRET_SOURCE_MARKERS.some(marker => source.includes(marker));
  })
  .sort();

// ---------------------------------------------------------------------------
// Mocks. Every box read hands back a canary; the principal is swapped per case.
// ---------------------------------------------------------------------------

/** Obvious placeholders. A grep for either must only ever hit this file. */
const FILE_CANARY = 'CANARY-service-file-value-not-a-real-secret';
const LOG_CANARY = 'CANARY-log-line-value-not-a-real-secret';

const KUBE_CONTENT = [
  '[Container]',
  'Image=docker.io/example/app:1',
  `Environment=ADMIN_PASSWORD=${FILE_CANARY}`,
  '',
].join('\n');

const YAML_CONTENT = [
  'apiVersion: v1',
  'kind: Pod',
  'spec:',
  '  containers:',
  '    - name: app',
  '      env:',
  '        - name: SHARE_PASSWORD',
  `          value: "${FILE_CANARY}"`,
  '',
].join('\n');

const LOG_TEXT = [
  'level=info msg="starting"',
  `Admin password: ${LOG_CANARY}`,
  '',
].join('\n');

const state: { principal: string } = { principal: 'operator' };

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({
    user: state.principal,
    expires: new Date(Date.now() + 60_000),
  })),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), queryLogs: vi.fn(() => []) },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({ externalLinks: [], gateway: undefined })),
  saveConfig: vi.fn(async () => {}),
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: () => [], deleteCheck: vi.fn(), saveCheck: vi.fn() },
}));

vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(async () => []) }));
vi.mock('@/lib/manager', () => ({ getPodmanPs: vi.fn(async () => []) }));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    getServiceFiles: vi.fn(async () => ({
      kubeContent: KUBE_CONTENT,
      yamlContent: YAML_CONTENT,
      serviceContent: '',
      yamlPath: '/etc/containers/systemd/demo.yml',
    })),
    getServiceLogs: vi.fn(async () => LOG_TEXT),
    getPodmanLogs: vi.fn(async () => LOG_TEXT),
  },
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    getAgent: vi.fn(() => ({
      sendCommand: vi.fn(async () => ({ code: 0, stdout: LOG_TEXT, stderr: '' })),
    })),
  },
}));

type RouteHandler = (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface Probe {
  /** Which canary this route's mocked source emits. */
  canary: string;
  url: string;
  params: Record<string, string>;
  load: () => Promise<RouteHandler>;
}

/**
 * One probe per route DECLARED as returning box text. Keyed by the same path, so
 * layer 2 below can assert the two tables line up — a route cannot be declared as
 * returning secrets without something here that actually drives it.
 */
const PROBES: Record<string, Probe> = {
  'api/services/[name]/route.ts': {
    canary: FILE_CANARY,
    url: 'http://test/api/services/demo',
    params: { name: 'demo' },
    load: async () => (await import('@/app/api/services/[name]/route')).GET as RouteHandler,
  },
  'api/services/[name]/logs/route.ts': {
    canary: LOG_CANARY,
    url: 'http://test/api/services/demo/logs',
    params: { name: 'demo' },
    load: async () => (await import('@/app/api/services/[name]/logs/route')).GET as RouteHandler,
  },
  'api/containers/[id]/logs/route.ts': {
    canary: LOG_CANARY,
    url: 'http://test/api/containers/demo-app/logs',
    params: { id: 'demo-app' },
    load: async () => (await import('@/app/api/containers/[id]/logs/route')).GET as RouteHandler,
  },
  'api/containers/[id]/logs/stream/route.ts': {
    canary: LOG_CANARY,
    url: 'http://test/api/containers/demo-app/logs/stream',
    params: { id: 'demo-app' },
    load: async () => (await import('@/app/api/containers/[id]/logs/stream/route')).GET as RouteHandler,
  },
};

const bodyFor = async (probe: Probe, principal: string): Promise<string> => {
  state.principal = principal;
  const handler = await probe.load();
  const res = await handler(new NextRequest(probe.url), { params: Promise.resolve(probe.params) });
  expect(res.status).toBe(200);
  return res.text();
};

beforeEach(() => {
  state.principal = 'operator';
});

describe('token-principal secret redaction — the class', () => {
  it('every route that reads box-derived text is declared', () => {
    // A new route that calls getServiceFiles / getServiceLogs / getPodmanLogs, or
    // shells out to `podman logs` / `journalctl`, lands here. Declare it in
    // DECLARED: `returnsBoxText: true` (then add a probe below) or `false` with the
    // reason it never emits what it read.
    expect(discovered).toEqual(Object.keys(DECLARED).sort());
  });

  it('every route declared as returning box text has a probe that drives it', () => {
    const declaredReturning = Object.entries(DECLARED)
      .filter(([, d]) => d.returnsBoxText)
      .map(([route]) => route)
      .sort();
    expect(Object.keys(PROBES).sort()).toEqual(declaredReturning);
  });

  it('every exempt route says in writing why it never emits what it read', () => {
    for (const [route, decl] of Object.entries(DECLARED)) {
      if (decl.returnsBoxText) continue;
      expect(decl.reason.length, `${route} needs a real exemption reason`).toBeGreaterThan(40);
    }
  });
});

describe.each(Object.keys(PROBES))('%s', route => {
  const probe = PROBES[route];

  it('redacts for a token principal', async () => {
    const body = await bodyFor(probe, 'token:paired-device');
    expect(body).not.toContain(probe.canary);
    expect(body).toContain(REDACTION_SENTINEL);
  });

  it('leaves a cookie operator’s view unchanged', async () => {
    const body = await bodyFor(probe, 'admin');
    expect(body).toContain(probe.canary);
  });

  it('redacts for a session bridged from a token', async () => {
    // `POST /api/auth/session-from-token` mints a cookie whose user is
    // `token:<name>` — same principal, no Bearer header in sight.
    const body = await bodyFor(probe, 'token:bridged-session');
    expect(body).not.toContain(probe.canary);
  });
});
