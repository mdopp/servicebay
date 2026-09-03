/**
 * The one HTTP transport to Nginx Proxy Manager's admin API (#2731).
 *
 * Every `/api/nginx/...` call in the codebase goes through `npmRequest`, and
 * every module allowed to call it lives in `lib/npm/`. Two gates hold that:
 *
 *   - `.dependency-cruiser.cjs` (`npm-api-only-from-lib-npm`): only
 *     `lib/npm/**` may import this module — the import graph is the proxy
 *     for "who talks to NPM";
 *   - `scripts/invariants/npmApiLiterals.ts`: no `/api/nginx` string literal
 *     outside `lib/npm/` — depcruise cannot see strings, so a raw `fetch`
 *     that re-derives the URL is caught by the invariant instead.
 *
 * The transport is deliberately thin: it builds the URL, sets the bearer and
 * JSON headers, applies a timeout and returns the raw `Response`. It never
 * throws on an HTTP error status (call sites keep their own ok/status
 * handling — a 400 on create means "maybe it exists", a 404 on a cert means
 * "gone") and lets transport errors (refused, timed out) propagate as the
 * `fetch` rejection they are.
 */

export interface NpmRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Bearer token from `getNpmToken`; omitted for the unauthenticated calls. */
  token?: string | null;
  /** JSON-encoded as the request body when present. */
  body?: unknown;
  /** Abort budget. NPM answers list/put calls in well under a second; the
   *  ACME exchange on a certificate request is the one long one. */
  timeoutMs?: number;
}

export const NPM_DEFAULT_TIMEOUT_MS = 10_000;

/** One request against `${apiUrl}${path}`. `path` starts with `/api/`. */
export async function npmRequest(apiUrl: string, path: string, opts: NpmRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${apiUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? NPM_DEFAULT_TIMEOUT_MS),
  });
}

/** The (truncated) body of a non-ok response, for log lines and error
 *  messages. Never throws — a body that cannot be read is simply empty. */
export async function readErrorBody(res: Response, max = 500): Promise<string> {
  try {
    return (await res.text()).slice(0, max);
  } catch {
    return '';
  }
}

/** Outcome of a call whose success body the caller does not need. */
export interface NpmStatus {
  ok: boolean;
  status: number;
  /** Error body (truncated) when `ok` is false; empty otherwise. */
  body: string;
}

/** Outcome of a call whose success body is JSON the caller wants. */
export type NpmResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: string };

export async function toStatus(res: Response): Promise<NpmStatus> {
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await readErrorBody(res) };
}

export async function toResult<T>(res: Response): Promise<NpmResult<T>> {
  if (!res.ok) return { ok: false, status: res.status, body: await readErrorBody(res) };
  return { ok: true, status: res.status, data: (await res.json()) as T };
}
