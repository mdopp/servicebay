import { describe, it, expect, vi } from 'vitest';
import { requestLabel } from './ollama';

/** A fetch mock that returns one Ollama generate envelope with `response` = body. */
function fetchReturning(responseField: unknown, init: { ok?: boolean } = {}) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({
      ok: init.ok ?? true,
      json: async () => ({ response: responseField }),
    }) as unknown as Response,
  );
}

const ALLOWED = ['music', 'audiobooks', 'podcasts'] as const;
const req = { prompt: 'classify this', allowed: ALLOWED };

describe('requestLabel — strict JSON parsing', () => {
  it('valid strict-JSON response → suggestion', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'audiobooks', reason: 'long chapters' }));
    const out = await requestLabel(req, { fetchImpl });
    expect(out).toEqual({ label: 'audiobooks', reason: 'long chapters' });
  });

  it('trims label + tolerates a missing reason', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: '  music  ' }));
    const out = await requestLabel(req, { fetchImpl });
    expect(out).toEqual({ label: 'music', reason: '' });
  });

  it('label outside the allowed set → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'movies', reason: 'x' }));
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('malformed (non-JSON) response → ignored (null)', async () => {
    const fetchImpl = fetchReturning('not json at all {');
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('JSON array (not an object) → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify(['music']));
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('object with no label → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ reason: 'no label here' }));
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('non-string Ollama response field → ignored (null)', async () => {
    const fetchImpl = fetchReturning({ label: 'music' });
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('over-long response → ignored (null)', async () => {
    const fetchImpl = fetchReturning('x'.repeat(5000));
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('requests format:json + stream:false', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music', reason: '' }));
    await requestLabel(req, { fetchImpl });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.format).toBe('json');
    expect(body.stream).toBe(false);
  });
});

describe('requestLabel — graceful fallback (never throws)', () => {
  it('connection refused → null, no throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    await expect(requestLabel(req, { fetchImpl })).resolves.toBeNull();
  });

  it('non-OK HTTP status → null', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music' }), { ok: false });
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });

  it('timeout / abort → null, no throw', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Simulate an abort firing on the request signal.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    await expect(requestLabel(req, { fetchImpl, timeoutMs: 5 })).resolves.toBeNull();
  });

  it('json() that rejects → null', async () => {
    const fetchImpl = vi.fn(async () =>
      ({ ok: true, json: async () => { throw new Error('bad body'); } }) as unknown as Response,
    );
    expect(await requestLabel(req, { fetchImpl })).toBeNull();
  });
});
