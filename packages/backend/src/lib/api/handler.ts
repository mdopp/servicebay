import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import type { ApiScope } from '@/lib/mcp/scope';

export interface ApiErrorBody {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
}

class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status = 400, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Safely parse JSON request body. Returns undefined if there is no body. */
async function readJsonBody(request: NextRequest): Promise<unknown> {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return undefined;
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError('invalid JSON body', 400, 'BAD_JSON', String(e));
  }
}

/** Convert URLSearchParams into a plain object (keeps repeated keys as arrays). */
function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

export interface ApiHandlerOptions<B, Q> {
  /** Validates JSON body. Use undefined for handlers that don't read a body. */
  body?: z.ZodType<B>;
  /** Validates URL query params. Use undefined when no query is expected. */
  query?: z.ZodType<Q>;
  /**
   * Opt out of the built-in requireSession gate on mutating verbs (#603).
   * Only for routes that are *intentionally* public — login, the OIDC
   * initiator, the family-portal access-request submission. These mirror
   * `src/proxy.ts:PUBLIC_API_RULES`; keep the two in sync. Authenticated
   * routes must never set this.
   */
  skipAuth?: boolean;
  /**
   * Opt this route into named API token (`Bearer sb_…`) auth, requiring the
   * given scope (#1264). Without it the built-in gate accepts only a session
   * cookie or the internal token. Set this on routes the TUI / scripts reach
   * with a scoped token (e.g. `tokenScope: 'mutate'` on config edits).
   */
  tokenScope?: ApiScope;
}

export interface ParsedRequest<B, Q> {
  body: B;
  query: Q;
  request: NextRequest;
}

export interface ParsedRequestWithParams<B, Q, P> extends ParsedRequest<B, Q> {
  /** Resolved Next.js dynamic-route params (e.g. `{ name: 'immich' }`
   *  for `/api/services/[name]/route.ts`). */
  params: P;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Shared validation + error-envelope core used by both wrappers. */
async function runHandler<B, Q>(
  options: ApiHandlerOptions<B, Q>,
  request: NextRequest,
  invoke: (parsed: { body: B; query: Q }) => Promise<Response | NextResponse | unknown>,
): Promise<Response> {
  try {
    if (!options.skipAuth && MUTATING_METHODS.has(request.method)) {
      // Lazy import to keep handler.ts free of the cookie-parse import
      // chain when the module is loaded by middleware-adjacent code.
      const { requireSession } = await import('./requireSession');
      const auth = await requireSession(request, { tokenScope: options.tokenScope });
      if (auth instanceof NextResponse) return auth;
    }

    const rawBody = options.body ? await readJsonBody(request) : undefined;
    const body = options.body ? options.body.parse(rawBody) : (undefined as B);
    const rawQuery = searchParamsToObject(request.nextUrl.searchParams);
    const query = options.query ? options.query.parse(rawQuery) : (undefined as Q);

    const result = await invoke({ body, query });
    if (result instanceof Response) return result;
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: 'validation failed', code: 'VALIDATION', details: e.flatten() } satisfies ApiErrorBody,
        { status: 400 },
      );
    }
    if (e instanceof ApiError) {
      return NextResponse.json(
        { ok: false, error: e.message, code: e.code, details: e.details } satisfies ApiErrorBody,
        { status: e.status },
      );
    }
    logger.error('Api', `Unhandled error in ${request.method} ${request.nextUrl.pathname}`, e);
    return NextResponse.json(
      { ok: false, error: 'internal server error' } satisfies ApiErrorBody,
      { status: 500 },
    );
  }
}

/**
 * Wrap a Next.js API route handler with shared validation, error handling,
 * and error envelope. Throws ApiError to short-circuit with a typed status.
 *
 * Defense-in-depth requireSession gate (#596) — runs before any body/query
 * parsing so an unauthenticated POST/PATCH/PUT/DELETE is rejected with a
 * cheap 401 instead of triggering full validation. GET/HEAD/OPTIONS skip
 * the gate (proxy.ts is still the primary gate for those; the wrapper's
 * role here is the redundant per-route check the audit asked for).
 *
 * Use the sibling `withApiHandlerParams` for dynamic-segment routes
 * (`/api/services/[name]/...`): Next.js's generated route types refuse
 * a 2-arg handler on non-dynamic routes, so the two shapes need
 * separate entry points.
 */
export function withApiHandler<B = undefined, Q = undefined>(
  options: ApiHandlerOptions<B, Q>,
  handler: (input: ParsedRequest<B, Q>) => Promise<Response | NextResponse | unknown>,
) {
  return async (request: NextRequest): Promise<Response> => {
    return runHandler(options, request, ({ body, query }) =>
      handler({ body, query, request }),
    );
  };
}

/**
 * Dynamic-segment variant (#603). Next.js passes
 * `{ params: Promise<{...}> }` as the second arg to route handlers in
 * dynamic segments. This wrapper awaits and forwards it to the handler
 * under `input.params` so consumers can destructure
 * `{ params: { name } }` without re-implementing the await.
 */
export function withApiHandlerParams<B = undefined, Q = undefined, P = unknown>(
  options: ApiHandlerOptions<B, Q>,
  handler: (input: ParsedRequestWithParams<B, Q, P>) => Promise<Response | NextResponse | unknown>,
) {
  return async (request: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    return runHandler(options, request, async ({ body, query }) => {
      const params = await ctx.params;
      return handler({ body, query, request, params });
    });
  };
}
