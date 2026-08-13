/**
 * POST / DELETE /api/health/checks — the check-id boundary (#2536).
 *
 * A check id is a *file name*: `HealthStore` builds the result file as
 * `<DATA_DIR>/results/<id>.json` and `CheckRunner` writes it on every tick.
 * The POST body used to take `id` as a bare `z.string().min(1).max(64)`, so a
 * caller-supplied id with a separator or a `..` segment escaped DATA_DIR.
 *
 * These tests pin two independent guarantees:
 *   1. the shared `CheckIdString` rejects a traversal-shaped id at the schema,
 *      before the handler runs — the same rule the `[id]/history` and
 *      `[id]/run` sub-routes already apply, so the four id-handling routes
 *      can't drift apart;
 *   2. even a *well-formed* id from an untrusted caller no longer picks the
 *      file name — the route mints one server-side (as the MCP
 *      `create_health_check` tool already does) and honours an incoming id
 *      only as an upsert key for an existing check or for ServiceBay's own
 *      internal caller.
 *
 * The route's wrapper is stubbed, but the stub applies the route's REAL zod
 * schemas — so a loosened schema fails here rather than live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { SCRIPT_CHECK_REMOVED_MESSAGE, type CheckConfig } from '@/lib/health/types';

const mocks = vi.hoisted(() => ({
  saveCheck: vi.fn(),
  getChecks: vi.fn((): unknown[] => []),
  getResults: vi.fn((): unknown[] => []),
  deleteCheck: vi.fn(() => true),
  /** Mutable per test: the principal the wrapper hands the handler. */
  auth: { user: 'admin' } as { user: string } | undefined,
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    saveCheck: mocks.saveCheck,
    getChecks: mocks.getChecks,
    getResults: mocks.getResults,
    deleteCheck: mocks.deleteCheck,
  },
}));

vi.mock('@/lib/diagnose/diagnoseChecks', () => ({
  getDiagnoseChecksEnriched: vi.fn(() => []),
}));

vi.mock('@/lib/health/checkAttribution', () => ({
  buildServiceAttributionIndex: vi.fn(() => ({})),
  resolveDomainCheckService: vi.fn(() => null),
}));

// Mirrors the real wrapper: parse body/query with the route's own schemas,
// 400 on a ZodError, envelope a plain return value.
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      opts: { body?: z.ZodType<unknown>; query?: z.ZodType<unknown> },
      handler: (ctx: {
        body: unknown;
        query: unknown;
        request: NextRequest;
        auth?: { user: string };
      }) => Promise<unknown>,
    ) =>
    async (request: NextRequest) => {
      try {
        const raw = opts.body ? await request.json() : undefined;
        const body = opts.body ? opts.body.parse(raw) : undefined;
        const query = opts.query
          ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams))
          : undefined;
        const result = await handler({ body, query, request, auth: mocks.auth });
        if (result instanceof Response) return result;
        return NextResponse.json({ ok: true, data: result });
      } catch (e) {
        if (e instanceof z.ZodError) {
          // Mirrors the real wrapper, which ships `details: e.flatten()` — the
          // per-field messages are what a caller actually reads, so a test that
          // dropped them couldn't tell a clear refusal from a generic one.
          return NextResponse.json(
            { ok: false, error: 'validation failed', code: 'VALIDATION', details: e.flatten() },
            { status: 400 },
          );
        }
        throw e;
      }
    },
}));

import { POST, DELETE } from './route';

