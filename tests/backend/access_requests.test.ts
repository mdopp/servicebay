/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const state: { config: any } = { config: {} };

vi.mock('@/lib/config', async () => {
  const actual = await vi.importActual<any>('@/lib/config');
  return {
    ...actual,
    getConfig: vi.fn(async () => state.config),
    saveConfig: vi.fn(async (cfg: any) => { state.config = cfg; }),
  };
});
vi.mock('@/lib/email', () => ({
  sendEmailAlert: vi.fn(async () => {}),
}));

// requireSession bypass for tests (#596) — the PATCH/DELETE routes
// carry the gate; tests don't carry a session cookie.
vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));

import { POST, GET } from '@/app/api/system/access-requests/route';
import { PATCH, DELETE } from '@/app/api/system/access-requests/[id]/route';

beforeEach(() => {
  state.config = {};
});

const post = (body: unknown, opts?: { rawBody?: string }) =>
  POST(new Request('http://test/api/system/access-requests', {
    method: 'POST',
    body: opts?.rawBody ?? JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));

describe('POST /api/system/access-requests', () => {
  it('creates a request from a valid body', async () => {
    const res = await post({ name: 'Alice', email: 'alice@example.com', message: 'I want photos' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe('string');
    expect(state.config.accessRequests).toHaveLength(1);
    expect(state.config.accessRequests[0].name).toBe('Alice');
    expect(state.config.accessRequests[0].status).toBe('pending');
  });

  it('rejects invalid email', async () => {
    const res = await post({ name: 'Alice', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('rejects empty name', async () => {
    const res = await post({ name: '', email: 'a@b.c' });
    expect(res.status).toBe(400);
  });

  it('rejects oversized body', async () => {
    const huge = 'x'.repeat(5_000);
    const res = await post(null, { rawBody: huge });
    expect(res.status).toBe(413);
  });

  it('refuses when 50 pending requests already exist', async () => {
    state.config.accessRequests = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      requestedAt: new Date().toISOString(),
      name: `User ${i}`,
      email: `user${i}@example.com`,
      status: 'pending' as const,
    }));
    const res = await post({ name: 'Late', email: 'late@example.com' });
    expect(res.status).toBe(429);
  });

  it('still accepts when 50 resolved (only pending counts toward cap)', async () => {
    state.config.accessRequests = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      requestedAt: new Date().toISOString(),
      name: `User ${i}`,
      email: `user${i}@example.com`,
      status: 'resolved' as const,
      resolvedAt: new Date().toISOString(),
    }));
    const res = await post({ name: 'Fresh', email: 'fresh@example.com' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/system/access-requests', () => {
  it('returns the persisted list', async () => {
    state.config.accessRequests = [
      { id: 'r1', requestedAt: '2026-01-01', name: 'A', email: 'a@b.c', status: 'pending' },
    ];
    const res = await GET(new NextRequest('http://localhost/api/system/access-requests'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requests).toHaveLength(1);
    expect(data.requests[0].name).toBe('A');
  });

  it('returns empty list when nothing persisted', async () => {
    const res = await GET(new NextRequest('http://localhost/api/system/access-requests'));
    const data = await res.json();
    expect(data.requests).toEqual([]);
  });
});

describe('PATCH /api/system/access-requests/[id]', () => {
  it('marks a request resolved', async () => {
    state.config.accessRequests = [
      { id: 'r1', requestedAt: '2026-01-01', name: 'A', email: 'a@b.c', status: 'pending' },
    ];
    const res = await PATCH(
      new Request('http://test/api/system/access-requests/r1', { method: 'PATCH' }),
      { params: Promise.resolve({ id: 'r1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.config.accessRequests[0].status).toBe('resolved');
    expect(state.config.accessRequests[0].resolvedAt).toBeDefined();
  });

  it('returns 404 when id not found', async () => {
    const res = await PATCH(
      new Request('http://test/api/system/access-requests/nope', { method: 'PATCH' }),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/system/access-requests/[id]', () => {
  it('removes the matching request and preserves others', async () => {
    state.config.accessRequests = [
      { id: 'r1', requestedAt: '2026-01-01', name: 'A', email: 'a@b.c', status: 'pending' },
      { id: 'r2', requestedAt: '2026-01-02', name: 'B', email: 'b@b.c', status: 'pending' },
    ];
    const res = await DELETE(
      new Request('http://test/api/system/access-requests/r1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'r1' }) },
    );
    expect(res.status).toBe(200);
    expect(state.config.accessRequests).toHaveLength(1);
    expect(state.config.accessRequests[0].id).toBe('r2');
  });
});
