/**
 * claude-dev configuration UI shell (#2678) — the foundation of epic #2674.
 *
 * The acceptance criteria on the issue are:
 *   1. the config subdomain shows an authenticated empty shell page;
 *   2. a request WITHOUT a valid Authelia session is refused / redirected to
 *      login, same as every other service;
 *   3. it is reachable with no manual or SSH step on a fresh install.
 *
 * Criterion 2 is the one that rots silently, because a suite that only drives
 * the happy path passes just as well against a UI that authenticates nobody.
 * So the anonymous request is exercised FIRST and on every surface — page,
 * static asset and API alike — and asserted to return no page at all.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev');
const CONFIG_UI_DIR = path.join(TEMPLATE_DIR, 'config-ui');
const SERVER_MJS = path.join(CONFIG_UI_DIR, 'server.mjs');

const read = (p: string) => fs.readFileSync(p, 'utf-8');

// The token value used in the running server below. It must never appear in
// anything the server sends back.
const FAKE_TOKEN = 'sb_test_only_never_leaves_the_server';

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(port: number, pathname: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('claude-dev config UI: the auth gate (acceptance 2)', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const mod = await import(/* @vite-ignore */ SERVER_MJS);
    server = mod.createConfigUiServer({
      requiredGroup: 'admins',
      servicebay: { url: 'http://host.containers.internal:5888', token: FAKE_TOKEN },
      log: () => {},
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  // ─── refused ────────────────────────────────────────────────────────────

  it('refuses the page when no Authelia identity is present, and returns no shell', async () => {
    const res = await request(port, '/');
    expect(res.status).toBe(401);
    // The real assertion: not merely "non-200", but that nothing page-shaped
    // came back. A 401 that still ships the markup would be the "reports
    // success while nothing happened" defect in its purest form.
    expect(res.body).not.toContain('panel-root');
    expect(res.body).not.toContain('<html');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it.each([
    ['header absent', {}],
    ['header empty', { 'Remote-User': '' }],
    ['header whitespace-only', { 'Remote-User': '   ' }],
  ])('refuses when the identity is unusable — %s', async (_label, headers) => {
    const res = await request(port, '/', headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('panel-root');
  });

  it('gates the static assets too, not just the page', async () => {
    for (const asset of ['/shell.js', '/shell.css', '/panels/index.js', '/index.html']) {
      const res = await request(port, asset);
      expect(res.status, `${asset} must not be served anonymously`).toBe(401);
    }
  });

  it('gates the API', async () => {
    const res = await request(port, '/api/session');
    expect(res.status).toBe(401);
  });

  it('refuses a signed-in user outside the required group', async () => {
    const res = await request(port, '/', { 'Remote-User': 'kid', 'Remote-Groups': 'family' });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('panel-root');
    expect(res.body).toContain('admins');
  });

  it('has no switch that turns the identity check off — an empty requiredGroup still refuses anonymous', async () => {
    const mod = await import(/* @vite-ignore */ SERVER_MJS);
    const open = mod.createConfigUiServer({ requiredGroup: '', log: () => {} });
    await new Promise<void>(r => open.listen(0, '127.0.0.1', r));
    const p = (open.address() as AddressInfo).port;
    try {
      expect((await request(p, '/')).status).toBe(401);
      // …while a signed-in user with no groups now gets through, proving the
      // 401 above came from the identity check and not from the group check.
      expect((await request(p, '/', { 'Remote-User': 'anyone' })).status).toBe(200);
    } finally {
      await new Promise<void>(r => open.close(() => r()));
    }
  });

  it('does not serve files outside public/ even to an authenticated user', async () => {
    const id = { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' };
    for (const attempt of ['/../server.mjs', '/%2e%2e/server.mjs', '/../../package.json']) {
      const res = await request(port, attempt, id);
      expect([403, 404]).toContain(res.status);
      expect(res.body).not.toContain('createConfigUiServer');
    }
  });

  // ─── allowed ────────────────────────────────────────────────────────────

  it('serves the shell to an authenticated member of the group (acceptance 1)', async () => {
    const res = await request(port, '/', { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins,family' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('id="panel-root"');
    expect(res.body).toContain('id="shell-nav"');
    // Identity-scoped responses must never be cached by the proxy.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports the session without ever disclosing the ServiceBay token', async () => {
    const res = await request(port, '/api/session', { 'Remote-User': 'mdopp', 'Remote-Groups': 'admins' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBe('mdopp');
    expect(body.groups).toEqual(['admins']);
    expect(body.servicebay.configured).toBe(true);
    // The credential path is server-side only (SEAM 3). Check the whole
    // response, headers included — not just the field we happen to read.
    expect(res.body).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(FAKE_TOKEN);
  });
});

describe('claude-dev config UI: the ServiceBay credential is the one already minted', () => {
  it('reads the token from a file, so it is never in argv or the environment', async () => {
    const mod = await import(/* @vite-ignore */ SERVER_MJS);
    expect(mod.readServicebayToken(
      { SERVICEBAY_MCP_TOKEN_FILE: '/run/claude-dev/servicebay-token' },
      () => 'sb_from_file\n',
    )).toBe('sb_from_file');
    // An unreadable file must not fall back to something that authenticates
    // as nothing — it yields "not configured", which the UI can report.
    expect(mod.readServicebayToken(
      { SERVICEBAY_MCP_TOKEN_FILE: '/run/claude-dev/missing' },
      () => { throw new Error('ENOENT'); },
    )).toBe('');
  });

  it('the entrypoint feeds it the SAME variable the MCP server uses, via a 0400 file', () => {
    const entrypoint = read(path.join(TEMPLATE_DIR, 'docker-entrypoint.sh'));
    expect(entrypoint).toContain('start_config_ui');
    expect(entrypoint).toMatch(/install -o dev -g dev -m 0400 [^\n]*CONFIG_UI_TOKEN_FILE/);
    expect(entrypoint).toContain('printf \'%s\' "${SERVICEBAY_MCP_TOKEN:-}" > "$CONFIG_UI_TOKEN_FILE"');
    // No second credential variable was invented for the UI.
    expect(entrypoint).not.toMatch(/CLAUDE_DEV_CONFIG_TOKEN|CONFIG_UI_API_KEY/);
  });
});

describe('claude-dev config UI: proxy + SSO wiring (acceptance 2 and 3)', () => {
  const variables = JSON.parse(read(path.join(TEMPLATE_DIR, 'variables.json')));
  const podYaml = read(path.join(TEMPLATE_DIR, 'template.yml'));

  it('publishes the subdomain through Authelia forward-auth, like every other gated service', () => {
    const sub = variables.CLAUDE_DEV_CONFIG_SUBDOMAIN;
    expect(sub).toBeTruthy();
    expect(sub.type).toBe('subdomain');
    expect(sub.proxyPort).toBe('CLAUDE_DEV_CONFIG_PORT');
    // This sentinel is what makes an anonymous browser hit redirect to the
    // Authelia login instead of reaching the container at all.
    expect(sub.proxyConfig.advanced_config).toBe('__authelia_forward_auth__');
    expect(sub.proxyConfig.ssl_forced).toBe(true);
    // buildProxyHosts turns loopbackOnly into forwardHost 127.0.0.1 — required
    // because the port below is published on the loopback only.
    expect(sub.loopbackOnly).toBe(true);
  });

  it('publishes the UI port on the host loopback only, so the LAN cannot skip the gate', () => {
    // Comment-stripped so the prose explaining `hostIP` can't be mistaken for
    // the directive itself.
    const code = podYaml.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    const ports = code.slice(code.indexOf('containerPort: {{CLAUDE_DEV_SSH_PORT}}'));

    const ssh = ports.slice(0, ports.indexOf('containerPort: {{CLAUDE_DEV_CONFIG_PORT}}'));
    expect(ssh).toContain('hostPort: {{CLAUDE_DEV_SSH_PORT}}');
    // sshd deliberately stays on 0.0.0.0 — that one must NOT gain a hostIP.
    expect(ssh).not.toContain('hostIP');

    const ui = ports.slice(ports.indexOf('containerPort: {{CLAUDE_DEV_CONFIG_PORT}}'));
    expect(ui).toContain('hostPort: {{CLAUDE_DEV_CONFIG_PORT}}');
    expect(ui).toContain('hostIP: 127.0.0.1');
  });

  it('declares the port and depends on nginx, so the proxy host exists at install time', () => {
    expect(variables.CLAUDE_DEV_CONFIG_PORT.default).toBe('8790');
    expect(podYaml).toContain('servicebay.dependencies: "nginx,auth"');
    // The UI's port has to be in the declared set; the set itself grows as the
    // container gains services (v4 added pi's, #2803), so this asserts the
    // membership rather than the exact string.
    const declaredPorts = /servicebay\.ports: "([^"]+)"/.exec(podYaml)?.[1] ?? '';
    expect(declaredPorts.split(',')).toContain('{{CLAUDE_DEV_CONFIG_PORT}}/tcp');
    // The config UI arrived in v3; the template is at or above that ever since.
    const schema = Number(/servicebay\.schema-version: "(\d+)"/.exec(podYaml)?.[1]);
    expect(schema).toBeGreaterThanOrEqual(3);
  });

  it('needs no manual step: the image carries the UI and the entrypoint starts it before sshd', () => {
    const dockerfile = read(path.join(TEMPLATE_DIR, 'Dockerfile'));
    expect(dockerfile).toContain('COPY config-ui /usr/local/lib/claude-dev-config-ui');

    const entrypoint = read(path.join(TEMPLATE_DIR, 'docker-entrypoint.sh'));
    const startsAt = entrypoint.lastIndexOf('\nstart_config_ui\n');
    expect(startsAt, 'the boot sequence must actually call start_config_ui').toBeGreaterThan(-1);
    expect(startsAt).toBeLessThan(entrypoint.lastIndexOf('exec /usr/sbin/sshd'));

    // A change to the UI has to rebuild the published image, or the box keeps
    // serving the old shell forever.
    const workflow = read(path.join(REPO_ROOT, '.github', 'workflows', 'claude-dev-image.yml'));
    expect(workflow).toContain("templates/claude-dev/config-ui/**");
  });

  it('ships a CHANGELOG section for the schema-version bump', () => {
    expect(read(path.join(TEMPLATE_DIR, 'CHANGELOG.md'))).toContain('## v3');
  });
});

describe('claude-dev config UI: the shell renders (acceptance 1, DOM)', () => {
  it('builds the nav from the panel manifest and names the signed-in user', async () => {
    const html = read(path.join(CONFIG_UI_DIR, 'public', 'index.html'));
    // Take the real markup the server serves, not a hand-written fixture.
    document.documentElement.innerHTML = html.slice(html.indexOf('<head>'));

    // Route by URL: the shell asks for the session, and whichever panel the
    // manifest mounts first asks for its own data.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url === '/api/session'
        ? { user: 'mdopp', name: 'Michael', groups: ['admins'], servicebay: { configured: true } }
        : { workspace: '/workspace', projects: [], sources: { checkouts: { ok: true }, sessions: { ok: true }, mcp: { ok: true } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    vi.resetModules();
    const { PANELS } = await import(/* @vite-ignore */ path.join(CONFIG_UI_DIR, 'public', 'panels', 'index.js'));
    await import(/* @vite-ignore */ path.join(CONFIG_UI_DIR, 'public', 'shell.js'));
    // boot() awaits one microtask chain before rendering the nav.
    await new Promise(r => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.anything());
    expect(document.getElementById('shell-identity')!.textContent)
      .toContain('Signed in as Michael');

    const nav = document.getElementById('shell-nav')!;
    // Nothing here knows a panel by name — the nav IS the manifest (#2678's
    // SEAM 1), which is what lets #2679-#2682 add pages with no shell change.
    expect([...nav.querySelectorAll('button')].map(b => b.textContent))
      .toEqual(PANELS.map((p: { title: string }) => p.title));
    expect(nav.textContent).not.toContain('No sections yet');
    // …and the first panel is actually mounted, not just listed.
    expect(document.getElementById('panel-root')!.childElementCount).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('the panel manifest is the documented mount seam for #2679-#2682', async () => {
    const manifest = await import(/* @vite-ignore */ path.join(CONFIG_UI_DIR, 'public', 'panels', 'index.js'));
    expect(Array.isArray(manifest.PANELS)).toBe(true);
    const src = read(path.join(CONFIG_UI_DIR, 'public', 'panels', 'index.js'));
    expect(src).toContain('mount(root, ctx)');
  });

  it('carries no inline script or style, so the CSP the server sends actually holds', () => {
    const html = read(path.join(CONFIG_UI_DIR, 'public', 'index.html'));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(read(SERVER_MJS)).toContain("default-src 'self'");
  });
});
