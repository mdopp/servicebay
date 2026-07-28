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

import { isServiceReady, waitForDependencies, ensureProxyHosts, authDynamicVars, loadPostDeployScript } from './runner';
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
    const assignment = src.match(/const postDeployScript = .*/);
    expect(assignment?.[0]).toBe(
      'const postDeployScript = await loadPostDeployScript(item.name, input.templateSource);',
    );
    expect(src).not.toMatch(/postDeployScript\s*=\s*renderTemplate/);
  });
});
