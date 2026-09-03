import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { apiFetch, isAnonymousPathname } from '@servicebay/api-client';

/**
 * #2736 Phase 2 — there is exactly ONE client-side 401 → /login handler.
 *
 * Before this, three things claimed the job: a global `window.fetch`
 * monkey-patch installed as an import-time side effect of
 * DigitalTwinProvider.tsx, `apiFetch` (which had zero callers), and a
 * duplicated ANONYMOUS_PATHS set in useSocket.ts. The patch is what made the
 * other two look optional — it covered every raw fetch silently, so nothing
 * ever pushed a call site onto the real seam.
 *
 * These specs pin the Phase-2 shape so it cannot quietly grow a second handler
 * back: the monkey-patch stays deleted, the path guard has one definition, and
 * apiFetch redirects on a non-anonymous 401 while staying put on an anonymous
 * one.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf-8');

describe('#2736 — the global window.fetch monkey-patch is gone', () => {
  it('importing DigitalTwinProvider leaves window.fetch untouched', async () => {
    const before = window.fetch;
    // The patch was an import-time side effect at module scope, so merely
    // loading the module is the whole reproduction.
    await import('@/providers/DigitalTwinProvider');
    expect(window.fetch).toBe(before);
  });

  it('DigitalTwinProvider.tsx assigns window.fetch nowhere', () => {
    const src = read('packages/frontend/src/providers/DigitalTwinProvider.tsx');
    expect(src).not.toMatch(/window\.fetch\s*=/);
  });

  it('useSocket.ts keeps no second copy of the anonymous-path set', () => {
    const src = read('packages/frontend/src/hooks/useSocket.ts');
    // One definition, imported — not a set "kept in sync" by comment. The
    // needle is the *declaration*: the file's history comment may name the
    // removed constant, and a prose mention is not a second copy.
    expect(src).not.toMatch(/(?:const|let|var)\s+ANONYMOUS_PATHS/);
    expect(src).not.toMatch(/ANONYMOUS_PATHS\s*\.\s*has/);
    expect(src).toMatch(/isAnonymousPathname/);
    expect(src).toMatch(/from '@servicebay\/api-client'/);
  });
});

describe('#2736 — isAnonymousPathname is the one shared guard', () => {
  it.each(['/login', '/portal', '/portal/family', '/portal/anything/deep'])(
    'treats %s as anonymous',
    p => expect(isAnonymousPathname(p)).toBe(true),
  );

  it.each(['/services', '/settings', '/', '/portalish'])('treats %s as admin-flavored', p =>
    expect(isAnonymousPathname(p)).toBe(false),
  );
});

describe('#2736 — apiFetch is the 401 handler, and only for opted-in callers', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalLocation: Location;
  let assignedHref: string | null;

  function setPathname(pathname: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy({} as Location, {
        get: (_t, prop) => {
          if (prop === 'pathname') return pathname;
          if (prop === 'origin') return 'http://localhost:5888';
          return undefined;
        },
        set: (_t, prop, value) => {
          if (prop === 'href') assignedHref = value;
          return true;
        },
      }),
    });
  }

  beforeEach(() => {
    assignedHref = null;
    originalLocation = window.location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('401 on a non-anonymous route redirects to /login', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBe('/login');
  });

  it('401 on an anonymous route does NOT redirect', async () => {
    setPathname('/portal/family');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await apiFetch('/api/services');
    expect(assignedHref).toBeNull();
  });

  it('a RAW fetch that 401s does not redirect — that is the ratchet pressure', async () => {
    setPathname('/services');
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    // Deliberately not apiFetch. With the monkey-patch gone this call site
    // silently loses session-expiry handling, which is exactly why
    // `sb/no-raw-api-fetch` counts it and the ratchet forbids the count rising.
    await fetch('/api/services');
    expect(assignedHref).toBeNull();
  });
});
