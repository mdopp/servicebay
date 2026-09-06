import { describe, it, expect, vi } from 'vitest';
import { requestLabel } from './llm';

/**
 * A fetch mock returning one OpenAI chat-completions envelope whose
 * `choices[0].message.content` is `content` (the model's JSON reply text).
 */
function fetchReturning(content: unknown, init: { ok?: boolean } = {}) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({
      ok: init.ok ?? true,
      json: async () => ({
        model: 'gemma-4-e4b',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }),
    }) as unknown as Response,
  );
}

/** A fetch mock returning an arbitrary (possibly malformed) envelope. */
function fetchReturningEnvelope(envelope: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({ ok: true, json: async () => envelope }) as unknown as Response,
  );
}

const ALLOWED = ['music', 'audiobooks', 'podcasts'] as const;
const req = { prompt: 'classify this', allowed: ALLOWED };
/** Empty env so the process's own environment can't sway a test. */
const env: Record<string, string | undefined> = {};

describe('requestLabel — strict JSON parsing', () => {
  it('valid strict-JSON content → suggestion', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'audiobooks', reason: 'long chapters' }));
    const out = await requestLabel(req, { fetchImpl, env });
    expect(out).toEqual({ label: 'audiobooks', reason: 'long chapters' });
  });

  it('trims label + tolerates a missing reason', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: '  music  ' }));
    const out = await requestLabel(req, { fetchImpl, env });
    expect(out).toEqual({ label: 'music', reason: '' });
  });

  it('label outside the allowed set → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'movies', reason: 'x' }));
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it('malformed (non-JSON) content → ignored (null)', async () => {
    const fetchImpl = fetchReturning('not json at all {');
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it('JSON array (not an object) → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify(['music']));
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it('object with no label → ignored (null)', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ reason: 'no label here' }));
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it('non-string message content → ignored (null)', async () => {
    const fetchImpl = fetchReturning({ label: 'music' });
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it('over-long content → ignored (null)', async () => {
    const fetchImpl = fetchReturning('x'.repeat(5000));
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });
});

describe('requestLabel — OpenAI chat-completions wire shape', () => {
  it('POSTs host.containers.internal:11435 /v1/chat/completions by default', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music', reason: '' }));
    await requestLabel(req, { fetchImpl, env });
    const [url, init] = fetchImpl.mock.calls[0];
    // ADR 0007: the worker is an isolated pod — NEVER 127.0.0.1/localhost.
    expect(url).toBe('http://host.containers.internal:11435/v1/chat/completions');
    expect(String(url)).not.toMatch(/localhost|127\.0\.0\.1/);
    expect((init as RequestInit).method).toBe('POST');
  });

  it('sends messages[] + response_format json_object + the model alias', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music', reason: '' }));
    await requestLabel(req, { fetchImpl, env });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('gemma-4-e4b');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('classify this');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    // The retired Ollama envelope must be gone.
    expect(body.prompt).toBeUndefined();
    expect(body.format).toBeUndefined();
  });

  it('LLM_ENDPOINT / LLM_MODEL override the defaults', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music', reason: '' }));
    await requestLabel(req, {
      fetchImpl,
      env: { LLM_ENDPOINT: 'http://host.containers.internal:9999/v1/chat/completions', LLM_MODEL: 'other-alias' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://host.containers.internal:9999/v1/chat/completions');
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('other-alias');
  });

  it('explicit opts beat the env, and a blank env value falls back to the default', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music', reason: '' }));
    await requestLabel(req, {
      fetchImpl,
      endpoint: 'http://example.invalid/v1/chat/completions',
      env: { LLM_ENDPOINT: 'http://host.containers.internal:9999/v1/chat/completions', LLM_MODEL: '   ' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://example.invalid/v1/chat/completions');
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('gemma-4-e4b');
  });
});

describe('requestLabel — graceful fallback (never throws)', () => {
  it('connection refused → null, no throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    await expect(requestLabel(req, { fetchImpl, env })).resolves.toBeNull();
  });

  it('non-OK HTTP status → null', async () => {
    const fetchImpl = fetchReturning(JSON.stringify({ label: 'music' }), { ok: false });
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
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
    await expect(requestLabel(req, { fetchImpl, env, timeoutMs: 5 })).resolves.toBeNull();
  });

  it('json() that rejects → null', async () => {
    const fetchImpl = vi.fn(async () =>
      ({ ok: true, json: async () => { throw new Error('bad body'); } }) as unknown as Response,
    );
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });

  it.each([
    ['no choices key', {}],
    ['choices not an array', { choices: 'nope' }],
    ['empty choices', { choices: [] }],
    ['choice without message', { choices: [{ index: 0 }] }],
    ['message without content', { choices: [{ message: { role: 'assistant' } }] }],
    ['null envelope', null],
  ])('malformed envelope (%s) → null', async (_name, envelope) => {
    const fetchImpl = fetchReturningEnvelope(envelope);
    expect(await requestLabel(req, { fetchImpl, env })).toBeNull();
  });
});
