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

const loadSavedVariables = vi.fn<() => Record<string, string>>(() => ({}));
vi.mock('./savedVariables', () => ({
  loadSavedVariables: () => loadSavedVariables(),
}));

// #2673 — a `mintApiToken` secret asks the assembler for a REAL ServiceBay
// token instead of a random string. Mocked so the test can count mints and
// inspect the scope/expiry the assembler asked for.
const createToken = vi.fn<(i: {
  name: string;
  scopes: string[];
  neverExpires?: boolean;
  createdBy: string;
}) => Promise<{ token: unknown; secret: string }>>();
vi.mock('@/lib/auth/apiTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/apiTokens')>()),
  createToken: (i: Parameters<typeof createToken>[0]) => createToken(i),
}));

import { assembleManifest, deriveLdapBaseDn } from './manifestAssembler';
import {
  DEFAULT_SECRET_LENGTH,
  DEVICE_SAFE_SECRET_LENGTH,
} from '@/lib/stackInstall/randomSecret';

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
  loadSavedVariables.mockReset();
  loadSavedVariables.mockReturnValue({});
  createToken.mockReset();
  let minted = 0;
  // #2711 — the mocked secret must carry the REAL wire form,
  // `sb_<8 hex>_<[A-Z2-9]+>`: the assembler now re-mints a stored value that
  // lacks it, so a per-mint marker containing a `0` or a `1` (outside that
  // alphabet) would make the idempotency case mint twice and read as a
  // regression that isn't one. MINT_MARKS is inside the alphabet.
  const MINT_MARKS = 'ABCDEFGHJK';
  createToken.mockImplementation(async () => {
    minted += 1;
    return {
      token: {},
      secret: `sb_abcdef0${minted}_MINTEDSECRET${MINT_MARKS[minted % MINT_MARKS.length]}`,
    };
  });
});

