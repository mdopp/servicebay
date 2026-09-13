import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import type { ApiScope } from '@/lib/auth/apiScope';
import type { SessionPayload } from '@/lib/auth/session';

interface ApiErrorBody {
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
  /**
   * Hold a scoped cookie session (one minted by the token→session bridge) to
   * this scope, WITHOUT making the route Bearer-reachable (#2919). This is what
   * a credential-minting route wants: `tokenScope` would also let a token call
   * the mint directly and hand itself an unparented, longer-lived twin. See
   * `RequireSessionOptions.cookieScope`.
   */
  cookieScope?: ApiScope;
}

export interface ParsedRequest<B, Q> {
  body: B;
  query: Q;
  request: NextRequest;
  /**
   * The authenticated principal, when the gate ran (mutating verbs, a route
   * with `tokenScope`/`cookieScope`, or any request carrying a `Bearer` token
   * or a readable session cookie). `undefined` for a request that carries no
   * credential the gate could read — a public GET with neither, or one whose
   * cookie no longer decodes. Routes branch on
   * `auth?.user` — e.g. `auth?.user.startsWith('token:')` to redact secrets
   * for a scoped API-token caller (#1275).
   */
  auth?: SessionPayload;
}

export interface ParsedRequestWithParams<B, Q, P> extends ParsedRequest<B, Q> {
  /** Resolved Next.js dynamic-route params (e.g. `{ name: 'immich' }`
   *  for `/api/services/[name]/route.ts`). */
  params: P;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Must `requireSession` run for this request?
 *
 * Yes when: a mutating verb (the original #596 check), a route that opts into
 * token auth, a request carrying a Bearer token, or a request carrying a session
 * cookie. The Bearer case lets a token reach an opted-in GET (the proxy passes
 * valid tokens through, #1275) while a Bearer to a route WITHOUT `tokenScope`
 * still 401s — requireSession ignores Bearer when no scope is set and falls
 * through to the (absent) cookie.
 *
 * The cookie case is #2958. A session bridged from a token
 * (`POST /api/auth/session-from-token`) is a token principal wearing a cookie,
 * and on a scopeless GET the gate never ran at all — so the one check in
 * `requireSession` never got the chance to hold it to anything, and the cookie
 * reached what the bearer could not. Running the gate whenever a session cookie
 * is present is what puts every cookie-borne request in front of that single
 * check (and is what makes `auth` visible to the handlers that redact for a
 * token principal, #2943).
 *
 * A genuinely anonymous request — no cookie, no Bearer — still skips the gate,
 * so the public routes in `proxy.ts:PUBLIC_API_RULES` are unaffected.
 *
 * The cookie case is `'opportunistic'` rather than `'required'` for those same
 * public routes: a caller holding a *stale* cookie on a public GET was answered
 * before #2958 and must still be, so a 401 there falls back to anonymous rather
 * than becoming the response. `/api/install/progress` names that scenario
 * outright (#663 — the overlay keeps polling after a clean install invalidates
 * the cookie mid-run). A 403 is a different animal: a real token principal the
 * classification refused, and it is returned.
 *
 * The cookie test is presence only, by local regex: the authoritative parse,
 * signature check and liveness re-check stay in `getSessionFromCookieHeader`,
 * and the regex keeps this module clear of the cookie/JWT import chain (see the
 * lazy import of `requireSession` below).
 */
type GateKind = 'skip' | 'required' | 'opportunistic';

function gateKind<B, Q>(options: ApiHandlerOptions<B, Q>, request: NextRequest): GateKind {
  if (options.skipAuth) return 'skip';
  if (MUTATING_METHODS.has(request.method)) return 'required';
  if (options.tokenScope !== undefined || options.cookieScope !== undefined) return 'required';
  if ((request.headers.get('authorization') ?? '').startsWith('Bearer ')) return 'required';
  if (/(?:^|;\s*)session=/.test(request.headers.get('cookie') ?? '')) return 'opportunistic';
  return 'skip';
}

/** Shared validation + error-envelope core used by both wrappers. */
async function runHandler<B, Q>(
  options: ApiHandlerOptions<B, Q>,
  request: NextRequest,
  invoke: (parsed: { body: B; query: Q; auth?: SessionPayload }) => Promise<Response | NextResponse | unknown>,
): Promise<Response> {
  try {
    let auth: SessionPayload | undefined;
    const kind = gateKind(options, request);
    if (kind !== 'skip') {
      // Lazy import to keep handler.ts free of the cookie-parse import
      // chain when the module is loaded by middleware-adjacent code.
      const { requireSession } = await import('./requireSession');
      const result = await requireSession(request, {
        tokenScope: options.tokenScope,
        cookieScope: options.cookieScope,
      });
      if (result instanceof NextResponse) {
        // Opportunistic + 401 = an unreadable cookie, i.e. an anonymous caller
        // on a route that never gated one. Proceed as before (see `gateKind`).
        if (kind === 'required' || result.status !== 401) return result;
      } else {
        auth = result;
      }
    }

    const rawBody = options.body ? await readJsonBody(request) : undefined;
    const body = options.body ? options.body.parse(rawBody) : (undefined as B);
    const rawQuery = searchParamsToObject(request.nextUrl.searchParams);
    const query = options.query ? options.query.parse(rawQuery) : (undefined as Q);

    const result = await invoke({ body, query, auth });
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
    return runHandler(options, request, ({ body, query, auth }) =>
      handler({ body, query, request, auth }),
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
    return runHandler(options, request, async ({ body, query, auth }) => {
      const params = await ctx.params;
      return handler({ body, query, request, params, auth });
    });
  };
}
