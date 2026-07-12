/**
 * Assists editor REST routes (#2221) — all 7 endpoints, driven through the REAL
 * withApiHandler(+Params) → requireSession path. We mock only the auth
 * primitives and the catalog/approvals/editor lib layer, so the test pins the
 * route wiring: validation dispatch, status codes, and the admin (403) gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- lib layer mocks -------------------------------------------------------
const catalog = vi.hoisted(() => ({
  listAssists: vi.fn(),
  getAssist: vi.fn(),
}));
vi.mock('@/lib/assists/catalog', async () => {
  const actual = await vi.importActual<typeof import('@/lib/assists/catalog')>('@/lib/assists/catalog');
  return { ...actual, listAssists: catalog.listAssists, getAssist: catalog.getAssist };
});

const approvals = vi.hoisted(() => ({
  submitApproval: vi.fn(),
  getApproval: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
}));
vi.mock('@/lib/approvals', () => approvals);

const editor = vi.hoisted(() => ({
  writeProposal: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  applyApproved: vi.fn<(...a: unknown[]) => Promise<number>>(async () => 1),
  discardRejected: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  readHistory: vi.fn<(...a: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []),
  readHistoryVersion: vi.fn<(...a: unknown[]) => Promise<string | null>>(),
}));
vi.mock('@/lib/assists/editor', async () => {
  const actual = await vi.importActual<typeof import('@/lib/assists/editor')>('@/lib/assists/editor');
  // Keep the REAL validateProposal / safeAssistId / ProposalValidationError so
  // the propose route's validation is genuinely exercised.
  return { ...actual, ...editor };
});

// --- auth primitives (requireSession's three sources) ----------------------
const auth = vi.hoisted(() => ({
  internalToken: 'internal-secret',
  session: null as null | { user: string; expires: Date },
  token: null as null | { name: string; scopes: string[] },
}));
vi.mock('@/lib/auth/internalToken', () => ({ getInternalApiToken: () => auth.internalToken }));
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSessionFromCookieHeader: vi.fn(async () => auth.session) };
});
vi.mock('@/lib/auth/apiTokens', () => ({
  verifyToken: vi.fn(async () => auth.token),
  tokenIsLive: vi.fn(async () => true),
}));

import { GET as listGET } from './route';
import { GET as getGET } from './[id]/route';
import { POST as proposePOST } from './[id]/propose/route';
import { POST as approvePOST } from './[id]/approve/[requestId]/route';
import { POST as rejectPOST } from './[id]/reject/[requestId]/route';
import { GET as historyGET } from './[id]/history/route';
import { POST as revertPOST } from './[id]/revert/[version]/route';

function req(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): NextRequest {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  let body: string | undefined;
  if (init?.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${url}`, { method: init?.method ?? 'GET', headers, body });
}

const cookie = { cookie: 'sb_session=valid' }; // an admin session

const goodProposal = ['---', 'title: T', 'whenToUse: use it', 'kind: guide', '---', '', 'body'].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  auth.session = null;
  auth.token = null;
  editor.applyApproved.mockResolvedValue(1);
  editor.readHistory.mockResolvedValue([]);
});

describe('GET /api/assists (list)', () => {
  it('returns the catalog list', async () => {
    catalog.listAssists.mockResolvedValue([{ id: 'a', title: 'A', whenToUse: 'x', kind: 'guide', tags: [], source: 'Built-in' }]);
    const res = await listGET(req('/api/assists'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assists).toHaveLength(1);
  });
});

describe('GET /api/assists/:id', () => {
  it('returns raw content', async () => {
    catalog.getAssist.mockResolvedValue(goodProposal);
    const res = await getGET(req('/api/assists/demo'), { params: Promise.resolve({ id: 'demo' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe(goodProposal);
  });
  it('404s an unknown id', async () => {
    catalog.getAssist.mockResolvedValue(null);
    const res = await getGET(req('/api/assists/nope'), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/assists/:id/propose (validation)', () => {
  // Propose is a mutating POST — it needs *a* session, but is NOT admin-gated
  // (approval is the admin gate). Authenticate with an ordinary cookie here.
  beforeEach(() => {
    auth.session = { user: 'contributor', expires: new Date(Date.now() + 60_000) };
  });

  it('requires a session (401 for an unauthenticated caller)', async () => {
    auth.session = null;
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: goodProposal, message: 'edit' } }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(401);
    expect(approvals.submitApproval).not.toHaveBeenCalled();
  });

  it('creates an approval request and returns requestId', async () => {
    approvals.submitApproval.mockResolvedValue({ id: 'req-1' });
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: goodProposal, message: 'edit' }, headers: cookie }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).requestId).toBe('req-1');
    expect(editor.writeProposal).toHaveBeenCalledWith('demo', 'req-1', goodProposal);
  });

  it('rejects a missing title (400)', async () => {
    const bad = ['---', 'whenToUse: x', 'kind: guide', '---', '', 'b'].join('\n');
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: bad, message: 'm' }, headers: cookie }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title/);
    expect(approvals.submitApproval).not.toHaveBeenCalled();
  });

  it('rejects a missing whenToUse (400)', async () => {
    const bad = ['---', 'title: T', 'kind: guide', '---', '', 'b'].join('\n');
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: bad, message: 'm' }, headers: cookie }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/whenToUse/);
  });

  it('rejects an invalid kind (400)', async () => {
    const bad = ['---', 'title: T', 'whenToUse: x', 'kind: banana', '---', '', 'b'].join('\n');
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: bad, message: 'm' }, headers: cookie }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/kind/);
  });

  it('rejects a PEM key in the body (400)', async () => {
    const bad = ['---', 'title: T', 'whenToUse: x', 'kind: guide', '---', '', '-----BEGIN PRIVATE KEY-----', 'z', '-----END PRIVATE KEY-----'].join('\n');
    const res = await proposePOST(
      req('/api/assists/demo/propose', { method: 'POST', body: { content: bad, message: 'm' }, headers: cookie }),
      { params: Promise.resolve({ id: 'demo' }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/secret/);
    expect(approvals.submitApproval).not.toHaveBeenCalled();
  });
});

describe('admin gate — 403 for a non-admin token, 200 for a cookie session', () => {
  const pendingAssistApproval = {
    id: 'req-1',
    status: 'pending',
    payload: { kind: 'assist-edit', assistId: 'demo', message: 'm' },
  };

  it('approve: a read-only token is 403', async () => {
    auth.token = { name: 'reader', scopes: ['read'] };
    const res = await approvePOST(
      req('/api/assists/demo/approve/req-1', { method: 'POST', headers: { authorization: 'Bearer sb_reader' } }),
      { params: Promise.resolve({ id: 'demo', requestId: 'req-1' }) },
    );
    expect(res.status).toBe(403);
    expect(editor.applyApproved).not.toHaveBeenCalled();
  });

  it('approve: a cookie admin applies + marks approved (200)', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    approvals.getApproval.mockResolvedValue(pendingAssistApproval);
    const res = await approvePOST(
      req('/api/assists/demo/approve/req-1', { method: 'POST', headers: cookie }),
      { params: Promise.resolve({ id: 'demo', requestId: 'req-1' }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);
    expect(editor.applyApproved).toHaveBeenCalled();
    expect(approvals.approveApproval).toHaveBeenCalledWith('req-1');
  });

  it('approve: an unauthenticated caller is 401', async () => {
    const res = await approvePOST(
      req('/api/assists/demo/approve/req-1', { method: 'POST' }),
      { params: Promise.resolve({ id: 'demo', requestId: 'req-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('reject: a read-only token is 403', async () => {
    auth.token = { name: 'reader', scopes: ['read'] };
    const res = await rejectPOST(
      req('/api/assists/demo/reject/req-1', { method: 'POST', headers: { authorization: 'Bearer sb_reader' } }),
      { params: Promise.resolve({ id: 'demo', requestId: 'req-1' }) },
    );
    expect(res.status).toBe(403);
    expect(editor.discardRejected).not.toHaveBeenCalled();
  });

  it('reject: a cookie admin discards + marks rejected (200), writes no file', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    approvals.getApproval.mockResolvedValue(pendingAssistApproval);
    const res = await rejectPOST(
      req('/api/assists/demo/reject/req-1', { method: 'POST', headers: cookie }),
      { params: Promise.resolve({ id: 'demo', requestId: 'req-1' }) },
    );
    expect(res.status).toBe(200);
    expect(editor.discardRejected).toHaveBeenCalled();
    expect(approvals.rejectApproval).toHaveBeenCalledWith('req-1');
  });

  it('revert: a read-only token is 403', async () => {
    auth.token = { name: 'reader', scopes: ['read'] };
    const res = await revertPOST(
      req('/api/assists/demo/revert/1', { method: 'POST', headers: { authorization: 'Bearer sb_reader' } }),
      { params: Promise.resolve({ id: 'demo', version: '1' }) },
    );
    expect(res.status).toBe(403);
    expect(approvals.submitApproval).not.toHaveBeenCalled();
  });
});

describe('GET /api/assists/:id/history', () => {
  it('returns the ordered history', async () => {
    editor.readHistory.mockResolvedValue([
      { version: 1, author: 'a', timestamp: 't1', message: 'one' },
      { version: 2, author: 'b', timestamp: 't2', message: 'two' },
    ]);
    const res = await historyGET(req('/api/assists/demo/history'), { params: Promise.resolve({ id: 'demo' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history.map((h: { version: number }) => h.version)).toEqual([1, 2]);
  });
});

describe('POST /api/assists/:id/revert/:version — creates an approval REQUEST, not a silent write', () => {
  it('a cookie admin gets a new requestId; no local file written', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    editor.readHistoryVersion.mockResolvedValue(goodProposal);
    approvals.submitApproval.mockResolvedValue({ id: 'revert-req' });
    const res = await revertPOST(
      req('/api/assists/demo/revert/1', { method: 'POST', headers: cookie }),
      { params: Promise.resolve({ id: 'demo', version: '1' }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestId).toBe('revert-req');
    expect(body.revertOf).toBe(1);
    // It creates a proposal (approval request) — never applies directly.
    expect(approvals.submitApproval).toHaveBeenCalled();
    expect(editor.writeProposal).toHaveBeenCalledWith('demo', 'revert-req', goodProposal);
    expect(editor.applyApproved).not.toHaveBeenCalled();
  });

  it('404s an unknown version', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    editor.readHistoryVersion.mockResolvedValue(null);
    const res = await revertPOST(
      req('/api/assists/demo/revert/99', { method: 'POST', headers: cookie }),
      { params: Promise.resolve({ id: 'demo', version: '99' }) },
    );
    expect(res.status).toBe(404);
  });
});