describe('assembleManifest — operator-set variable reuse (#2531)', () => {
  it('restores an operator-set text value that the template defaults to empty', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('solaris', []));
    getTemplateVariables.mockResolvedValue({ VAPID_PUBLIC_KEY: { type: 'text', default: '' } });
    loadSavedVariables.mockReturnValue({ VAPID_PUBLIC_KEY: 'BKxOperatorSetKey' });

    const r = await assembleManifest({ items: [{ name: 'solaris', checked: true }] });

    expect(r.variables.find(v => v.name === 'VAPID_PUBLIC_KEY')?.value).toBe('BKxOperatorSetKey');
  });

  it('ranks the operator value above the template default, and prefilled above both', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      PORT: { type: 'text', default: '8080' },
      OTHER: { type: 'text', default: '1' },
    });
    loadSavedVariables.mockReturnValue({ PORT: '9000', OTHER: '2' });

    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      prefilled: { OTHER: '3' },
    });

    expect(r.variables.find(v => v.name === 'PORT')?.value).toBe('9000');
    expect(r.variables.find(v => v.name === 'OTHER')?.value).toBe('3');
  });

  it('leaves a variable the operator never set on the template default', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({ PORT: { type: 'text', default: '8080' } });
    loadSavedVariables.mockReturnValue({});

    const r = await assembleManifest({ items: [{ name: 'svc', checked: true }] });

    expect(r.variables.find(v => v.name === 'PORT')?.value).toBe('8080');
  });
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

  it('resolves PUBLIC_DOMAIN when NO template declares it and the global has an empty default (#2425)', async () => {
    // Post-#2425 shape: PUBLIC_DOMAIN lives once in templates/settings.json
    // with `default: ""` (LAN_IP's precedent), and no template's
    // variables.json redeclares it. Both wizard paths must still land a
    // value — the prefill (OnboardingWizard passes `stackDomain`) and the
    // reverseProxy fallback — and neither may be a hardcoded domain.
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{PUBLIC_DOMAIN}}'));
    getTemplateVariables.mockResolvedValue({});
    getTemplateSettingsSchema.mockResolvedValue({
      PUBLIC_DOMAIN: { default: '', description: 'Base public domain for this box' },
    });
    getConfig.mockResolvedValue({ templateSettings: {} });

    const prefill = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      prefilled: { PUBLIC_DOMAIN: 'stack.example' },
      templateSource: 'Built-in',
    });
    const fromWizard = prefill.variables.find(v => v.name === 'PUBLIC_DOMAIN')!;
    expect(fromWizard.value).toBe('stack.example');
    expect(fromWizard.global).toBe(true);

    getConfig.mockResolvedValue({ templateSettings: {}, reverseProxy: { publicDomain: 'box.example' } });
    const fallback = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(fallback.variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value).toBe('box.example');

    // Nothing configured anywhere → empty, never a leftover default. An
    // empty PUBLIC_DOMAIN is the documented LAN-only mode (UX_PHILOSOPHY).
    getConfig.mockResolvedValue({ templateSettings: {} });
    const bare = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    expect(bare.variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value).toBe('');
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

  // #2577 — a value the operator carries into a device's own credential field
  // is generated shorter, because consumer firmware caps that field and keeps
  // the prefix; the device then reports a correct password as "wrong".
  it('generates a deviceSafe secret at the device-safe length, still alphanumeric', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('svc', []));
    getTemplateVariables.mockResolvedValue({
      MQTT_PASSWORD: { type: 'secret', deviceSafe: true },
      SVC_SECRET: { type: 'secret' },
    });
    const r = await assembleManifest({
      items: [{ name: 'svc', checked: true }],
      templateSource: 'Built-in',
    });
    const device = r.variables.find(v => v.name === 'MQTT_PASSWORD')!.value;
    const normal = r.variables.find(v => v.name === 'SVC_SECRET')!.value;
    expect(device).toHaveLength(DEVICE_SAFE_SECRET_LENGTH);
    expect(device).toMatch(/^[a-zA-Z0-9]+$/);
    // The flag changes ONLY the length — the alphabet is platform-wide.
    expect(normal).toHaveLength(DEFAULT_SECRET_LENGTH);
    expect(normal).toMatch(/^[a-zA-Z0-9]+$/);
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

  // ── #2439: LLDAP_BASE_DN derives from the public domain ────────────────
  // The four LDAP-consuming templates used to ship the maintainer's own DN as
  // their variables.json default. They now declare it empty and the assembler
  // fills it — but ONLY when empty, because the DN roots a live LDAP tree.
  describe('LLDAP_BASE_DN derivation (#2439)', () => {
    const ldapYaml = () => tmplYaml('svc', [], '    # {{LLDAP_BASE_DN}} {{PUBLIC_DOMAIN}}');

    it('derives the base DN from PUBLIC_DOMAIN', async () => {
      getTemplateYaml.mockResolvedValue(ldapYaml());
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        prefilled: { PUBLIC_DOMAIN: 'example.com' },
        templateSource: 'Built-in',
      });
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=example,dc=com');
    });

    it('handles a multi-label domain', async () => {
      getTemplateYaml.mockResolvedValue(ldapYaml());
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        prefilled: { PUBLIC_DOMAIN: 'box.example.co.uk' },
        templateSource: 'Built-in',
      });
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value)
        .toBe('dc=box,dc=example,dc=co,dc=uk');
    });

    it('falls back to dc=local on a LAN-only box with no public domain', async () => {
      getTemplateYaml.mockResolvedValue(ldapYaml());
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        templateSource: 'Built-in',
      });
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=local');
    });

    it('reads the box domain from config when no template references PUBLIC_DOMAIN', async () => {
      // claude-dev consumes LDAP but publishes no proxy host, so PUBLIC_DOMAIN
      // never joins `variables` — the DN must still match the auth stack's.
      getTemplateYaml.mockResolvedValue(tmplYaml('svc', [], '    # {{LLDAP_BASE_DN}}'));
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      getConfig.mockResolvedValue({ templateSettings: {}, reverseProxy: { publicDomain: 'example.com' } });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        templateSource: 'Built-in',
      });
      expect(r.variables.map(v => v.name)).not.toContain('PUBLIC_DOMAIN');
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=example,dc=com');
    });

    it('never overwrites an explicit base DN — an existing install keeps its tree', async () => {
      getTemplateYaml.mockResolvedValue(ldapYaml());
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      // Operator's stored Template Settings value, on a box that also has a
      // public domain the derivation would otherwise produce a DN from.
      getConfig.mockResolvedValue({
        templateSettings: { LLDAP_BASE_DN: 'dc=legacy,dc=tree' },
        reverseProxy: { publicDomain: 'example.com' },
      });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        templateSource: 'Built-in',
      });
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=legacy,dc=tree');
    });

    it('normalises the shapes an operator can type into the domain field', () => {
      expect(deriveLdapBaseDn('Example.COM')).toBe('dc=example,dc=com');
      expect(deriveLdapBaseDn(' example.com. ')).toBe('dc=example,dc=com');
      expect(deriveLdapBaseDn('https://example.com/')).toBe('dc=example,dc=com');
      expect(deriveLdapBaseDn('')).toBe('dc=local');
      expect(deriveLdapBaseDn(undefined)).toBe('dc=local');
      // Nothing usable left after dropping non-label junk → LAN fallback,
      // never a malformed DN.
      expect(deriveLdapBaseDn('...')).toBe('dc=local');
    });

    it('never overwrites a base DN supplied by the caller', async () => {
      getTemplateYaml.mockResolvedValue(ldapYaml());
      getTemplateVariables.mockResolvedValue({ LLDAP_BASE_DN: { type: 'text', default: '' } });
      const r = await assembleManifest({
        items: [{ name: 'svc', checked: true }],
        prefilled: { PUBLIC_DOMAIN: 'example.com', LLDAP_BASE_DN: 'dc=legacy,dc=tree' },
        templateSource: 'Built-in',
      });
      expect(r.variables.find(v => v.name === 'LLDAP_BASE_DN')?.value).toBe('dc=legacy,dc=tree');
    });
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

