import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

const isProd = process.env.NODE_ENV === 'production';

const GENERIC: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
  500: 'Internal error',
};

export interface ApiErrorOptions {
  status?: number;
  tag?: string;
  exposeMessage?: boolean;
}

/**
 * Build a JSON error response without leaking internals to the client.
 * In development the original error message is included to aid debugging.
 * In production the response uses a generic message; the real error is
 * persisted via the logger so it remains visible in /logs.
 *
 * Pass exposeMessage:true for errors that are explicitly safe to surface
 * (e.g. validation failures with a curated message).
 */
export function apiError(
  err: unknown,
  options: ApiErrorOptions = {},
): NextResponse {
  const status = options.status ?? 500;
  const tag = options.tag ?? 'api';
  const realMsg = err instanceof Error ? err.message : String(err);

  logger.error(tag, realMsg, err instanceof Error && err.stack ? { stack: err.stack } : undefined);

  const body: Record<string, unknown> = {
    error: options.exposeMessage || !isProd ? realMsg : (GENERIC[status] ?? 'Error'),
  };
  return NextResponse.json(body, { status });
}
