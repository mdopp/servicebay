/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the server-action layer the hook calls into. Each test overrides
// these per scenario.
vi.mock('@/app/actions', () => ({
  fetchTemplateYaml: vi.fn(),
  fetchTemplateVariables: vi.fn(),
  fetchTemplateConfigFiles: vi.fn(),
  fetchTemplatePostDeployScript: vi.fn(),
}));

vi.mock('@/lib/templateLabel', () => ({
  parseTemplateLabel: (yaml: string) => {
    const m = yaml.match(/servicebay\.label["']?:\s*["']?([^"'\n]+)["']?/);
    return m ? m[1].trim() : undefined;
  },
}));

// The streaming install loop renders YAML/config via Mustache. Tests
// don't care about real template substitution — a naive replace is
// enough to verify the deploy POST body shape.
vi.mock('mustache', () => ({
  default: {
    render: (tmpl: string, view: Record<string, string>) => {
      let out = tmpl;
      for (const [k, v] of Object.entries(view)) {
        out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
      }
      return out;
    },
    escape: (s: string) => s,
  },
}));

import {
  fetchTemplateYaml,
  fetchTemplateVariables,
  fetchTemplateConfigFiles,
  fetchTemplatePostDeployScript,
} from '@/app/actions';
import { useStackInstall } from '@/hooks/useStackInstall';

/**
 * Build a `fetch` mock that resolves URL-prefixed handlers. Each
 * handler returns either `{ ok, jsonBody }` for a plain JSON response
 * or `{ ok, streamLines }` for an NDJSON stream.
 */
function buildFetchMock(
  handlers: Record<string, (init?: RequestInit) => {
    ok?: boolean;
    status?: number;
    jsonBody?: any;
    streamLines?: string[];
  }>,
) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix) || url.includes(prefix)) {
        const result = handler(init);
        const ok = result.ok ?? true;
        const status = result.status ?? (ok ? 200 : 500);
        if (result.streamLines !== undefined) {
          const encoded = new TextEncoder().encode(result.streamLines.join('\n') + '\n');
          let consumed = false;
          return Promise.resolve({
            ok,
            status,
            body: {
              getReader: () => ({
                read: () => {
                  if (consumed) return Promise.resolve({ done: true, value: undefined });
                  consumed = true;
                  return Promise.resolve({ done: false, value: encoded });
                },
              }),
            },
            json: () => Promise.resolve(result.jsonBody ?? {}),
          });
        }
        return Promise.resolve({
          ok,
          status,
          json: () => Promise.resolve(result.jsonBody ?? {}),
        });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

describe('useStackInstall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startConfigure — variable resolution', () => {
    it('resolves defaults, secrets, and caller-prefilled globals', async () => {
      (fetchTemplateYaml as any).mockResolvedValue(
        'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n  containers:\n  - name: web\n    env:\n    - name: DOMAIN\n      value: "{{PUBLIC_DOMAIN}}"\n    - name: SECRET\n      value: "{{API_SECRET}}"\n    - name: LDAP\n      value: "{{LLDAP_HOST}}"',
      );
      (fetchTemplateVariables as any).mockResolvedValue({
        PUBLIC_DOMAIN: { type: 'text', description: 'Public domain' },
        API_SECRET: { type: 'secret', description: 'API secret' },
        LLDAP_HOST: { type: 'text', description: 'LDAP host' },
      });
      (fetchTemplateConfigFiles as any).mockResolvedValue([]);
      global.fetch = buildFetchMock({
        '/api/settings': () => ({ jsonBody: { templateSettings: {} } }),
      });

      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );

      await act(async () => {
        await result.current.startConfigure(
          [{ name: 'web', checked: true }],
          { PUBLIC_DOMAIN: 'example.com' },
        );
      });

      expect(result.current.phase).toBe('configure');
      const pubDomain = result.current.variables.find(v => v.name === 'PUBLIC_DOMAIN');
      expect(pubDomain?.value).toBe('example.com');
      expect(pubDomain?.global).toBe(true);
      const lldap = result.current.variables.find(v => v.name === 'LLDAP_HOST');
      expect(lldap?.value).toBe('localhost');
      expect(lldap?.global).toBe(true);
      const apiSecret = result.current.variables.find(v => v.name === 'API_SECRET');
      // Secret was auto-generated. Length should match the
      // generateRandomSecret default of 32 alnum chars.
      expect(apiSecret?.value).toMatch(/^[A-Za-z0-9]{32}$/);
    });

    it('derives VAULTWARDEN_DOMAIN from subdomain + public domain', async () => {
      (fetchTemplateYaml as any).mockResolvedValue(
        'apiVersion: v1\nkind: Pod\nmetadata:\n  name: vw\nspec:\n  containers:\n  - name: vw\n    env:\n    - name: PUBLIC_DOMAIN\n      value: "{{PUBLIC_DOMAIN}}"\n    - name: SUB\n      value: "{{VAULTWARDEN_SUBDOMAIN}}"\n    - name: DOMAIN\n      value: "{{VAULTWARDEN_DOMAIN}}"',
      );
      (fetchTemplateVariables as any).mockResolvedValue({
        PUBLIC_DOMAIN: { type: 'text' },
        VAULTWARDEN_SUBDOMAIN: { type: 'subdomain', default: 'vault' },
        VAULTWARDEN_DOMAIN: { type: 'text' },
      });
      (fetchTemplateConfigFiles as any).mockResolvedValue([]);
      global.fetch = buildFetchMock({
        '/api/settings': () => ({ jsonBody: { templateSettings: {} } }),
      });

      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      await act(async () => {
        await result.current.startConfigure(
          [{ name: 'vw', checked: true }],
          { PUBLIC_DOMAIN: 'example.com' },
        );
      });

      const vw = result.current.variables.find(v => v.name === 'VAULTWARDEN_DOMAIN');
      expect(vw?.value).toBe('https://vault.example.com');
      expect(vw?.global).toBe(true);
    });

    it('strips mustache section tags before resolving config file paths', async () => {
      // A YAML with section tags would normally crash js-yaml. The hook
      // strips `{{#OPT}} ... {{/OPT}}` before parsing so volumes still
      // resolve and the `.mustache` config file lands in /config.
      (fetchTemplateYaml as any).mockResolvedValue(
        `apiVersion: v1
kind: Pod
metadata:
  name: hass
spec:
  containers:
  - name: hass
    volumeMounts:
    - mountPath: /config
      name: cfg
    {{#TRUSTED_PROXIES}}
    - mountPath: /extra
      name: extra
    {{/TRUSTED_PROXIES}}
  volumes:
  - name: cfg
    hostPath:
      path: /mnt/data/stacks/hass/config
  - name: extra
    hostPath:
      path: /mnt/data/stacks/hass/extra
`,
      );
      (fetchTemplateVariables as any).mockResolvedValue({
        TRUSTED_PROXIES: { type: 'text' },
      });
      (fetchTemplateConfigFiles as any).mockResolvedValue([
        { filename: 'configuration.yaml', content: 'something: {{TRUSTED_PROXIES}}' },
      ]);
      global.fetch = buildFetchMock({
        '/api/settings': () => ({ jsonBody: { templateSettings: {} } }),
      });

      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      await act(async () => {
        await result.current.startConfigure(
          [{ name: 'hass', checked: true }],
          {},
        );
      });

      // Config file should have its targetPath resolved despite the section
      // tags. If section-stripping regressed, the volume map would be
      // empty and targetPath would be undefined.
      expect(result.current.items[0].configFiles?.[0].targetPath).toBe(
        '/mnt/data/stacks/hass/config/configuration.yaml',
      );
    });
  });




  describe('reset', () => {
    it('returns the hook to idle with empty state', async () => {
      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      act(() => {
        result.current.setCleanInstall(true);
        result.current.setCleanInstallConfirm('RESET');
        result.current.appendLog('something');
      });
      expect(result.current.logs).toEqual(['something']);
      act(() => result.current.reset());
      expect(result.current.phase).toBe('idle');
      expect(result.current.logs).toEqual([]);
      expect(result.current.cleanInstall).toBe(false);
      expect(result.current.cleanInstallConfirm).toBe('');
    });
  });

  describe('referential stability — no-op writes preserve array reference', () => {
    // Regression guard for the wizard device-poll runaway loop. The
    // OnboardingWizard's "fetch USB devices" effect depends on
    // `stackVariables` (the hook's `variables`). Pre-refactor (v3.19.1)
    // the wizard owned variables state and used `prev.map → changed ? next : prev`
    // so no-op writes returned the same array reference. The v3.19.2
    // refactor moved state into this hook but the new setter always
    // allocated a new array, which made the effect re-fire on every
    // render and hammered `/api/system/devices` at ~90Hz during install
    // — saturating the browser HTTP pool and causing intermittent
    // `Failed to fetch` on the streaming `/api/services` POST.
    //
    // The contract: `setVariableValue(name, sameValue)` and
    // `setItemChecked(name, sameChecked)` MUST NOT change the array
    // reference. Any future refactor that breaks this regresses the
    // wizard's install reliability.
    it('setItemChecked keeps the same items reference when checked is unchanged', () => {
      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      act(() => {
        result.current.setItems([
          { name: 'a', checked: true },
          { name: 'b', checked: false },
        ]);
      });
      const before = result.current.items;
      act(() => result.current.setItemChecked('a', true));
      expect(result.current.items).toBe(before);
      act(() => result.current.setItemChecked('unknown', true));
      expect(result.current.items).toBe(before);
      act(() => result.current.setItemChecked('a', false));
      expect(result.current.items).not.toBe(before);
      expect(result.current.items.find(i => i.name === 'a')?.checked).toBe(false);
    });

    it('setVariableValue keeps the same variables reference when value is unchanged', async () => {
      (fetchTemplateYaml as any).mockResolvedValue(
        'apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\nspec:\n  containers:\n  - name: x\n    env:\n    - name: FOO\n      value: "{{FOO}}"',
      );
      (fetchTemplateVariables as any).mockResolvedValue({
        FOO: { type: 'text', default: 'bar' },
      });
      (fetchTemplateConfigFiles as any).mockResolvedValue([]);
      (fetchTemplatePostDeployScript as any).mockResolvedValue(null);
      global.fetch = buildFetchMock({
        '/api/settings': () => ({ jsonBody: { templateSettings: {} } }),
      });

      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      await act(async () => {
        await result.current.startConfigure(
          [{ name: 'x', checked: true }],
          {},
        );
      });
      expect(result.current.variables.find(v => v.name === 'FOO')?.value).toBe('bar');

      const before = result.current.variables;
      act(() => result.current.setVariableValue('FOO', 'bar'));
      expect(result.current.variables).toBe(before);
      act(() => result.current.setVariableValue('UNKNOWN_VAR', 'whatever'));
      expect(result.current.variables).toBe(before);
      act(() => result.current.setVariableValue('FOO', 'baz'));
      expect(result.current.variables).not.toBe(before);
      expect(result.current.variables.find(v => v.name === 'FOO')?.value).toBe('baz');
    });
  });

  describe('setVariableExposure', () => {
    it('overrides exposure on subdomain variables and is a no-op on others', async () => {
      (fetchTemplateYaml as any).mockResolvedValue(
        'apiVersion: v1\nkind: Pod\nmetadata:\n  name: vw',
      );
      (fetchTemplateVariables as any).mockResolvedValue({
        VW_SUBDOMAIN: { type: 'subdomain', default: 'vault', exposure: 'public', proxyPort: '8222' },
        VW_PORT: { type: 'text', default: '8222' },
      });
      (fetchTemplateConfigFiles as any).mockResolvedValue([]);
      (fetchTemplatePostDeployScript as any).mockResolvedValue(null);
      global.fetch = buildFetchMock({
        '/api/settings': () => ({ jsonBody: { templateSettings: {} } }),
      });

      const { result } = renderHook(() => useStackInstall({ templateSource: 'Built-in' }));
      await act(async () => {
        await result.current.startConfigure([{ name: 'vw', checked: true }], {});
      });
      expect(result.current.variables.find(v => v.name === 'VW_SUBDOMAIN')?.meta?.exposure).toBe('public');

      // Override → 'lan' takes effect.
      act(() => result.current.setVariableExposure('VW_SUBDOMAIN', 'lan'));
      expect(result.current.variables.find(v => v.name === 'VW_SUBDOMAIN')?.meta?.exposure).toBe('lan');

      // Same-value write is a no-op (referential stability).
      const before = result.current.variables;
      act(() => result.current.setVariableExposure('VW_SUBDOMAIN', 'lan'));
      expect(result.current.variables).toBe(before);

      // Non-subdomain variable is ignored.
      act(() => result.current.setVariableExposure('VW_PORT', 'public'));
      expect(result.current.variables).toBe(before);
    });
  });

});