// ─── mintApiToken: ServiceBay's own credential, generated like any other ────
describe('assembleManifest — mintApiToken (#2673)', () => {
  const tokenVars: Record<string, VariableMeta> = {
    SERVICEBAY_MCP_TOKEN: { type: 'secret', mintApiToken: true },
  };

  it('mints a real token for a blank mintApiToken secret — no operator step', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    const r = await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      templateSource: 'Built-in',
    });

    const v = r.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN');
    expect(v?.value).toMatch(/^sb_/);
    expect(createToken).toHaveBeenCalledTimes(1);
  });

  it('the minted token carries the read scope only and never expires', async () => {
    // Acceptance 2. The route's `neverExpiresScopesAreReadOnly` guard only
    // covers the HTTP path; the assembler calls the model directly, so the
    // same fail-closed pair has to be asserted here.
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      templateSource: 'Built-in',
    });

    const arg = createToken.mock.calls[0][0];
    expect(arg.scopes).toEqual(['read']);
    expect(arg.neverExpires).toBe(true);
    expect(arg.name).toContain('claude-dev');
  });

  it('persists the minted plaintext like any other generated secret', async () => {
    // This is what makes the re-install idempotent (see the counting test).
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    const r = await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      templateSource: 'Built-in',
    });

    expect(persistSingleSecret).toHaveBeenCalledWith(
      'SERVICEBAY_MCP_TOKEN',
      r.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')!.value,
    );
  });

  it('a second install run mints NO second token — counted, not asserted', async () => {
    // Acceptance 4. `loadSavedSecrets`/`persistSingleSecret` are wired to a
    // real in-memory store here so run 2 sees what run 1 wrote; a mint that
    // bypassed the store would show up as a second createToken call.
    const store: Record<string, string> = {};
    loadSavedSecrets.mockImplementation(() => ({ ...store }));
    persistSingleSecret.mockImplementation(async (n: string, v: string) => {
      store[n] = v;
      return true;
    });
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    const run = () =>
      assembleManifest({ items: [{ name: 'claude-dev', checked: true }], templateSource: 'Built-in' });

    const first = await run();
    const mintsAfterFirst = createToken.mock.calls.length;
    const second = await run();

    expect(mintsAfterFirst).toBe(1);
    expect(createToken.mock.calls.length).toBe(1); // unchanged by run 2
    expect(second.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')?.value)
      .toBe(first.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')?.value);
  });

  it('an operator-supplied value wins and nothing is minted', async () => {
    // Acceptance 3 — someone deliberately pasting a shared/narrower token.
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    const r = await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      prefilled: { SERVICEBAY_MCP_TOKEN: 'sb_operator_own' },
      templateSource: 'Built-in',
    });

    expect(r.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')?.value).toBe('sb_operator_own');
    expect(createToken).not.toHaveBeenCalled();
  });

  it('never mints in a preview resolve (#2537)', async () => {
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);

    const r = await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      templateSource: 'Built-in',
      preview: true,
    });

    expect(r.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')?.value).toBe('');
    expect(createToken).not.toHaveBeenCalled();
  });

  it('a failed mint leaves the value EMPTY, never a random string', async () => {
    // A random string in an API-token slot is the #1002 failure mode: it
    // authenticates as nothing and fails on every single call.
    getTemplateYaml.mockResolvedValue(tmplYaml('claude-dev', [], '    # {{SERVICEBAY_MCP_TOKEN}}'));
    getTemplateVariables.mockResolvedValue(tokenVars);
    createToken.mockRejectedValue(new Error('token store unwritable'));

    const r = await assembleManifest({
      items: [{ name: 'claude-dev', checked: true }],
      templateSource: 'Built-in',
    });

    expect(r.variables.find(x => x.name === 'SERVICEBAY_MCP_TOKEN')?.value).toBe('');
    expect(persistSingleSecret).not.toHaveBeenCalledWith('SERVICEBAY_MCP_TOKEN', expect.anything());
  });
});
