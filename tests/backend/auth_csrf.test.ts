// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ||
    '0123456789abcdef0123456789abcdef0123456789abcdef';
});

// Build a NextRequest-like stand-in. The proxy fn only touches headers,
// method, cookies.get, and nextUrl.pathname.
function makeReq(opts: {
  method?: string;
  pathname: string;
  origin?: string;
  referer?: string;
  host?: string;
  sessionCookie?: string;
}) {
  const headers = new Headers();
  if (opts.origin) headers.set('origin', opts.origin);
  if (opts.referer) headers.set('referer', opts.referer);
  headers.set('host', opts.host ?? 'admin.example.com');
  return {
    method: opts.method ?? 'POST',
    headers,
    nextUrl: { pathname: opts.pathname },
    cookies: { get: (name: string) => opts.sessionCookie && name === 'session' ? { value: opts.sessionCookie } : undefined },
  } as unknown as import('next/server').NextRequest;
}

describe('proxy CSRF check', () => {
  it('allows GET regardless of origin', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({ method: 'GET', pathname: '/api/services' }));
    // No session cookie → 401 (auth check, not CSRF)
    expect(res.status).toBe(401);
  });

  it('rejects unsafe method without Origin or Referer', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({ method: 'POST', pathname: '/api/services' }));
    expect(res.status).toBe(403);
  });

  it('rejects unsafe method with cross-origin Origin', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({
      method: 'POST',
      pathname: '/api/services',
      origin: 'https://evil.example',
    }));
    expect(res.status).toBe(403);
  });

  it('allows unsafe method with matching Origin', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({
      method: 'POST',
      pathname: '/api/services',
      origin: 'https://admin.example.com',
    }));
    // Origin matches → CSRF passes; falls through to auth → 401 (no session)
    expect(res.status).toBe(401);
  });

  it('falls back to Referer when Origin is missing', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({
      method: 'POST',
      pathname: '/api/services',
      referer: 'https://admin.example.com/services',
    }));
    expect(res.status).toBe(401);
  });

  it('allows POST to public endpoint with matching Origin', async () => {
    const { proxy } = await import('../../src/proxy');
    const { NextResponse } = await import('next/server');
    const spy = vi.spyOn(NextResponse, 'next');
    await proxy(makeReq({
      method: 'POST',
      pathname: '/api/auth/login',
      origin: 'https://admin.example.com',
    }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('blocks POST to public endpoint when cross-origin', async () => {
    const { proxy } = await import('../../src/proxy');
    const res = await proxy(makeReq({
      method: 'POST',
      pathname: '/api/auth/login',
      origin: 'https://evil.example',
    }));
    expect(res.status).toBe(403);
  });
});
