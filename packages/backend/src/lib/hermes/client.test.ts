/**
 * HermesClient + getOrCreateMaintenanceSession + resolveHermesConnection
 * (#1754, epic #1704).
 *
 * Covers the four acceptance contracts:
 *   1. createSession posts the admin-for-families persona + returns the id.
 *   2. getOrCreateMaintenanceSession creates once, persists the id, and
 *      returns the SAME id on subsequent calls (no recreate).
 *   3. chat round-trips an input to a reply.
 *   4. an unreachable Hermes (fetch rejects) surfaces a HermesError; a
 *      missing key marks the client unconfigured (the route's 503 path).
 *
 * fetch is mocked with `mockImplementation` returning a FRESH Response per
 * call — never a shared Response object — per memory
 * feedback_vitest_fetch_response_reuse (a reused body's second .json()
 * rejects and the test hangs).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Coupled config store: getConfig returns what updateConfig last wrote.
let mockConfigState: Partial<AppConfig> = {};
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState as AppConfig),
  updateConfig: vi.fn(async (updates: Partial<AppConfig>) => {
    mockConfigState = { ...mockConfigState, ...updates };
    return mockConfigState as AppConfig;
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { AppConfig } from '@/lib/config';
import {
  HermesClient,
  HermesError,
  MAINTENANCE_PERSONA_PROMPT,
  getOrCreateMaintenanceSession,
  resolveHermesConnection,
} from './client';

const CONN = { baseUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' };

/** Build a fresh JSON Response — one per call, never reused. */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockConfigState = {};
  vi.restoreAllMocks();
});

describe('resolveHermesConnection', () => {
  it('reads the key from installedSecrets and defaults the port to 8642', () => {
    const conn = resolveHermesConnection({
      installedSecrets: [{ varName: 'HERMES_API_KEY', password: 'sekret' }],
    } as unknown as AppConfig);
    expect(conn.baseUrl).toBe('http://127.0.0.1:8642');
    expect(conn.apiKey).toBe('sekret');
  });

  it('honours a HERMES_API_PORT override and an empty key', () => {
    const conn = resolveHermesConnection({
      templateSettings: { HERMES_API_PORT: '9999' },
    } as unknown as AppConfig);
    expect(conn.baseUrl).toBe('http://127.0.0.1:9999');
    expect(conn.apiKey).toBe('');
  });
});

describe('HermesClient.configured', () => {
  it('is false when no key is present', () => {
    expect(new HermesClient({ baseUrl: 'http://127.0.0.1:8642', apiKey: '' }).configured).toBe(false);
  });
  it('is true when a key is present', () => {
    expect(new HermesClient(CONN).configured).toBe(true);
  });
});

describe('HermesClient.createSession', () => {
  it('posts user_id + the persona system_prompt and returns the id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'sess-1' }));

    const id = await new HermesClient(CONN).createSession('alice', MAINTENANCE_PERSONA_PROMPT);
    expect(id).toBe('sess-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8642/api/sessions');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(String(init?.body));
    expect(sent.user_id).toBe('alice');
    expect(sent.system_prompt).toBe(MAINTENANCE_PERSONA_PROMPT);
    // Bearer key sent server-side; never surfaced to a caller.
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('throws when Hermes returns no session id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
    await expect(new HermesClient(CONN).createSession('alice')).rejects.toBeInstanceOf(HermesError);
  });
});

describe('HermesClient.chat', () => {
  it('round-trips an input to the reply text', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ message: { content: 'hello back' } }),
    );
    const reply = await new HermesClient(CONN).chat('sess-1', 'hi');
    expect(reply).toBe('hello back');
  });

  it('throws HermesError when fetch rejects (Hermes unreachable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(new HermesClient(CONN).chat('sess-1', 'hi')).rejects.toBeInstanceOf(HermesError);
  });

  it('throws HermesError with status on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: 'boom' }, 500),
    );
    await expect(new HermesClient(CONN).chat('s', 'hi')).rejects.toMatchObject({ status: 500 });
  });
});

describe('getOrCreateMaintenanceSession', () => {
  it('creates the session once with the persona and persists the id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ id: 'maint-1' }));

    const id = await getOrCreateMaintenanceSession(new HermesClient(CONN), 'alice');
    expect(id).toBe('maint-1');
    expect(mockConfigState.hermes?.maintenanceSessionId).toBe('maint-1');

    // Verify the persona overlay was bound at create.
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.system_prompt).toBe(MAINTENANCE_PERSONA_PROMPT);
  });

  it('returns the persisted id on a subsequent call when it still resolves', async () => {
    mockConfigState = { hermes: { maintenanceSessionId: 'existing-1' } };
    // First call: GET /api/sessions/existing-1 -> session found (no create).
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ session: { id: 'existing-1' } }));

    const id = await getOrCreateMaintenanceSession(new HermesClient(CONN), 'alice');
    expect(id).toBe('existing-1');
    // Only the GET ran — no POST /api/sessions create.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('GET');
  });

  it('recreates when the persisted id 404s on Hermes', async () => {
    mockConfigState = { hermes: { maintenanceSessionId: 'stale-1' } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      // GET of the stale id 404s; the follow-up POST creates a fresh one.
      if (init?.method === 'GET') return jsonResponse({}, 404);
      return jsonResponse({ id: 'fresh-1' });
    });

    const id = await getOrCreateMaintenanceSession(new HermesClient(CONN), 'alice');
    expect(id).toBe('fresh-1');
    expect(mockConfigState.hermes?.maintenanceSessionId).toBe('fresh-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
