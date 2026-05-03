// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ||
    '0123456789abcdef0123456789abcdef0123456789abcdef';
});

describe('readSessionCookie', () => {
  it('returns null for missing header', async () => {
    const { readSessionCookie } = await import('../../src/lib/auth');
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
  });

  it('extracts the session cookie from a multi-cookie header', async () => {
    const { readSessionCookie } = await import('../../src/lib/auth');
    expect(readSessionCookie('foo=bar; session=abc.def.ghi; baz=qux'))
      .toBe('abc.def.ghi');
  });

  it('returns null when no session cookie present', async () => {
    const { readSessionCookie } = await import('../../src/lib/auth');
    expect(readSessionCookie('foo=bar; baz=qux')).toBeNull();
  });
});

describe('getSessionFromCookieHeader', () => {
  it('rejects unsigned/garbage tokens', async () => {
    const { getSessionFromCookieHeader } = await import('../../src/lib/auth');
    expect(await getSessionFromCookieHeader('session=garbage')).toBeNull();
  });

  it('round-trips a session payload through decrypt', async () => {
    const auth = await import('../../src/lib/auth');
    const { SignJWT } = await import('jose');
    const key = new Uint8Array(Buffer.from(process.env.AUTH_SECRET!, 'utf-8'));
    const token = await new SignJWT({ user: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const payload = await auth.decrypt(token);
    expect(payload?.user).toBe('admin');
    const session = await auth.getSessionFromCookieHeader(`session=${token}`);
    expect(session?.user).toBe('admin');
  });
});

