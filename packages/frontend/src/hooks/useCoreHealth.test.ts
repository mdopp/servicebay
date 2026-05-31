/**
 * useCoreHealth — the shared core-stack readiness signal behind both the
 * CoreHealthBanner and the Home dashboard's health headline (so the two
 * can't disagree, as they did in the "auth unhealthy" vs "Everything
 * looks healthy" contradiction).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCoreHealth } from './useCoreHealth';

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
beforeEach(() => { vi.restoreAllMocks(); });

describe('useCoreHealth', () => {
  it('flags unhealthy when a core stack has an unhealthy template', async () => {
    global.fetch = mockFetch({
      degraded: [{ stack: 'auth', label: 'Core services', notReady: [{ template: 'authelia', state: 'unhealthy' }] }],
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCoreHealth());
    await waitFor(() => expect(result.current.unhealthy).toBe(true));
    expect(result.current.labels).toContain('Core services');
  });

  it('does NOT flag unhealthy for pure unknown (no healthcheck annotation)', async () => {
    global.fetch = mockFetch({
      degraded: [{ stack: 'media', label: 'Media', notReady: [{ template: 'jellyfin', state: 'unknown' }] }],
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useCoreHealth());
    await waitFor(() => expect(result.current.degraded.length).toBe(1));
    expect(result.current.unhealthy).toBe(false);
  });

  it('is healthy when nothing is degraded', async () => {
    global.fetch = mockFetch({ degraded: [] }) as unknown as typeof fetch;
    const { result } = renderHook(() => useCoreHealth());
    await waitFor(() => expect(result.current.unhealthy).toBe(false));
  });
});
