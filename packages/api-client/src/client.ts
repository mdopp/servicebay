// Typed fetch client. Phase 1 of the FE/BE separation (#753) —
// proof-of-life so the seam carries actual behaviour, not just
// re-exports. Frontend call sites get a runtime-validated response
// shape from a zod schema that lives next to the type it describes.
//
// Phase 2 migrates the bulk of the ~80 raw `fetch('/api/...')` call
// sites in src/{components,hooks,dashboards} onto this helper. Today
// only the worked example (Sidebar.tsx → /api/install/status) does.

import { z, type ZodType } from 'zod';
import { apiFetch } from './apiFetch';

export class TypedFetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TypedFetchError';
  }
}

/**
 * Fetch + zod-validate the response. Throws `TypedFetchError` on
 * non-OK status or schema mismatch — callers that want to swallow
 * failures (e.g. periodic polling) wrap in try/catch.
 */
export async function typedFetch<T>(
  url: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new TypedFetchError(
      `${init?.method ?? 'GET'} ${url} → HTTP ${res.status}`,
      undefined,
      res.status,
    );
  }
  const raw: unknown = await res.json();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TypedFetchError(
      `${init?.method ?? 'GET'} ${url}: response failed schema validation`,
      parsed.error,
      res.status,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The `withApiHandler` envelope seam (#2745)
// ---------------------------------------------------------------------------
//
// A route handler that returns a plain value is wrapped by
// `withApiHandler` as `{ ok: true, data }`; a failure comes back as
// `{ ok: false, error, code?, details? }` with a non-2xx status. The two
// helpers below are the ONLY thing a typed api-client method needs to talk
// to such a route: they unwrap the envelope, validate `data` against the
// route's zod contract, and surface a server-authored error message
// instead of a bare "HTTP 500".
//
// They go through `apiFetch`, so every call site inherits the single
// client-side 401 → /login handler (see apiFetch.ts) — which is exactly
// what the server actions this replaced could never do.

const ApiErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});

/** Call a `withApiHandler` route and validate the unwrapped `data` payload. */
export async function callApi<T>(
  url: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method ?? 'GET';
  const res = await apiFetch(url, init);
  const raw: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    const err = ApiErrorEnvelopeSchema.safeParse(raw);
    throw new TypedFetchError(
      err.success ? err.data.error : `${method} ${url} → HTTP ${res.status}`,
      raw,
      res.status,
    );
  }

  const parsed = z.object({ ok: z.literal(true), data: schema }).safeParse(raw);
  if (!parsed.success) {
    throw new TypedFetchError(
      `${method} ${url}: response failed schema validation`,
      parsed.error,
      res.status,
    );
  }
  return parsed.data.data;
}

/** `callApi` for a JSON-body mutation. `method` defaults to POST. */
export function mutateApi<T>(
  url: string,
  schema: ZodType<T>,
  body?: unknown,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  return callApi(url, schema, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

// ---------------------------------------------------------------------------
// The raw (un-enveloped) response seam
// ---------------------------------------------------------------------------
//
// `withApiHandler`'s auto-envelope (`{ ok: true, data }`, above) only kicks
// in when the route handler returns a plain value. A route written before
// the api-client migration — and several still are — calls
// `NextResponse.json(...)` itself, so its success body is whatever it put
// there, unwrapped. `callApi` would fail schema validation against that
// shape on every call. `rawApi`/`mutateRawApi` are `callApi`/`mutateApi`'s
// siblings for exactly that case: validate the body directly (no `.data`
// unwrap), but still read a `{ error }` field out of a non-OK body so a
// server-authored message survives the migration.

// Un-enveloped routes are not uniform about the failure field: most send
// `{ error }` (that is all `apiError` ever emits), while a few hand-rolled
// ones carry the operator-facing text in `message` (`/api/settings/gateway`'s
// connection_failed, `/api/system/nginx/credentials`' re-key refusal). Read
// both so the server's own wording survives instead of a bare "HTTP 400".
const RawErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

function rawErrorMessage(raw: unknown): string | undefined {
  const parsed = RawErrorBodySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.message ?? parsed.data.error;
}

/** Call a route whose success body is NOT wrapped in `{ ok, data }`. */
export async function rawApi<T>(
  url: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method ?? 'GET';
  const res = await apiFetch(url, init);
  const raw: unknown = await res.json().catch(() => undefined);

  if (!res.ok) {
    throw new TypedFetchError(
      rawErrorMessage(raw) ?? `${method} ${url} → HTTP ${res.status}`,
      raw,
      res.status,
    );
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TypedFetchError(
      `${method} ${url}: response failed schema validation`,
      parsed.error,
      res.status,
    );
  }
  return parsed.data;
}

/** `rawApi` for a JSON-body mutation. `method` defaults to POST. */
export function mutateRawApi<T>(
  url: string,
  schema: ZodType<T>,
  body?: unknown,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST',
): Promise<T> {
  return rawApi(url, schema, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}
