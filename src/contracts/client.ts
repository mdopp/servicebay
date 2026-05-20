// Typed fetch client. Phase 1 of the FE/BE separation (#753) —
// proof-of-life so the seam carries actual behaviour, not just
// re-exports. Frontend call sites get a runtime-validated response
// shape from a zod schema that lives next to the type it describes.
//
// Phase 2 migrates the bulk of the ~80 raw `fetch('/api/...')` call
// sites in src/{components,hooks,dashboards} onto this helper. Today
// only the worked example (Sidebar.tsx → /api/install/status) does.

import type { ZodType } from 'zod';

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
