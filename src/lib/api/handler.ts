import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';

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
}

export interface ParsedRequest<B, Q> {
  body: B;
  query: Q;
  request: NextRequest;
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
 */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
export function withApiHandler<B = undefined, Q = undefined>(
  options: ApiHandlerOptions<B, Q>,
  handler: (input: ParsedRequest<B, Q>) => Promise<Response | NextResponse | unknown>,
) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      if (MUTATING_METHODS.has(request.method)) {
        // Lazy import to keep handler.ts free of the cookie-parse import
        // chain when the module is loaded by middleware-adjacent code.
        const { requireSession } = await import('./requireSession');
        const auth = await requireSession(request);
        if (auth instanceof NextResponse) return auth;
      }

      const rawBody = options.body ? await readJsonBody(request) : undefined;
      const body = options.body ? options.body.parse(rawBody) : (undefined as B);
      const rawQuery = searchParamsToObject(request.nextUrl.searchParams);
      const query = options.query ? options.query.parse(rawQuery) : (undefined as Q);

      const result = await handler({ body, query, request });
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
  };
}
