/**
 * GET /api/system/hermes/chat (#1760) — the maintenance-chat history seam.
 *
 * The GET handler resolves the maintenance session server-side and returns its
 * persisted conversation so the panel can restore it on mount. The Hermes key
 * never leaves the backend. Covers the happy path (messages returned) and the
 * graceful 503 when Hermes is unconfigured / unreachable.
 *
 * The backend client (`@/lib/hermes/client`) and config are mocked so the test
 * exercises the route's wiring (configured guard, session resolve, 503 mapping)
 * without a live Hermes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getOrCreateMaintenanceSession: vi.fn(),
  configuredRef: { value: true },
}));
const { getMessages, getOrCreateMaintenanceSession, configuredRef } = mocks;

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({})),
}));

vi.mock('@/lib/hermes/client', () => {
  class FakeHermesError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    HermesError: FakeHermesError,
    resolveHermesConnection: vi.fn(() => ({ baseUrl: 'http://127.0.0.1:8642', apiKey: 'k' })),
    HermesClient: class {
      get configured() {
        return mocks.configuredRef.value;
      }
      getMessages = mocks.getMessages;
    },
    getOrCreateMaintenanceSession: mocks.getOrCreateMaintenanceSession,
  };
});

import { GET } from './route';
import { HermesError } from '@/lib/hermes/client';

function req(): NextRequest {
  return new NextRequest('http://localhost/api/system/hermes/chat');
}

describe('GET /api/system/hermes/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuredRef.value = true;
    getOrCreateMaintenanceSession.mockResolvedValue('maint-1');
  });

  it('returns the maintenance session messages on the happy path', async () => {
    getMessages.mockResolvedValue([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    expect(getOrCreateMaintenanceSession).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith('maint-1');
  });

  it('returns a graceful 503 when Hermes is not configured', async () => {
    configuredRef.value = false;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(getOrCreateMaintenanceSession).not.toHaveBeenCalled();
  });

  it('returns a graceful 503 when Hermes is unreachable', async () => {
    getMessages.mockRejectedValue(new HermesError('Hermes is unreachable'));
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    // Non-leaking message, no key.
    expect(JSON.stringify(body)).not.toContain('Bearer');
    expect(body.error).toMatch(/Hermes is unavailable/i);
  });
});
