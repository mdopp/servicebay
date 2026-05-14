import { describe, it, expect, vi, afterEach } from 'vitest';
import { runLetsdebugForDomain } from './client';

const SUBMIT_URL = 'https://letsdebug.net/';

function mockFetchSequence(responses: Array<{ status: number; body: unknown; bodyText?: string }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const text = r.bodyText ?? JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  });
}

describe('runLetsdebugForDomain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns { problems: [] } when letsdebug completes with an empty result object', async () => {
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 200, body: { id: 42 } },
      { status: 200, body: { status: 'Complete', result: { problems: [] } } },
    ]));
    const r = await runLetsdebugForDomain('ok.example.com');
    expect(r.problems).toEqual([]);
    expect(r.submissionUrl).toBe(`${SUBMIT_URL}ok.example.com/42`);
  });

  it('returns the problems list when letsdebug completes with findings', async () => {
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 200, body: { id: 7 } },
      { status: 200, body: {
        status: 'Complete',
        result: { problems: [{ name: 'X', explanation: 'broken', severity: 'fatal' }] },
      } },
    ]));
    const r = await runLetsdebugForDomain('fatal.example.com');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].severity).toBe('fatal');
  });

  it('throws on `Complete` with `result: null` so it cannot be mistaken for "no problems"', async () => {
    // Real-world shape when letsdebug aborts the probe mid-flight
    // (rate limit, backend hiccup). Without the guard, our parser
    // silently coerced this to `problems: []` → status:'ok', leading
    // to suspiciously fast OK rows on the health page.
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 200, body: { id: 99 } },
      { status: 200, body: { status: 'Complete', result: null } },
    ]));
    await expect(runLetsdebugForDomain('null.example.com')).rejects.toThrow(/result payload/);
  });

  it('throws on `Complete` with no `result` field at all', async () => {
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 200, body: { id: 100 } },
      { status: 200, body: { status: 'Complete' } },
    ]));
    await expect(runLetsdebugForDomain('missing.example.com')).rejects.toThrow(/result payload/);
  });

  it('throws on submission HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 429, body: { error: 'rate limited' } },
    ]));
    await expect(runLetsdebugForDomain('ratelimited.example.com')).rejects.toThrow(/submission HTTP 429/);
  });

  it('handles PascalCase keys (letsdebug Go default)', async () => {
    vi.stubGlobal('fetch', mockFetchSequence([
      { status: 200, body: { ID: 5 } },
      { status: 200, body: {
        Status: 'Complete',
        Result: { Problems: [{ Name: 'A', Explanation: 'b', Severity: 'warning' }] },
      } },
    ]));
    const r = await runLetsdebugForDomain('pascal.example.com');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].severity).toBe('warning');
  });
});
