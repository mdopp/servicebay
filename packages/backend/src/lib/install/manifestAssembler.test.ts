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

const getConfig = vi.fn<() => Promise<{ templateSettings?: Record<string, string> }>>();
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
