/**
 * Install-runner unit tests (#810).
 *
 * Covers the inter-template readiness gate: `isServiceReady` (the
 * readiness predicate) and `waitForDependencies` (the gate that blocks
 * a template's deploy until its declared dependencies are healthy).
 *
 * The twin is mocked the same way `stackRunner.test.ts` does it, so the
 * gate reads deterministic fixtures instead of a live digital twin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinStub: {
  nodes: Record<string, { services?: Array<{ name: string; active?: boolean; health?: { ready: boolean } }> }>;
} = { nodes: {} };
vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({
      getSnapshot: () => ({ nodes: twinStub.nodes }),
    }),
  },
}));

// The gate registers deployed services with the health poller before
// polling. In a unit test there is no agent to list services from, so
// stub the bootstrap to a no-op.
const bootstrapMock = vi.fn().mockResolvedValue({ registered: [], skipped: [] });
vi.mock('@/lib/health/serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: () => bootstrapMock(),
}));

// `ensureProxyHosts` POSTs via the loopback apiFetch, which attaches the
// internal token — stub it so the test doesn't need a real token file.
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));

// #2415 — post-deploy.py bodies must reach the box byte-identical. The
// registry is the source of the raw script; stub it so the test controls
// the exact bytes going in.
const postDeployScriptMock = vi.fn<(name: string, source?: string) => Promise<string | null>>();
vi.mock('@/lib/registry', () => ({
  getTemplatePostDeployScript: (name: string, source?: string) => postDeployScriptMock(name, source),
  getTemplateMigrationScripts: vi.fn(),
  getTemplateYaml: vi.fn(),
  syncRegistries: vi.fn(),
}));

import { isServiceReady, waitForDependencies, ensureProxyHosts, authDynamicVars, loadPostDeployScript, buildMigrationSteps, summariseIncompleteRun } from './runner';
import type { StackVariable } from '@/lib/stackInstall/postInstall';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  twinStub.nodes = {};
  bootstrapMock.mockClear();
  fetchSpy.mockReset();
});

describe('authDynamicVars (LLDAP admin re-key self-heal #666)', () => {
  it('forces LLDAP_FORCE_LDAP_USER_PASS_RESET=always for the auth template', () => {
    expect(authDynamicVars('auth')).toEqual({ LLDAP_FORCE_LDAP_USER_PASS_RESET: 'always' });
  });

  it('is unconditional — never emits the old reused-secret "false"', () => {
    // Regression guard: the old `isRegenerated ? 'always' : 'false'`
    // heuristic emitted 'false' for a reused secret, which left a
    // diverged users.db locking Authelia out forever (LDAP code 49).
    // It must ALWAYS be 'always' — and never 'true', which one-shot
    // resets then exits, crash-looping with the flag baked into env.
    const v = authDynamicVars('auth').LLDAP_FORCE_LDAP_USER_PASS_RESET;
    expect(v).toBe('always');
    expect(v).not.toBe('false');
    expect(v).not.toBe('true');
  });

  it('injects nothing for non-auth templates', () => {
    expect(authDynamicVars('nginx')).toEqual({});
    expect(authDynamicVars('immich')).toEqual({});
  });
});

describe('isServiceReady', () => {
  it('prefers the health signal over systemd-active', () => {
    // active=true but health.ready=false → not ready (app still booting
    // inside an active unit — the exact #810 failure mode).
    expect(isServiceReady([{ name: 'auth', active: true, health: { ready: false } }], 'auth')).toBe(false);
    expect(isServiceReady([{ name: 'auth', active: false, health: { ready: true } }], 'auth')).toBe(true);
  });

  it('falls back to systemd-active when no health signal is present', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'nginx')).toBe(true);
    expect(isServiceReady([{ name: 'nginx', active: false }], 'nginx')).toBe(false);
  });

  it('matches a unit name with or without the .service suffix', () => {
    expect(isServiceReady([{ name: 'auth.service', active: true }], 'auth')).toBe(true);
  });

  it('returns false when the service is absent from the twin', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'auth')).toBe(false);
  });
});

describe('waitForDependencies', () => {
  it('returns immediately when the item declares no dependencies', async () => {
    await waitForDependencies('job1', { name: 'ollama', dependencies: [] }, 'Local');
    // No twin read, no health bootstrap when there is nothing to gate on.
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  it('resolves once every declared dependency is healthy', async () => {
    twinStub.nodes['Local'] = {
      services: [
        { name: 'nginx', health: { ready: true } },
        { name: 'auth', health: { ready: true } },
      ],
    };
    await expect(
      waitForDependencies('job1', { name: 'media', dependencies: ['nginx', 'auth'] }, 'Local'),
    ).resolves.toBeUndefined();
    // The gate registers deployed services with the health poller first.
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });
});

describe('ensureProxyHosts', () => {
  const subdomainVar = (template: string, varName: string, sub: string): StackVariable => ({
    name: varName,
    value: sub,
    meta: {
      type: 'subdomain',
      templateName: template,
      proxyPort: '2283',
      exposure: 'public',
    } as StackVariable['meta'],
  });

  it('POSTs every subdomain host in one batch, even across templates', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, created: ['photos.dopp.cloud', 'vault.dopp.cloud'] }), { status: 200 }),
    );
    const variables: StackVariable[] = [
      { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
      subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos'),
      subdomainVar('vaultwarden', 'VAULTWARDEN_SUBDOMAIN', 'vault'),
    ];
    await ensureProxyHosts('job1', variables, undefined);
    // Single consolidated POST — not one-per-template.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/system\/nginx\/proxy-hosts$/);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.publicDomain).toBe('dopp.cloud');
    const domains = body.hosts.map((h: { domain: string }) => h.domain).sort();
    expect(domains).toEqual(['photos.dopp.cloud', 'vault.dopp.cloud']);
  });

  it('no-ops on a pure-LAN install with no PUBLIC_DOMAIN', async () => {
    await ensureProxyHosts('job1', [subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos')], undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops when there are no subdomain-typed variables', async () => {
    await ensureProxyHosts('job1', [{ name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' }], undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('loadPostDeployScript — script bodies ship verbatim (#2415)', () => {
  beforeEach(() => {
    postDeployScriptMock.mockReset();
  });

  it('returns the raw script byte-identical, foreign {{…}} expressions intact', async () => {
    // The exact shape that cost mdopp/solarisbay#1092 five debugging
    // rounds: Mustache deleted both Go-template tags, leaving `--format '|'`,
    // which podman answers with `|` and exit 0.
    const raw = [
      '#!/usr/bin/env python3',
      'import os, subprocess',
      'FMT = \'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}\'',
      'HOST = os.environ.get("HOST", "localhost")',
      'JINJA = "{{ ansible_hostname }}"',
      'HELM = "{{ .Values.image.tag }}"',
      'SUBJECT = f\'subject: "[Authelia] {{title}}"\'',
      'print(subprocess.run(["podman", "inspect", "--format", FMT]))',
    ].join('\n');
    postDeployScriptMock.mockResolvedValue(raw);

    const out = await loadPostDeployScript('solaris', 'Built-in');

    // Byte-identical — no substitution, no deletion, no re-encoding.
    expect(out).toBe(raw);
    expect(out).toContain('{{.Image}}');
    expect(out).toContain('{{index .Config.Labels "org.opencontainers.image.revision"}}');
    expect(out).toContain('{{ ansible_hostname }}');
    expect(out).toContain('{{ .Values.image.tag }}');
    expect(out).toContain('{{title}}');
    // The pre-#2415 behaviour: every unknown tag rendered to empty.
    expect(out).not.toContain("--format '|'");
    expect(postDeployScriptMock).toHaveBeenCalledWith('solaris', 'Built-in');
  });

  it('leaves a known ServiceBay variable name alone too — env is the only channel', async () => {
    // `HOST`/`DATA_DIR` ARE in the render view, so the old code would have
    // substituted them into the source. Scripts read them from os.environ.
    const raw = 'BASE = os.environ.get("DATA_DIR", "/mnt/data")  # not {{DATA_DIR}}\n';
    postDeployScriptMock.mockResolvedValue(raw);
    expect(await loadPostDeployScript('auth')).toBe(raw);
  });

  it('returns undefined when the template ships no script or the fetch fails', async () => {
    postDeployScriptMock.mockResolvedValue(null);
    expect(await loadPostDeployScript('nginx')).toBeUndefined();
    postDeployScriptMock.mockResolvedValue('');
    expect(await loadPostDeployScript('nginx')).toBeUndefined();
    postDeployScriptMock.mockRejectedValue(new Error('registry unreachable'));
    await expect(loadPostDeployScript('nginx')).resolves.toBeUndefined();
  });

  it('the deploy call site never re-introduces a render pass', () => {
    // Guards the seam: the behavioural test above only proves the loader is
    // a pass-through, not that `deployItem` stopped wrapping it.
    const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf-8');
    const assignment = src.match(/const hasPostDeployScript = .*/);
    expect(assignment?.[0]).toBe(
      'const hasPostDeployScript = Boolean(await loadPostDeployScript(item.name, input.templateSource));',
    );
    expect(src).not.toMatch(/postDeployScript\s*=\s*renderTemplate/);
  });

  it('never puts a script body on the wire — the route reads it from the registry (#2503)', () => {
    // The deploy POST may carry the template SOURCE, never the script. If
    // this regresses, an arbitrary body is executable again via /api/services.
    const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf-8');
    const bodyStart = src.indexOf('body: JSON.stringify({');
    expect(bodyStart).toBeGreaterThan(-1);
    const body = src.slice(bodyStart, src.indexOf('}),', bodyStart));
    expect(body).not.toMatch(/\bpostDeployScript\b/);
    expect(body).toMatch(/templateSource: input\.templateSource/);
    // Migration steps ship by reference (filename + version pair) only.
    expect(body).toMatch(/migrations\?\.map\(\(\{ filename, fromVersion, toVersion \}\)/);
    expect(body).not.toMatch(/\bcontent\b/);
  });
});

