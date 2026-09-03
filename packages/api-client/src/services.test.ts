/**
 * Wire contract for the `services.ts` helpers added by the
 * sb/no-raw-api-fetch service-management-UI sweep: `fetchReconfigurePreview`
 * (GET /api/services/:name/reconfigure-preview) and `renameService`
 * (POST /api/services/:name/rename). Both routes shape their own
 * `NextResponse.json(...)` body — not the `{ ok, data }` envelope — so both
 * go through the raw (un-enveloped) seam.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { fetchReconfigurePreview, renameService, TypedFetchError } from './index';

let seen: { url: string; method: string; body: unknown };

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchReconfigurePreview (GET /api/services/:name/reconfigure-preview)', () => {
  it('returns the rendered yaml and unresolved list', async () => {
    stubFetch({ yamlContent: 'apiVersion: v1', unresolved: ['SOME_VAR'] });
    const result = await fetchReconfigurePreview('media');
    expect(seen.url).toBe('/api/services/media/reconfigure-preview');
    expect(seen.method).toBe('GET');
    expect(result.yamlContent).toBe('apiVersion: v1');
    expect(result.unresolved).toEqual(['SOME_VAR']);
  });

  it('defaults unresolved to [] when the field is absent', async () => {
    stubFetch({ yamlContent: 'apiVersion: v1' });
    const result = await fetchReconfigurePreview('media');
    expect(result.unresolved).toEqual([]);
  });

  it('encodes the service name into the URL', async () => {
    stubFetch({ yamlContent: 'x', unresolved: [] });
    await fetchReconfigurePreview('my service');
    expect(seen.url).toBe('/api/services/my%20service/reconfigure-preview');
  });

  it('surfaces the server-authored error message on a 400 (missing vars)', async () => {
    stubFetch(
      { error: 'The template references variables that aren\'t in Settings → Template Variables: FOO.', missing: ['FOO'] },
      400,
    );
    await expect(fetchReconfigurePreview('media')).rejects.toMatchObject({
      message: 'The template references variables that aren\'t in Settings → Template Variables: FOO.',
    });
  });

  it('surfaces the server-authored error message on a 404 (unknown template)', async () => {
    stubFetch({ error: 'No template named "media" found in the registry — can\'t re-render.' }, 404);
    await expect(fetchReconfigurePreview('media')).rejects.toBeInstanceOf(TypedFetchError);
  });
});

describe('renameService (POST /api/services/:name/rename)', () => {
  it('posts the new name and resolves on success', async () => {
    stubFetch({ success: true });
    await renameService('old-name', 'new-name');
    expect(seen.url).toBe('/api/services/old-name/rename');
    expect(seen.method).toBe('POST');
    expect(seen.body).toEqual({ newName: 'new-name' });
  });

  it('appends the node query when a node is given', async () => {
    stubFetch({ success: true });
    await renameService('old-name', 'new-name', 'remote-box');
    expect(seen.url).toBe('/api/services/old-name/rename?node=remote-box');
  });

  it('surfaces the server error message on failure (rename error UI)', async () => {
    stubFetch({ error: 'invalid newName' }, 400);
    await expect(renameService('old-name', '')).rejects.toMatchObject({
      message: 'invalid newName',
    });
  });

  it('surfaces the enveloped error message from an unhandled backend exception', async () => {
    // ServiceManager.renameService throwing lands in withApiHandler's catch
    // block, which answers `{ ok: false, error, code, details }` — a
    // DIFFERENT shape from the route's own explicit `{ error }` 400s, but
    // rawApi reads the same `error` field either way.
    stubFetch({ ok: false, error: 'target name already exists', code: 'CONFLICT' }, 409);
    await expect(renameService('old-name', 'taken-name')).rejects.toMatchObject({
      message: 'target name already exists',
    });
  });
});