function post(body: unknown) {
  const req = new NextRequest('http://localhost:5888/api/health/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

function del(rawId: string) {
  const req = new NextRequest(
    `http://localhost:5888/api/health/checks?id=${encodeURIComponent(rawId)}`,
    { method: 'DELETE' },
  );
  return DELETE(req);
}

/** A body that is legitimate in every field the tests don't deliberately break. */
function validBody(overrides: Record<string, unknown> = {}) {
  return { name: 'demo', type: 'ping', target: '127.0.0.1', ...overrides };
}

const storedCheck = (id: string): CheckConfig => ({
  id,
  name: 'existing',
  type: 'ping',
  target: '10.0.0.1',
  interval: 60,
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
});

/** The id the route actually persisted for the last saveCheck call. */
function savedId(): string {
  expect(mocks.saveCheck).toHaveBeenCalledTimes(1);
  return (mocks.saveCheck.mock.calls[0][0] as CheckConfig).id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  mocks.saveCheck.mockReset();
  mocks.getChecks.mockReset().mockReturnValue([]);
  mocks.getResults.mockReset().mockReturnValue([]);
  mocks.deleteCheck.mockReset().mockReturnValue(true);
  mocks.auth = { user: 'admin' };
});

describe('POST /api/health/checks — a traversal-shaped id is rejected at the schema (#2536)', () => {
  // Each of these would land `<DATA_DIR>/results/<id>.json` outside the
  // results directory once CheckRunner persisted the check's first result.
  const traversals = [
    '../pwn',
    '../../pwn',
    '../../../../etc/cron.d/pwn',
    './../config',
    'results/../../config',
    'a/b',
    'a\\b',
    '/etc/passwd',
    '..%2fpwn',
    'x\0y',
  ];

  for (const id of traversals) {
    it(`rejects id ${JSON.stringify(id)} and never reaches the store`, async () => {
      const res = await post(validBody({ id }));
      expect(res.status).toBe(400);
      expect(mocks.saveCheck).not.toHaveBeenCalled();
    });
  }

  it('rejects an id longer than the shared schema allows', async () => {
    const res = await post(validBody({ id: 'a'.repeat(129) }));
    expect(res.status).toBe(400);
    expect(mocks.saveCheck).not.toHaveBeenCalled();
  });

  it('rejects an empty id rather than falling back to a mint', async () => {
    const res = await post(validBody({ id: '' }));
    expect(res.status).toBe(400);
    expect(mocks.saveCheck).not.toHaveBeenCalled();
  });
});

describe('POST /api/health/checks — the id is minted server-side (#2536)', () => {
  it('ignores a well-formed id from a session caller and mints a UUID', async () => {
    // Schema-clean, so it survives CheckIdString — but it is still a caller
    // choosing a file name under DATA_DIR/results, which is the actual defect.
    const res = await post(validBody({ id: 'cert_expiry' }));
    expect(res.status).toBe(200);
    expect(savedId()).toMatch(UUID_RE);
  });

  it('mints a UUID when no id is supplied at all (the UI create flow)', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(savedId()).toMatch(UUID_RE);
  });

  it('honours an id that names an ALREADY-STORED check (the UI edit flow)', async () => {
    mocks.getChecks.mockReturnValue([storedCheck('11111111-2222-4333-8444-555555555555')]);
    const res = await post(
      validBody({ id: '11111111-2222-4333-8444-555555555555', name: 'renamed' }),
    );
    expect(res.status).toBe(200);
    expect(savedId()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('honours an id that names a stored deterministic check (domain: / lan_ip_drift)', async () => {
    mocks.getChecks.mockReturnValue([
      storedCheck('domain:nginx.example.com'),
      storedCheck('lan_ip_drift'),
    ]);
    for (const id of ['domain:nginx.example.com', 'lan_ip_drift']) {
      mocks.saveCheck.mockReset();
      const res = await post(validBody({ id }));
      expect(res.status).toBe(200);
      expect(savedId()).toBe(id);
    }
  });

  it('lets the internal caller register a NEW slug id (#1551 template post-deploy)', async () => {
    mocks.auth = { user: 'internal' };
    const res = await post(
      validBody({ id: 'home-assistant-api', type: 'http', target: 'http://127.0.0.1:8123/' }),
    );
    expect(res.status).toBe(200);
    expect(savedId()).toBe('home-assistant-api');
  });

  it('still flags the #1670 system-check bypass for the internal loopback caller', async () => {
    mocks.auth = { user: 'internal' };
    await post(validBody({ id: 'ollama-api', type: 'http', target: 'http://127.0.0.1:11434/' }));
    expect((mocks.saveCheck.mock.calls[0][0] as CheckConfig & { systemCheck?: boolean }).systemCheck)
      .toBe(true);
  });
});

describe('POST /api/health/checks — legitimate checks still round-trip', () => {
  const types = [
    { type: 'ping', target: '192.168.1.1' },
    { type: 'http', target: 'https://example.com/healthz' },
    { type: 'podman', target: 'media-jellyfin' },
    { type: 'service', target: 'immich' },
    { type: 'systemd', target: 'podman.socket' },
  ];

  for (const { type, target } of types) {
    it(`creates a ${type} check with the caller's fields intact`, async () => {
      const res = await post(validBody({ name: `probe ${type}`, type, target, interval: 120 }));
      expect(res.status).toBe(200);
      const saved = mocks.saveCheck.mock.calls[0][0] as CheckConfig;
      expect(saved).toMatchObject({ name: `probe ${type}`, type, target, interval: 120, enabled: true });
      expect(saved.id).toMatch(UUID_RE);
    });
  }
});

describe('POST /api/health/checks — the removed script type is refused with a reason (#2535)', () => {
  // `type: "script"` interpolated the target into `(async () => { … })()` and
  // ran it with `vm.runInContext` inside the backend process. The probe is
  // deleted, so the route must refuse the type — and refuse it *legibly*: the
  // caller most likely to send one is a template post-deploy written against an
  // older box, and a bare "invalid enum value" would read as a ServiceBay bug.
  it('rejects type "script" and never reaches the store', async () => {
    const res = await post(validBody({ type: 'script', target: 'return true' }));
    expect(res.status).toBe(400);
    expect(mocks.saveCheck).not.toHaveBeenCalled();
  });

  it('explains WHY, naming the removal and the replacement', async () => {
    const res = await post(validBody({ type: 'script', target: 'return true' }));
    const body = (await res.json()) as { details?: { fieldErrors?: Record<string, string[]> } };
    const messages = (body.details?.fieldErrors?.type ?? []).join(' ');
    expect(messages).toBe(SCRIPT_CHECK_REMOVED_MESSAGE);
    expect(messages).toMatch(/removed for security/);
    expect(messages).toMatch(/"http" check/);
  });

  it('still rejects any other unknown type (the enum is not weakened)', async () => {
    const res = await post(validBody({ type: 'exec', target: 'id' }));
    expect(res.status).toBe(400);
    expect(mocks.saveCheck).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/health/checks — one id rule, shared with the sibling routes (#2536)', () => {
  it('deletes a stored check by a well-formed id', async () => {
    const res = await del('11111111-2222-4333-8444-555555555555');
    expect(res.status).toBe(200);
    expect(mocks.deleteCheck).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555');
  });

  it('still answers honestly for a synthetic diagnose row', async () => {
    const res = await del('diagnose:sso_verify');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'DIAGNOSE_NOT_DELETABLE' });
    expect(mocks.deleteCheck).not.toHaveBeenCalled();
  });

  it('rejects a traversal-shaped id instead of passing it to the store', async () => {
    const res = await del('../../etc/passwd');
    expect(res.status).toBe(400);
    expect(mocks.deleteCheck).not.toHaveBeenCalled();
  });
});
