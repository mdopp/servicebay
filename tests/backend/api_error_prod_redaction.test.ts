/**
 * NODE_ENV=production redaction lane (#2166).
 *
 * `apiError` (packages/backend/src/lib/api/errors.ts) redacts the real error
 * message to a generic string ONLY when `process.env.NODE_ENV === 'production'`
 * — the branch the runner image actually takes but no CI job previously
 * exercised. `isProd` is a module-level const evaluated at import time, so each
 * lane sets NODE_ENV and re-imports the module with a fresh module registry.
 *
 * This is the "prod-only code path" test the review asked for: it fails if the
 * production branch ever starts leaking internal error text to the client, or
 * if the dev branch stops surfacing it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The logger is called on every apiError to persist the real message; stub it
// so the test doesn't emit noise and to assert the real message is still logged
// (redaction hides it from the client, not from /logs).
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const ORIGINAL_ENV = process.env.NODE_ENV;

async function loadApiError() {
  vi.resetModules();
  const mod = await import('@/lib/api/errors');
  return mod.apiError;
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
  vi.resetModules();
});

describe('apiError — NODE_ENV=production lane (#2166)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  it('redacts the real error message to a generic string in production', async () => {
    const apiError = await loadApiError();
    const res = apiError(new Error('secret DB dsn postgres://user:pw@host'), { status: 500 });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal error');
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('uses the generic map per status code in production', async () => {
    const apiError = await loadApiError();
    const res = apiError(new Error('validation blew up on field x'), { status: 400 });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad request');
  });

  it('still surfaces the real message when exposeMessage:true, even in production', async () => {
    const apiError = await loadApiError();
    const res = apiError(new Error('Name is required'), { status: 422, exposeMessage: true });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error).toBe('Name is required');
  });

  it('logs the real message even while redacting it from the client', async () => {
    const { logger } = await import('@/lib/logger');
    const apiError = await loadApiError();
    apiError(new Error('leaky internals'), { status: 500, tag: 'thing' });
    expect(logger.error).toHaveBeenCalledWith(
      'thing',
      'leaky internals',
      expect.anything(),
    );
  });
});

describe('apiError — development lane surfaces the real message', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  it('includes the real error message in development', async () => {
    const apiError = await loadApiError();
    const res = apiError(new Error('boom detail'), { status: 500 });
    const body = await res.json();
    expect(body.error).toBe('boom detail');
  });
});
