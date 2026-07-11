/**
 * Manifest-assembler tests (#800).
 *
 * The registry + config + saved-secrets layers are mocked so the
 * assembler runs against deterministic fixtures; `parseTemplateDependencies`,
 * `readManifestAnnotations` and `generateRandomSecret` run for real
 * (pure functions / local crypto).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VariableMeta } from '@/lib/registry';

const getTemplateYaml = vi.fn<(n: string, s?: string) => Promise<string | null>>();
const getTemplateVariables = vi.fn<(n: string, s?: string) => Promise<Record<string, VariableMeta> | null>>();
const getTemplateConfigFiles = vi.fn<(n: string, s?: string) => Promise<{ filename: string; content: string }[]>>();
const getTemplateAssetFiles = vi.fn<(n: string, s?: string) => Promise<{ filename: string; content: string; targetPath?: string; renderContent?: boolean }[]>>();
const getTemplateSettingsSchema = vi.fn<() => Promise<Record<string, { default: string; description?: string }>>>();
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: (n: string, s?: string) => getTemplateYaml(n, s),
  getTemplateVariables: (n: string, s?: string) => getTemplateVariables(n, s),
  getTemplateConfigFiles: (n: string, s?: string) => getTemplateConfigFiles(n, s),
  getTemplateAssetFiles: (n: string, s?: string) => getTemplateAssetFiles(n, s),
  getTemplateSettingsSchema: () => getTemplateSettingsSchema(),
}));

const getConfig = vi.fn<() => Promise<{ templateSettings?: Record<string, string>; reverseProxy?: { publicDomain?: string } }>>();
vi.mock('@/lib/config', () => ({
  getConfig: () => getConfig(),
}));

const loadSavedSecrets = vi.fn<() => Record<string, string>>(() => ({}));
const persistSingleSecret = vi.fn<(n: string, v: string) => Promise<boolean>>(async () => true);
vi.mock('./savedSecrets', () => ({
  loadSavedSecrets: () => loadSavedSecrets(),
  persistSingleSecret: (n: string, v: string) => persistSingleSecret(n, v),
}));

import { assembleManifest } from './manifestAssembler';

/** Minimal pod yaml carrying the dependency annotation + a `{{VAR}}`. */
function tmplYaml(name: string, deps: string[], extra = ''): string {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  annotations:
    servicebay.label: "${name} label"
${deps.length ? `    servicebay.dependencies: "${deps.join(',')}"` : ''}
spec:
  hostNetwork: true
  containers:
  - name: ${name}
    image: example/${name}:latest
${extra}
`;
}

beforeEach(() => {
  getTemplateYaml.mockReset();
  getTemplateVariables.mockReset();
  getTemplateConfigFiles.mockReset();
  getTemplateConfigFiles.mockResolvedValue([]);
  getTemplateAssetFiles.mockReset();
  getTemplateAssetFiles.mockResolvedValue([]);
  getTemplateSettingsSchema.mockReset();
  getTemplateSettingsSchema.mockResolvedValue({});
  getConfig.mockReset();
  getConfig.mockResolvedValue({ templateSettings: {} });
  loadSavedSecrets.mockReset();
  loadSavedSecrets.mockReturnValue({});
  persistSingleSecret.mockReset();
  persistSingleSecret.mockResolvedValue(true);
});

describe('assembleManifest', () => {
  it('omitting templateSource walks every registry (undefined), not a pinned Built-in (#1177)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({});

    await assembleManifest({ items: [{ name: 'svc', checked: true }] });

    // undefined → getTemplateYaml/getTemplateVariables walk registries then
    // fall back to built-in; a pinned 'Built-in' would skip externals (the bug).
    expect(getTemplateYaml).toHaveBeenCalledWith('svc', undefined);
    expect(getTemplateVariables).toHaveBeenCalledWith('svc', undefined);
  });

  it('builds items with parsed dependencies and the fetched yaml', async () => {
    getTemplateYaml.mockImplementation(async (n) =>
      n === 'auth' ? tmplYaml('auth', []) : tmplYaml('media', ['auth', 'nginx']),
    );
    getTemplateVariables.mockResolvedValue({});

    const r = await assembleManifest({
      items: [
        { name: 'auth', checked: true },
        { name: 'media', checked: true },
      ],
      templateSource: 'Built-in',
    });

    const media = r.items.find(i => i.name === 'media')!;
    expect(media.dependencies).toEqual(['auth', 'nginx']);
    expect(media.yaml).toContain('kind: Pod');
    expect(r.items.find(i => i.name === 'auth')!.dependencies).toEqual([]);
  });

  it('resolves a variable from its template default', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      SVC_PORT: { type: 'text', default: '8080' },
    });
    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(r.variables.find(v => v.name === 'SVC_PORT')?.value).toBe('8080');
  });

  it('lets prefilled values win over defaults and marks them global', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      PUBLIC_DOMAIN: { type: 'text', default: 'fallback.example' },
    });
    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      prefilled: { PUBLIC_DOMAIN: 'dopp.cloud' },
      templateSource: 'Built-in',
    });
    const v = r.variables.find(x => x.name === 'PUBLIC_DOMAIN')!;
    expect(v.value).toBe('dopp.cloud');
    expect(v.global).toBe(true);
  });

  it('pre-fills PUBLIC_DOMAIN from reverseProxy.publicDomain when templateSettings is empty (#1252)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{PUBLIC_DOMAIN}}'));
    getTemplateVariables.mockResolvedValue({ PUBLIC_DOMAIN: { type: 'text' } });
    getConfig.mockResolvedValue({ templateSettings: {}, reverseProxy: { publicDomain: 'dopp.cloud' } });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    const v = r.variables.find(x => x.name === 'PUBLIC_DOMAIN')!;
    expect(v.value).toBe('dopp.cloud');
    expect(v.global).toBe(true);
  });

  it('templateSettings / prefilled PUBLIC_DOMAIN wins over reverseProxy.publicDomain', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{PUBLIC_DOMAIN}}'));
    getTemplateVariables.mockResolvedValue({ PUBLIC_DOMAIN: { type: 'text' } });
    getConfig.mockResolvedValue({
      templateSettings: { PUBLIC_DOMAIN: 'settings.example' },
      reverseProxy: { publicDomain: 'dopp.cloud' },
    });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(r.variables.find(x => x.name === 'PUBLIC_DOMAIN')?.value).toBe('settings.example');
  });

  it('injects help text for PUBLIC_DOMAIN when the template declares no description (#1252)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{PUBLIC_DOMAIN}}'));
    getTemplateVariables.mockResolvedValue({ PUBLIC_DOMAIN: { type: 'text' } });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    const v = r.variables.find(x => x.name === 'PUBLIC_DOMAIN')!;
    expect((v.meta as VariableMeta | undefined)?.description).toMatch(/base public domain/i);
  });

  it('does not override an existing PUBLIC_DOMAIN description', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{PUBLIC_DOMAIN}}'));
    getTemplateVariables.mockResolvedValue({
      PUBLIC_DOMAIN: { type: 'text', description: 'Template-specific help' },
    });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect((r.variables.find(x => x.name === 'PUBLIC_DOMAIN')?.meta as VariableMeta | undefined)?.description).toBe('Template-specific help');
  });

  it('auto-injects PUBLIC_DOMAIN when a template has a subdomain var but never references {{PUBLIC_DOMAIN}} (#2144)', async () => {
    // The YAML deliberately references NO {{PUBLIC_DOMAIN}} — only a
    // type:subdomain variable declared in meta. Before the fix,
    // PUBLIC_DOMAIN was absent from the manifest, buildProxyHosts got
    // domain=undefined, and the proxy host was silently dropped.
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{SVC_SUBDOMAIN}}'));
    getTemplateVariables.mockResolvedValue({
      SVC_SUBDOMAIN: { type: 'subdomain', default: 'svc', exposure: 'public', proxyPort: '8080' },
    });
    getConfig.mockResolvedValue({ templateSettings: {}, reverseProxy: { publicDomain: 'dopp.cloud' } });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    const v = r.variables.find(x => x.name === 'PUBLIC_DOMAIN')!;
    expect(v).toBeDefined();
    expect(v.value).toBe('dopp.cloud');
    expect(v.global).toBe(true);
  });

  it('does not add PUBLIC_DOMAIN when there is no subdomain var and no reference (#2144)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({ SVC_PORT: { type: 'text', default: '8080' } });
    getConfig.mockResolvedValue({ templateSettings: {}, reverseProxy: { publicDomain: 'dopp.cloud' } });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(r.variables.find(x => x.name === 'PUBLIC_DOMAIN')).toBeUndefined();
  });

  it('generates and persists a fresh secret when none is saved', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      SVC_SECRET: { type: 'secret' },
    });
    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    const secret = r.variables.find(v => v.name === 'SVC_SECRET')!;
    expect(secret.value).toMatch(/.{16,}/);
    expect(persistSingleSecret).toHaveBeenCalledWith('SVC_SECRET', secret.value);
  });

  it('reuses a saved secret instead of generating a new one', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({ SVC_SECRET: { type: 'secret' } });
    loadSavedSecrets.mockReturnValue({ SVC_SECRET: 'reused-from-disk' });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(r.variables.find(v => v.name === 'SVC_SECRET')?.value).toBe('reused-from-disk');
    expect(persistSingleSecret).not.toHaveBeenCalled();
  });

  it('partial prefilled preserves stored secrets omitted from the map (#2206)', async () => {
    // A partial install_template that supplies only ONE new variable must NOT
    // wipe the other stored secrets to empty — that silently took HA + Jellyfin
    // offline on the solaris service (2026-07-11).
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      HASS_TOKEN: { type: 'secret', noAutoGenerate: true },
      JELLYFIN_PASSWORD: { type: 'secret', noAutoGenerate: true },
      VAPID_PUBLIC: { type: 'secret', noAutoGenerate: true },
    });
    loadSavedSecrets.mockReturnValue({ HASS_TOKEN: 'ha-tok', JELLYFIN_PASSWORD: 'jf-pw' });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      prefilled: { VAPID_PUBLIC: 'new-vapid-pub' }, // only the new var supplied
      templateSource: 'Built-in',
    });

    // Omitted secrets keep their stored value, not empty.
    expect(r.variables.find(v => v.name === 'HASS_TOKEN')?.value).toBe('ha-tok');
    expect(r.variables.find(v => v.name === 'JELLYFIN_PASSWORD')?.value).toBe('jf-pw');
    // The supplied var wins.
    expect(r.variables.find(v => v.name === 'VAPID_PUBLIC')?.value).toBe('new-vapid-pub');
  });

  it('an explicit empty prefilled value does not clobber a stored secret (#2206)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({ SVC_SECRET: { type: 'secret' } });
    loadSavedSecrets.mockReturnValue({ SVC_SECRET: 'stored-value' });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      prefilled: { SVC_SECRET: '' }, // explicitly empty — must fall back to stored
      templateSource: 'Built-in',
    });

    expect(r.variables.find(v => v.name === 'SVC_SECRET')?.value).toBe('stored-value');
  });

  it('always resolves LLDAP_HOST to localhost', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{LLDAP_HOST}}'));
    getTemplateVariables.mockResolvedValue({});
    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(r.variables.find(v => v.name === 'LLDAP_HOST')?.value).toBe('localhost');
  });

  it('skips a template whose yaml cannot be loaded', async () => {
    getTemplateYaml.mockResolvedValue(null);
    getTemplateVariables.mockResolvedValue({});
    const r = await assembleManifest({
      items: [{ name: 'ghost', checked: true }],
      templateSource: 'Built-in',
    });
    // The item is still listed, just without a resolved yaml.
    expect(r.items).toHaveLength(1);
    expect(r.items[0].yaml).toBeUndefined();
  });
});
