/**
 * GET /api/services/:name/reconfigure-preview — "Re-render from template" (#2537).
 *
 * The bug: the route built its render view from `templateSettings[name] ??
 * meta.default ?? ''` and consulted neither `config.installedVariables` (#2531)
 * nor `config.installedSecrets` (#615), so every operator-typed value and every
 * generated secret came back as an EMPTY STRING in the YAML handed to the editor.
 *
 * These tests deliberately let the REAL `assembleManifest` /
 * `applyVariableDefaults` / `savedSecrets` / `savedVariables` /
 * `findEmptyYamlVars` / `renderPodYaml` run — only the registry, the config file
 * and the API-handler gate are stubbed. That is the point: the assertion worth
 * having is not "the route reads a store" but "the preview resolves what a
 * deploy resolves", which only holds if the same code produces both.
 *
 * No real credentials here — every fixture value is an obvious placeholder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VariableMeta } from '@/lib/registry';

const mocks = vi.hoisted(() => ({
  getTemplateYaml: vi.fn(),
  getTemplateVariables: vi.fn(),
  getTemplateConfigFiles: vi.fn(),
  getTemplateAssetFiles: vi.fn(),
  getTemplateSettingsSchema: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@/lib/registry', () => ({
  getTemplateYaml: mocks.getTemplateYaml,
  getTemplateVariables: mocks.getTemplateVariables,
  getTemplateConfigFiles: mocks.getTemplateConfigFiles,
  getTemplateAssetFiles: mocks.getTemplateAssetFiles,
  getTemplateSettingsSchema: mocks.getTemplateSettingsSchema,
}));

vi.mock('@/lib/config', () => ({
  getConfig: mocks.getConfig,
  updateConfig: mocks.updateConfig,
}));

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (_opts: unknown, handler: (ctx: { params: { name: string } }) => Promise<Response>) =>
      (_req: unknown, ctx: { params: { name: string } }) => handler({ params: ctx.params }),
}));

import { GET } from './route';
import { assembleManifest, applyVariableDefaults } from '@/lib/install/manifestAssembler';
import { authDynamicVars } from '@/lib/install/runner';
import { renderPodYaml } from '@/lib/template/render';

/** Minimal pod yaml with the given `env` entries, each `value: "{{VAR}}"`. */
function podYaml(name: string, vars: string[]): string {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  annotations:
    servicebay.label: "${name}"
spec:
  containers:
  - name: ${name}
    image: example/${name}:latest
    env:
${vars.map(v => `      - name: ${v}\n        value: "{{${v}}}"`).join('\n')}
`;
}

async function call(name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await (GET as unknown as (
    req: unknown,
    ctx: { params: { name: string } },
  ) => Promise<Response>)({}, { params: { name } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function setTemplate(name: string, vars: string[], meta: Record<string, VariableMeta>): void {
  mocks.getTemplateYaml.mockResolvedValue(podYaml(name, vars));
  mocks.getTemplateVariables.mockResolvedValue(meta);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTemplateConfigFiles.mockResolvedValue([]);
  mocks.getTemplateAssetFiles.mockResolvedValue([]);
  mocks.getTemplateSettingsSchema.mockResolvedValue({});
  mocks.getConfig.mockResolvedValue({ templateSettings: {} });
  mocks.updateConfig.mockResolvedValue(undefined);
});

describe('reconfigure-preview — #2537 blanked values', () => {
  it('keeps an operator-set non-secret value instead of rendering it empty', async () => {
    // A `text` variable whose template default is empty — exactly the #2531
    // shape. Pre-fix the view was `templateSettings ?? '' ?? ''` → `value: ""`.
    setTemplate('solaris', ['VAPID_PUBLIC_KEY'], {
      VAPID_PUBLIC_KEY: { type: 'text', default: '' },
    });
    mocks.getConfig.mockResolvedValue({
      templateSettings: {},
      installedVariables: [{ varName: 'VAPID_PUBLIC_KEY', value: 'operator-typed-public-key' }],
    });

    const { status, body } = await call('solaris');

    expect(status).toBe(200);
    expect(body.yamlContent).toContain('value: "operator-typed-public-key"');
    expect(body.yamlContent).not.toContain('name: VAPID_PUBLIC_KEY\n        value: ""');
    expect(body.unresolved).toEqual([]);
  });

  it('keeps a stored secret instead of rendering it empty', async () => {
    // The worse half of #2537: the blanked value here is a live credential, so
    // a re-render + save deploys the pod with no password.
    setTemplate('auth', ['LLDAP_ADMIN_PASSWORD'], {
      LLDAP_ADMIN_PASSWORD: { type: 'secret' },
    });
    mocks.getConfig.mockResolvedValue({
      templateSettings: {},
      installedSecrets: [{ varName: 'LLDAP_ADMIN_PASSWORD', password: 'PLACEHOLDER-not-a-real-secret' }],
    });

    const { status, body } = await call('auth');

    expect(status).toBe(200);
    expect(body.yamlContent).toContain('value: "PLACEHOLDER-not-a-real-secret"');
    expect(body.unresolved).toEqual([]);
  });

  it('renders byte-for-byte what the deploy path would render', async () => {
    // The criterion that matters: not "looks right" but "is the same bytes the
    // install runner would write". Build the deploy view the way `deployItem`
    // does — assembleManifest (no preview) → applyVariableDefaults → variables
    // reduced to a view → authDynamicVars → renderPodYaml — and compare.
    setTemplate('auth', ['LLDAP_ADMIN_PASSWORD', 'LLDAP_BASE_DN', 'PUBLIC_DOMAIN', 'LLDAP_FORCE_LDAP_USER_PASS_RESET'], {
      LLDAP_ADMIN_PASSWORD: { type: 'secret' },
      LLDAP_BASE_DN: { type: 'text', default: '' },
      PUBLIC_DOMAIN: { type: 'text', default: '' },
      LLDAP_FORCE_LDAP_USER_PASS_RESET: { type: 'text', default: 'false' },
    });
    mocks.getConfig.mockResolvedValue({
      templateSettings: {},
      reverseProxy: { publicDomain: 'example.test' },
      installedSecrets: [{ varName: 'LLDAP_ADMIN_PASSWORD', password: 'PLACEHOLDER-not-a-real-secret' }],
    });

    const { status, body } = await call('auth');
    expect(status).toBe(200);

    const assembled = await assembleManifest({ items: [{ name: 'auth', checked: true }] });
    const withDefaults = await applyVariableDefaults({
      items: assembled.items,
      variables: assembled.variables,
      templateSource: 'Built-in',
      host: 'localhost',
      wipeMode: 'install',
    });
    const view: Record<string, string> = {};
    for (const v of withDefaults.variables) view[v.name] = v.value;
    Object.assign(view, authDynamicVars('auth'));
    const deployed = renderPodYaml(assembled.items[0].yaml as string, view);

    expect(body.yamlContent).toBe(deployed);
    // And the dynamic var the runner injects is present, not a stale default —
    // `assembleManifest` drops it from the variable set on purpose.
    expect(body.yamlContent).toContain('name: LLDAP_FORCE_LDAP_USER_PASS_RESET\n        value: "always"');
    expect(body.yamlContent).toContain('value: "example.test"');
  });
});

describe('reconfigure-preview — no silent substitution (#2537)', () => {
  it('refuses to render when a generated secret cannot be recovered, and writes nothing', async () => {
    setTemplate('auth', ['LLDAP_ADMIN_PASSWORD'], {
      LLDAP_ADMIN_PASSWORD: { type: 'secret' },
    });
    mocks.getConfig.mockResolvedValue({ templateSettings: {} });

    const { status, body } = await call('auth');

    expect(status).toBe(400);
    expect(body.unresolvedSecrets).toEqual(['LLDAP_ADMIN_PASSWORD']);
    expect(String(body.error)).toContain('LLDAP_ADMIN_PASSWORD');
    // A read-only preview must neither mint a replacement credential nor
    // persist one — that would diverge `installedSecrets` from the running pod.
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(body.yamlContent).toBeUndefined();
  });

  it('names a non-secret value it could not resolve rather than returning it quietly empty', async () => {
    setTemplate('svc', ['OPTIONAL_TOKEN'], {
      OPTIONAL_TOKEN: { type: 'text', default: '' },
    });

    const { status, body } = await call('svc');

    expect(status).toBe(200);
    expect(body.unresolved).toEqual(['OPTIONAL_TOKEN']);
  });

  it('lets an operator-supplied (noAutoGenerate) secret render empty, but reports it', async () => {
    setTemplate('hass', ['HASS_TOKEN'], {
      HASS_TOKEN: { type: 'secret', noAutoGenerate: true },
    });

    const { status, body } = await call('hass');

    // Empty is this variable's legitimate resting state (the operator pastes it
    // in later), so refusing would make re-render impossible — but it is still
    // named rather than silently blank.
    expect(status).toBe(200);
    expect(body.unresolved).toEqual(['HASS_TOKEN']);
  });

  it('404s when the template is gone from the registry', async () => {
    mocks.getTemplateYaml.mockResolvedValue(null);
    mocks.getTemplateVariables.mockResolvedValue(null);

    const { status, body } = await call('ghost');

    expect(status).toBe(404);
    expect(String(body.error)).toContain('ghost');
  });
});
