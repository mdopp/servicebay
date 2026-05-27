import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '@servicebay/api-client';

// #1102 Phase 1 — pin the 401-redirect contract so Phase 3's
// migration sweep can swap fetch → apiFetch with confidence.

describe('apiFetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalLocation: Location;
  let assignedHref: string | null;

  beforeEach(() => {
    assignedHref = null;
    originalLocation = window.location;
    // Replace window.location with a proxy that records href assignments
    // so we can assert without actually navigating jsdom.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy({} as Location, {
        get: (_t, prop) => {
          if (prop === 'pathname') return assignedHref ?? '/services';
          if (prop === 'origin') return 'http://localhost:5888';
          if (prop === 'href') return `http://localhost:5888${assignedHref ?? '/services'}`;
          return undefined;
        },
        set: (_t, prop, value) => {
          if (prop === 'href') assignedHref = value;
          return true;
        },
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  function setPathname(pathname: string) {
    // The Proxy reads pathname from assignedHref's path; setting it via
    // a manual override is simpler.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy({} as Location, {
        get: (_t, prop) => {
          if (prop === 'pathname') return pathname;
          if (prop === 'origin') return 'http://localhost:5888';
          if (prop === 'href') return `http://localhost:5888${pathname}`;
          return undefined;
        },
        set: (_t, prop, value) => {
          if (prop === 'href') assignedHref = value;
          return true;
        },
      }),
    });
  }

  it('passes 200 responses through untouched', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const res = await apiFetch('/api/services');
    expect(res.status).toBe(200);
    expect(assignedHref).toBeNull();
  });

  it('redirects to /login on a 401 from our own /api/ URL', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBe('/login');
  });

  it('does NOT redirect when already on /login', async () => {
    setPathname('/login');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBeNull();
  });

  it('does NOT redirect when on /portal (anonymous root)', async () => {
    setPathname('/portal');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBeNull();
  });

  it('does NOT redirect when on a /portal/* subpath', async () => {
    setPathname('/portal/family');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBeNull();
  });

  it('does NOT redirect on a 401 from an external URL', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('https://example.com/some-route');
    expect(assignedHref).toBeNull();
  });

  it('handles absolute-origin /api/ URLs (treated as own)', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('http://localhost:5888/api/services');
    expect(assignedHref).toBe('/login');
  });

  it('accepts a Request object as input', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    // jsdom's Request constructor requires absolute URLs.
    await apiFetch(new Request('http://localhost:5888/api/services'));
    expect(assignedHref).toBe('/login');
  });
});
