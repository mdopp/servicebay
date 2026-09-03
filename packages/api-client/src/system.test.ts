/**
 * Wire contract for the `system.ts` helpers added by the
 * sb/no-raw-api-fetch service-management-UI sweep: `fetchFileContent`
 * (GET /api/system/files, backs FileViewerOverlay) and `fetchHelpContent`
 * (GET /api/help, backs SectionHelp). Both routes shape their own
 * `NextResponse.json(...)` body — not the `{ ok, data }` envelope, even
 * though `/api/system/files` is wrapped in `withApiHandler` (it returns a
 * `Response` directly, which bypasses the auto-envelope) — so both go
 * through the raw (un-enveloped) seam.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchFileContent, fetchHelpContent, TypedFetchError } from './index';

let seen: { url: string; method: string };

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), method: init?.method ?? 'GET' };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchFileContent (GET /api/system/files)', () => {
  it('reads the file content', async () => {
    stubFetch({ content: 'hello world' });
    const result = await fetchFileContent('/etc/foo.conf');
    expect(seen.url).toBe('/api/system/files?path=%2Fetc%2Ffoo.conf');
    expect(result.content).toBe('hello world');
  });

  it('adds the node param when given', async () => {
    stubFetch({ content: 'x' });
    await fetchFileContent('/etc/foo.conf', 'remote-box');
    expect(seen.url).toBe('/api/system/files?path=%2Fetc%2Ffoo.conf&node=remote-box');
  });

  it('surfaces the server error message on a 404', async () => {
    stubFetch({ error: 'File not found' }, 404);
    await expect(fetchFileContent('/missing')).rejects.toMatchObject({ message: 'File not found' });
  });

  it('defaults content to empty string when the field is absent', async () => {
    stubFetch({});
    const result = await fetchFileContent('/etc/foo.conf');
    expect(result.content).toBe('');
  });
});

describe('fetchHelpContent (GET /api/help)', () => {
  it('reads the help markdown content', async () => {
    stubFetch({ content: '# Help' });
    const result = await fetchHelpContent('container-engine');
    expect(seen.url).toBe('/api/help?id=container-engine');
    expect(result.content).toBe('# Help');
  });

  it('rejects with a 404 TypedFetchError when the topic is unknown', async () => {
    stubFetch({ error: 'Help content not found' }, 404);
    const err = await fetchHelpContent('nonexistent').catch(e => e);
    expect(err).toBeInstanceOf(TypedFetchError);
    expect((err as TypedFetchError).status).toBe(404);
  });
});