describe('buildMigrationSteps — migration bodies ship verbatim (#2435)', () => {
  const step = (over: Partial<{ filename: string; fromVersion: number; toVersion: number; content: string }> = {}) => ({
    filename: 'v1-to-v2.py',
    fromVersion: 1,
    toVersion: 2,
    content: '#!/usr/bin/env python3\n',
    ...over,
  });

  it('returns each body byte-identical, foreign {{…}} expressions intact', () => {
    // Same shape as the post-deploy case above — and a migration is the
    // worst place to lose it: fail-fast, runs before the new manifest
    // lands, touches operator data.
    const raw = [
      '#!/usr/bin/env python3',
      'import os, subprocess',
      'FMT = \'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}\'',
      'DATA = os.environ.get("NEW_DATA_DIR", "/mnt/data")',
      'JINJA = "{{ ansible_hostname }}"',
      'HELM = "{{ .Values.image.tag }}"',
      'SUBJECT = f\'subject: "[Authelia] {{title}}"\'',
      'print(subprocess.run(["podman", "inspect", "--format", FMT]))',
    ].join('\n');

    const out = buildMigrationSteps([step({ content: raw })]);

    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(raw);
    expect(out[0].content).toContain('{{.Image}}');
    expect(out[0].content).toContain('{{index .Config.Labels "org.opencontainers.image.revision"}}');
    expect(out[0].content).toContain('{{ ansible_hostname }}');
    expect(out[0].content).toContain('{{ .Values.image.tag }}');
    expect(out[0].content).toContain('{{title}}');
    // The pre-#2435 behaviour: every unknown tag rendered to empty.
    expect(out[0].content).not.toContain("--format '|'");
  });

  it('leaves known ServiceBay variable names alone too — env is the only channel', () => {
    // `DATA_DIR`/`LLDAP_PORT` ARE wizard variables, so the old render
    // pass substituted them into the source. The first-party migrations
    // only ever mention them as docstring prose; the scripts read
    // os.environ. Both must survive as written.
    const raw = [
      '"""Moves `{{DATA_DIR}}/auth/lldap` and re-points `127.0.0.1:{{LLDAP_PORT}}`."""',
      'BASE = os.environ.get("DATA_DIR", "/mnt/data")',
    ].join('\n');
    expect(buildMigrationSteps([step({ content: raw })])[0].content).toBe(raw);
  });

  it('preserves the chain order and hop metadata across a multi-version hop', () => {
    const chain = [
      step({ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2, content: 'a\n' }),
      step({ filename: 'v2-to-v3.py', fromVersion: 2, toVersion: 3, content: 'b {{X}}\n' }),
      step({ filename: 'v3-to-v4.py', fromVersion: 3, toVersion: 4, content: 'c\n' }),
    ];
    expect(buildMigrationSteps(chain)).toEqual(chain);
    expect(buildMigrationSteps([])).toEqual([]);
  });

  it('the deploy call site never re-introduces a render pass', () => {
    // Guards the seam: the mapper is a pass-through, but `deployItem`
    // must not wrap it (this is exactly how the bug survived #2415).
    const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf-8');
    expect(src).toMatch(/migrations = buildMigrationSteps\(result\.chain\);/);
    expect(src).not.toMatch(/renderTemplate\(s\.content/);
    expect(src).not.toMatch(/migrations\s*=\s*renderTemplate/);
  });
});

// ─── #2601 — a run that rolled nothing out is not a success ────────────────
describe('summariseIncompleteRun — report the denominator, not the return status', () => {
  it('names the zero case explicitly', () => {
    // The reference-box case: a single `media` upgrade that stopped at the
    // migration gate. Nothing reached the box, and the run still ended in the
    // dialog's finished state.
    expect(summariseIncompleteRun([], ['media'])).toBe(
      '❌ Nothing was deployed: 0 of 1 requested service(s) reached the box (media).',
    );
  });

  it('reports a partial run as partial, with both sides named', () => {
    expect(summariseIncompleteRun(['nginx'], ['nginx', 'auth', 'immich'])).toBe(
      '❌ 1/3 requested service(s) deployed (nginx). NOT deployed: auth, immich.',
    );
  });

  it('only calls a run successful when every requested service landed', () => {
    expect(summariseIncompleteRun(['nginx', 'auth'], ['nginx', 'auth'])).toMatch(/^✅ 2\/2/);
  });

  it('an install that requested nothing is not reported as a failure', () => {
    expect(summariseIncompleteRun([], [])).toMatch(/^✅ 0\/0/);
  });
});

describe('runJob terminal verdict + failure logging (#2601)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'runner.ts'), 'utf-8');

  it('the deploy-loop catch logs before it patches the job to error', () => {
    // Pre-fix this catch set `phase: 'error'` and returned WITHOUT writing a
    // line, so the dialog's last visible log line was the green dependency
    // tick that came just before it.
    const catchBlock = src.slice(src.indexOf('const ok = await deployItem(ctx, item);'));
    const logIdx = catchBlock.indexOf('❌ Install stopped at');
    const patchIdx = catchBlock.indexOf('await patchJob(');
    expect(logIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeLessThan(patchIdx);
  });

  it('the final phase is derived from what deployed, not from reaching the end', () => {
    expect(src).toMatch(/phase: incomplete \? 'error' : 'done'/);
    expect(src).toMatch(/const incomplete = deployedNew\.length < toDeploy\.length;/);
    // `deployedNew` must stay separate from ctx.deployed, which also collects
    // the skipped already-installed satisfiers — counting those would report a
    // no-op upgrade as a multi-service success.
    expect(src).toMatch(/const toDeploy = selected\.filter\(s => !s\.alreadyInstalled\)\.map\(s => s\.name\);/);
  });

  it('an item with no spec in the manifest says so instead of returning silently', () => {
    expect(src).toMatch(/carries no template spec in this manifest/);
  });

  it('the internal-runner-error path writes to the job log too', () => {
    expect(src).toMatch(/❌ Internal runner error:/);
  });
});
