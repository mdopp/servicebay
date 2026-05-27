// #1102 Phase 1: client-side fetch wrapper that handles 401 redirects.
//
// Replaces the global window.fetch monkey-patch in DigitalTwinProvider
// with an opt-in helper. Phase 2 removes the monkey-patch and Phase 3
// migrates raw fetch('/api/...') call sites onto this wrapper.
//
// The 401 → /login redirect logic is preserved one-to-one from the
// previous monkey-patch (DigitalTwinProvider.tsx:25-50), including:
//   - the ANONYMOUS_PATHS guard against bouncing /login or /portal
//     visitors mid-load
//   - the /portal/* subtree being anonymous-readable (the family
//     portal is intentionally world-readable)
//   - the "only redirect for our own /api/ URLs" check so a 401 from
//     an external fetch doesn't kick the user to login
//
// Server-side import is a no-op: the `typeof window === 'undefined'`
// short-circuit returns the original response unchanged so SSR / route
// handlers that pull this in transitively don't crash on `window.*`.
// For JSON validation paired with the fetch, use the sibling
// `typedFetch` — apiFetch is the Response-returning baseline.

const ANONYMOUS_PATHS = new Set(['/login', '/portal']);

function isAnonymousPathname(pathname: string): boolean {
  return ANONYMOUS_PATHS.has(pathname) || pathname.startsWith('/portal/');
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return '';
}

function isOwnApiUrl(url: string): boolean {
  if (url.startsWith('/api/')) return true;
  if (typeof window === 'undefined') return false;
  return url.startsWith(`${window.location.origin}/api/`);
}

/**
 * Drop-in replacement for window.fetch that redirects to /login on a
 * 401 response from our own /api/* routes. Kept Response-returning so
 * existing callers can swap `fetch(...)` for `apiFetch(...)` with zero
 * other changes.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status !== 401) return response;
  if (typeof window === 'undefined') return response;

  const pathname = window.location.pathname;
  if (isAnonymousPathname(pathname)) return response;

  const url = extractUrl(input);
  if (!isOwnApiUrl(url)) return response;

  window.location.href = '/login';
  return response;
}
