/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStackInstall } from '@/hooks/useStackInstall';

/**
 * `useStackInstall` tests.
 *
 * Manifest assembly moved server-side (#800): `startConfigure` is now a
 * thin client over `POST /api/install/assemble`. Variable-resolution
 * coverage (defaults, secrets, VAULTWARDEN_DOMAIN derivation,
 * config-file path resolution) lives in
 * `packages/backend/src/lib/install/manifestAssembler.test.ts`. These
 * tests cover the hook's own behaviour: that it calls the assembler,
 * applies the response to hook state, and the local state setters.
 */

/** A `fetch` mock that resolves the `/api/install/assemble` call with a
 *  caller-supplied payload and answers everything else with `{}`. */
function assembleFetchMock(
  payload: { items: any[]; variables: any[] } | { error: string },
  ok = true,
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/install/assemble')) {
      return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(payload) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

describe('useStackInstall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startConfigure', () => {
    it('posts the selection to /api/install/assemble and applies the response', async () => {
      const fetchMock = assembleFetchMock({
        items: [{ name: 'web', checked: true, yaml: 'apiVersion: v1' }],
        variables: [
          { name: 'PUBLIC_DOMAIN', value: 'example.com', global: true, meta: { type: 'text' } },
          { name: 'API_SECRET', value: 'generated-secret-value', global: false, meta: { type: 'secret' } },
        ],
      });
      global.fetch = fetchMock;

      const { result } = renderHook(() => useStackInstall({ templateSource: 'Built-in' }));

      let returned: { items: unknown[]; variables: unknown[] } | undefined;
      await act(async () => {
        returned = await result.current.startConfigure(
          [{ name: 'web', checked: true }],
          { PUBLIC_DOMAIN: 'example.com' },
        );
      });

      // The hook calls the backend assembler...
      const assembleCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/api/install/assemble'));
      expect(assembleCall).toBeDefined();
      expect(assembleCall![1]).toMatchObject({ method: 'POST' });
      const body = JSON.parse(String(assembleCall![1].body));
      expect(body.items).toEqual([{ name: 'web', checked: true, alreadyInstalled: undefined }]);
      expect(body.prefilled).toEqual({ PUBLIC_DOMAIN: 'example.com' });
      expect(body.templateSource).toBe('Built-in');

      // ...and applies the assembled manifest to hook state.
      expect(result.current.phase).toBe('configure');
      expect(result.current.variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value).toBe('example.com');
      expect(result.current.variables.find(v => v.name === 'API_SECRET')?.value).toBe('generated-secret-value');
      expect(returned?.variables).toHaveLength(2);
    });

    it('surfaces an assembler failure as the error phase', async () => {
      global.fetch = assembleFetchMock({ error: 'template not found' }, false);

      const { result } = renderHook(() => useStackInstall({ templateSource: 'Built-in' }));
      await act(async () => {
        await result.current.startConfigure([{ name: 'ghost', checked: true }], {});
      });

      expect(result.current.phase).toBe('error');
      expect(result.current.error).toMatch(/template not found/);
    });
  });

  describe('reset', () => {
    it('returns the hook to idle with empty state', () => {
      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      act(() => {
        result.current.appendLog('something');
      });
      expect(result.current.logs).toEqual(['something']);
      act(() => result.current.reset());
      expect(result.current.phase).toBe('idle');
      expect(result.current.logs).toEqual([]);
    });
  });

  describe('referential stability — no-op writes preserve array reference', () => {
    // Regression guard for the wizard device-poll runaway loop. The
    // OnboardingWizard's "fetch USB devices" effect depends on
    // `variables`; a setter that allocates a new array on a no-op write
    // makes the effect re-fire every render and hammers
    // `/api/system/devices`. The contract: `setVariableValue(name,
    // sameValue)` / `setItemChecked(name, sameChecked)` MUST NOT change
    // the array reference.
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
      global.fetch = assembleFetchMock({
        items: [{ name: 'x', checked: true }],
        variables: [{ name: 'FOO', value: 'bar', global: false, meta: { type: 'text' } }],
      });

      const { result } = renderHook(() =>
        useStackInstall({ templateSource: 'Built-in' }),
      );
      await act(async () => {
        await result.current.startConfigure([{ name: 'x', checked: true }], {});
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
      global.fetch = assembleFetchMock({
        items: [{ name: 'vw', checked: true }],
        variables: [
          { name: 'VW_SUBDOMAIN', value: 'vault', global: false, meta: { type: 'subdomain', default: 'vault', exposure: 'public', proxyPort: '8222' } },
          { name: 'VW_PORT', value: '8222', global: false, meta: { type: 'text', default: '8222' } },
        ],
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
