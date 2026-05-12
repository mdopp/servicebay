import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  mockFetch.mockReset();
  // Patch setTimeout to a no-op resolver so retries don't burn real wall-clock.
  globalThis.setTimeout = ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

// useStackInstall imports a lot of React/Next plumbing — we only want the
// pure helper. Pull it in *after* fetch is stubbed.
import { provisionPortalWithRetries } from './useStackInstall';

function mockJsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('provisionPortalWithRetries', () => {
  it('returns true and logs the detail on first-attempt success', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(true, { ok: true, detail: 'proxy:unchanged rewrites=*.dopp.cloud:added' }));
    const logs: string[] = [];
    const ok = await provisionPortalWithRetries(m => logs.push(m));
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logs.some(l => l.startsWith('✅'))).toBe(true);
    expect(logs[0]).toContain('proxy:unchanged');
  });

  it('retries when the endpoint reports ok=false, succeeds on a later attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockJsonResponse(false, { ok: false, detail: 'rewrites=*.dopp.cloud:failed' }, 400))
      .mockResolvedValueOnce(mockJsonResponse(false, { ok: false, detail: 'rewrites=*.dopp.cloud:failed' }, 400))
      .mockResolvedValueOnce(mockJsonResponse(true, { ok: true, detail: 'rewrites=*.dopp.cloud:added' }));
    const logs: string[] = [];
    const ok = await provisionPortalWithRetries(m => logs.push(m));
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(logs.filter(l => l.startsWith('⏳'))).toHaveLength(2);
    expect(logs.find(l => l.startsWith('✅'))).toBeTruthy();
  });

  it('returns false after exhausting all attempts and emits a fallback hint', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(false, { ok: false, detail: 'rewrites=*.dopp.cloud:failed' }, 400));
    const logs: string[] = [];
    const ok = await provisionPortalWithRetries(m => logs.push(m));
    expect(ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(logs[logs.length - 1]).toMatch(/Reprovision/);
  });

  it('treats network exceptions as a failed attempt and retries', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(mockJsonResponse(true, { ok: true, detail: 'rewrites=*.dopp.cloud:added' }));
    const logs: string[] = [];
    const ok = await provisionPortalWithRetries(m => logs.push(m));
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logs.find(l => l.includes('ECONNREFUSED'))).toBeTruthy();
  });

  it('treats invalid JSON as a failed attempt without throwing', async () => {
    const badRes = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    } as unknown as Response;
    mockFetch.mockResolvedValue(badRes);
    const logs: string[] = [];
    const ok = await provisionPortalWithRetries(m => logs.push(m));
    expect(ok).toBe(false);
    expect(logs.some(l => l.includes('HTTP 500'))).toBe(true);
  });
});
