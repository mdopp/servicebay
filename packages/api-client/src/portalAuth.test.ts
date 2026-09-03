/**
 * Wire contract for the api-client methods behind the sb/no-raw-api-fetch
 * sweep of login/portal access-request/approvals (#603 migration). These
 * routes shape their own `NextResponse.json(...)` body — never wrapped in
 * `withApiHandler`'s `{ ok, data }` envelope — so they go through
 * `rawApi`/`mutateRawApi`, and the mock below returns bare bodies to match.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  login,
  fetchOidcStatus,
  submitAccessRequest,
  fetchAccessRequestStatus,
  fetchPortalAsset,
  fetchApprovals,
  decideApproval,
  TypedFetchError,
} from './index';

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('login (POST /api/auth/login)', () => {
  it('resolves on success', async () => {
    stubFetch({ success: true });
    await expect(login('admin', 'pw')).resolves.toEqual({ success: true });
  });

  it('surfaces the server-authored error text on invalid credentials', async () => {
    stubFetch({ error: 'Invalid credentials' }, 401);
    await expect(login('admin', 'wrong')).rejects.toThrow(/Invalid credentials/);
  });

  it('surfaces a rate-limit message', async () => {
    stubFetch({ error: 'Too many failed attempts. Try again later.' }, 429);
    await expect(login('admin', 'wrong')).rejects.toThrow(/Too many failed attempts/);
  });
});

describe('fetchOidcStatus (GET /api/auth/oidc/status)', () => {
  it('parses the enabled flag', async () => {
    stubFetch({ enabled: true });
    await expect(fetchOidcStatus()).resolves.toEqual({ enabled: true });
  });

  it('degrades a missing/malformed enabled field to false rather than throwing', async () => {
    stubFetch({});
    await expect(fetchOidcStatus()).resolves.toEqual({ enabled: false });
  });
});

describe('submitAccessRequest (POST /api/system/access-requests)', () => {
  const input = { firstName: 'Ada', lastName: 'Lovelace', username: 'ada', email: 'ada@example.com' };

  it('resolves with the new request id', async () => {
    stubFetch({ ok: true, id: 'req-1' });
    await expect(submitAccessRequest(input)).resolves.toEqual({ ok: true, id: 'req-1' });
  });

  it('surfaces the capacity-guard message on 429', async () => {
    stubFetch({ error: 'This home server has reached its user limit (20).' }, 429);
    await expect(submitAccessRequest(input)).rejects.toThrow(/user limit/);
  });
});

describe('fetchAccessRequestStatus (GET /api/system/access-requests/:id/status)', () => {
  it('parses a pending reply', async () => {
    stubFetch({ status: 'pending', firstName: 'Ada', requestedAt: '2026-01-01T00:00:00Z' });
    await expect(fetchAccessRequestStatus('id-1')).resolves.toEqual({
      status: 'pending',
      firstName: 'Ada',
      requestedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('parses a resolved reply', async () => {
    stubFetch({ status: 'resolved', firstName: 'Ada', username: 'ada', authUrl: 'https://auth.example.com' });
    await expect(fetchAccessRequestStatus('id-1')).resolves.toMatchObject({ status: 'resolved', username: 'ada' });
  });

  it('parses not-found', async () => {
    stubFetch({ status: 'not-found' });
    await expect(fetchAccessRequestStatus('bad-id')).resolves.toEqual({ status: 'not-found' });
  });
});

describe('fetchPortalAsset (GET /api/portal/asset/:service/:kind)', () => {
  it('reads a url-shaped asset (pwa_install / apk_download / audiobookshelf_deeplink)', async () => {
    stubFetch({ url: 'abs://open?url=…' });
    await expect(fetchPortalAsset('audiobookshelf', 'audiobookshelf_deeplink', 'ABS_SUBDOMAIN')).resolves.toEqual({
      url: 'abs://open?url=…',
    });
  });

  it('reads a deviceId-shaped asset (syncthing_qr)', async () => {
    stubFetch({ deviceId: 'ABCD-1234' });
    await expect(fetchPortalAsset('file-share', 'syncthing_qr', 'SYNCTHING_SUBDOMAIN')).resolves.toEqual({
      deviceId: 'ABCD-1234',
    });
  });

  it('carries the HTTP status on a signed-out visitor (401/403)', async () => {
    stubFetch({}, 401);
    await expect(fetchPortalAsset('file-share', 'syncthing_qr', 'SYNCTHING_SUBDOMAIN')).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('Approvals (#2735) — on_approve survives the read', () => {
  it('fetchApprovals keeps the on_approve.mcp action a durable row carries', async () => {
    stubFetch({
      approvals: [{
        id: 'abc-123',
        service: 'mcp',
        title: 'remove_proxy_route',
        description: null,
        payload: { toolName: 'remove_proxy_route', args: { domain: 'tor.dopp.cloud' } },
        on_approve: { mcp: { toolName: 'remove_proxy_route', args: { domain: 'tor.dopp.cloud' } } },
        on_reject: {},
        node: 'local',
        created_at: '2026-07-11T11:00:00Z',
        status: 'pending',
      }],
    });
    const { approvals } = await fetchApprovals();
    expect(approvals[0].on_approve?.mcp?.toolName).toBe('remove_proxy_route');
  });

  it('a row missing on_approve entirely still parses (lenient list read)', async () => {
    stubFetch({
      approvals: [{
        id: 'move-1', service: 'svc', title: 'move draft', description: null,
        payload: {}, node: 'local', created_at: '2026-07-11T11:00:00Z', status: 'pending',
      }],
    });
    const { approvals } = await fetchApprovals();
    expect(approvals[0].on_approve).toBeUndefined();
  });

  it('decideApproval POSTs to approve/reject with no body', async () => {
    stubFetch({ ok: true, restarted: true });
    await expect(decideApproval('abc-123', 'approve')).resolves.toMatchObject({ restarted: true });
  });

  it('surfaces the self-approve guard message', async () => {
    stubFetch({ error: 'A token cannot approve the request it proposed; a ServiceBay admin must approve it.' }, 403);
    await expect(decideApproval('abc-123', 'approve')).rejects.toBeInstanceOf(TypedFetchError);
  });
});
