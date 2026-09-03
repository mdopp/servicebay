// #1102 / #2736 Phase 2: this module is THE client-side 401 handler.
//
// Phase 1 added this wrapper beside the global `window.fetch` monkey-patch
// in DigitalTwinProvider. Phase 2 (#2736) deleted that patch, so there is
// now exactly one 401 → /login path in the browser and it runs only for
// callers that opted in by calling `apiFetch`. Phase 3 is the ratcheted
// burn-down of the remaining raw `fetch('/api/...')` call sites onto this
// wrapper, forced monotonically downward by the ESLint rule
// `sb/no-raw-api-fetch` (eslint.config.mjs) + `scripts/check-lint-ratchet.ts`.
//
// Why the patch had to go: a global patch covers every raw fetch silently,
// which makes the migration look unnecessary while the raw-fetch count keeps
// growing. One explicit seam beats an invisible one.
//
// The 401 → /login redirect logic is preserved one-to-one from the
// previous monkey-patch, including:
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

/**
 * Pathnames where an auth failure must NOT bounce the browser to /login:
 * /login itself (the redirect target — bouncing loops, #854) and the
 * anonymous-readable family portal subtree.
 *
 * Exported because the socket transport needs the *same* answer as the REST
 * transport: `useSocket`'s `unauthorized` handler used to carry a duplicated
 * copy of this set, and two copies of one rule drift (#2736). One definition,
 * both transports.
 */
export function isAnonymousPathname(pathname: string): boolean {
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
