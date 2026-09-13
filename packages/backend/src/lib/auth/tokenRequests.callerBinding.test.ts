import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * #2930 — an approved token request hands out a credential, and collection must
 * be bound to the PRINCIPAL that asked, not to the request id. Before this, any
 * caller that knew (or enumerated) the id could collect another agent's grant,
 * and the rightful requester saw only `token: null` with no explanation.
 *
 * The last `describe` is a CLASS GATE: it enumerates every request kind that
 * ends with a collectable secret straight from `SECRET_YIELDING_REQUEST_KINDS`
 * in the module under test — and cross-checks that union against the mint sites
 * actually present in the source — so a new kind added without the caller
 * binding turns this file red instead of shipping a second collectable-by-
 * anyone grant path.
 *
 * Real-fs DATA_DIR per test, like the sibling tokenRequests tests. Every secret
 * here is minted by the code under test into a throwaway temp dir.
 */
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});
// submitApproval (the one-shot path) resolves a target node — stub the registry
// so the store never reaches a real node.
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-tokreq-bind-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await (await import('@/lib/auth/apiTokens')).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const loadReq = () => import('@/lib/auth/tokenRequests');

/** The agent that files the request, and the co-resident one that must not
 *  be able to redeem it. */
const OWNER = 'token:agent-a';
const OTHER = 'token:agent-b';
const asOwner = { principal: OWNER };
const asOther = { principal: OTHER };
/** The operator at the dashboard: full LIST visibility, no collection right. */
const asConsole = { principal: 'admin@box', console: true as const };
/** Callers whose identity the transport could not authoritatively resolve. */
const UNRESOLVED = [
  { label: 'empty principal', caller: { principal: '' } },
  { label: 'whitespace principal', caller: { principal: '   ' } },
  { label: 'unresolved principal claiming the console', caller: { principal: '', console: true as const } },
];

const TOKEN_SHAPE = /^sb_[0-9a-f]{8}_[A-Z2-9]+$/;

describe('token-request collection is bound to the requesting principal (#2930)', () => {
  it('a second caller polling an approved request is REFUSED, loudly — and the owner can still collect', async () => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest, TokenRequestError } = await loadReq();
    const req = await submitTokenRequest({
      requestedScopes: ['read', 'lifecycle'], requestedTtlSecs: 600, reason: 'deploy one service', requestedBy: OWNER,
    });
    await approveTokenRequest(req.id, { scopes: ['read'], ttlSecs: 600, approvedBy: 'admin' });

    // The co-resident token races the owner to the grant.
    const stolen = pollTokenRequest(req.id, asOther);
    await expect(stolen).rejects.toBeInstanceOf(TokenRequestError);
    await expect(stolen).rejects.toMatchObject({ status: 403 });
    // Distinguishable: it names the binding, and is NOT the "already collected"
    // answer a silent null would have been.
    await expect(stolen).rejects.toThrow(/filed by another principal/i);

    // The refusal did not consume the one-time hand-off: the rightful requester
    // still gets its token.
    const mine = await pollTokenRequest(req.id, asOwner);
    expect(mine.token).toMatch(TOKEN_SHAPE);
    expect((mine as { collected?: boolean }).collected).toBe(true);
  });

  it('after the owner collects, the other caller still gets the refusal — never a bare null', async () => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest } = await loadReq();
    const req = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'r', requestedBy: OWNER,
    });
    await approveTokenRequest(req.id);
    expect((await pollTokenRequest(req.id, asOwner)).token).toMatch(TOKEN_SHAPE);

    await expect(pollTokenRequest(req.id, asOther)).rejects.toMatchObject({ status: 403 });
    // The owner's own repeat poll is the collected-already answer, and it is a
    // VALUE — the two outcomes stay tellable apart.
    const again = await pollTokenRequest(req.id, asOwner);
    expect(again.status).toBe('approved');
    expect(again.token).toBeNull();
  });

  it('a PENDING request cannot be observed by another principal either', async () => {
    const { submitTokenRequest, pollTokenRequest } = await loadReq();
    const req = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'r', requestedBy: OWNER,
    });
    await expect(pollTokenRequest(req.id, asOther)).rejects.toMatchObject({ status: 403 });
    expect((await pollTokenRequest(req.id, asOwner)).status).toBe('pending');
  });

  it('an unknown id is still a plain not-found — the refusal is about the binding, not about existence', async () => {
    const { pollTokenRequest } = await loadReq();
    const res = await pollTokenRequest('no-such-request', asOther);
    expect(res.status).toBe('not-found');
    expect(res.token).toBeNull();
  });
});

describe('a caller that cannot be resolved is refused, never assumed to be the requester (#2930)', () => {
  it.each(UNRESOLVED)('poll with an $label is refused', async ({ caller }) => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest, TokenRequestError } = await loadReq();
    const req = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'r', requestedBy: OWNER,
    });
    await approveTokenRequest(req.id);

    const attempt = pollTokenRequest(req.id, caller);
    await expect(attempt).rejects.toBeInstanceOf(TokenRequestError);
    await expect(attempt).rejects.toThrow(/could not be resolved/i);
    // ...and the grant survives for its owner.
    expect((await pollTokenRequest(req.id, asOwner)).token).toMatch(TOKEN_SHAPE);
  });

  it.each(UNRESOLVED)('list with an $label is refused rather than served unfiltered', async ({ caller }) => {
    const { submitTokenRequest, listTokenRequests } = await loadReq();
    await submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'r', requestedBy: OWNER });
    await expect(listTokenRequests('all', caller)).rejects.toMatchObject({ status: 403 });
  });

  it('a request cannot be filed without an authenticated principal', async () => {
    const { submitTokenRequest, TokenRequestError } = await loadReq();
    for (const requestedBy of ['', '   ']) {
      const filing = submitTokenRequest({
        requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'r', requestedBy,
      });
      await expect(filing).rejects.toBeInstanceOf(TokenRequestError);
      await expect(filing).rejects.toMatchObject({ status: 403 });
    }
  });

  it('a legacy row with no recorded principal is collectable by NOBODY', async () => {
    const { pollTokenRequest } = await loadReq();
    // A row written before the binding existed: approved, secret on disk, no
    // `requestedBy`. First-poller-wins is exactly what must not happen.
    await fsp.writeFile(path.join(dataDir, 'token-requests.json'), JSON.stringify([{
      id: 'legacy-1',
      requestedScopes: ['read'],
      requestedTtlSecs: 600,
      reason: 'filed before the binding',
      status: 'approved',
      createdAt: new Date().toISOString(),
      grantedScopes: ['read'],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      tokenId: 'deadbeef',
      pendingSecret: 'sb_deadbeef_SYNTHETICFIXTUREVALUE',
    }]));
    for (const caller of [asOwner, asOther, asConsole]) {
      await expect(pollTokenRequest('legacy-1', caller)).rejects.toThrow(/no requesting principal/i);
    }
  });
});

describe('listing is bound too — a token caller cannot enumerate ids that are not its own (#2930)', () => {
  it('each agent sees only its own rows; the operator console keeps full visibility', async () => {
    const { submitTokenRequest, listTokenRequests } = await loadReq();
    const mine = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'mine', requestedBy: OWNER,
    });
    const theirs = await submitTokenRequest({
      requestedScopes: ['destroy'], requestedTtlSecs: 600, reason: 'theirs', requestedBy: OTHER,
    });

    expect((await listTokenRequests('all', asOwner)).map(r => r.id)).toEqual([mine.id]);
    expect((await listTokenRequests('all', asOther)).map(r => r.id)).toEqual([theirs.id]);

    // The admin surface still sees both — that list is how the operator triages.
    const console_ = (await listTokenRequests('all', asConsole)).map(r => r.id);
    expect(console_).toContain(mine.id);
    expect(console_).toContain(theirs.id);
  });

  it('the status filter composes with the binding instead of leaking past it', async () => {
    const { submitTokenRequest, approveTokenRequest, listTokenRequests } = await loadReq();
    const mine = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'mine', requestedBy: OWNER,
    });
    const theirs = await submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 600, reason: 'theirs', requestedBy: OTHER,
    });
    await approveTokenRequest(theirs.id);

    expect(await listTokenRequests('approved', asOwner)).toEqual([]);
    expect((await listTokenRequests('pending', asOwner)).map(r => r.id)).toEqual([mine.id]);
    expect((await listTokenRequests('approved', asConsole)).map(r => r.id)).toEqual([theirs.id]);
  });
});

/* ------------------------------------------------------------------ *
 * CLASS GATE
 * ------------------------------------------------------------------ */

/** Drives one request kind from "filed" to "secret sitting on the row". */
interface KindDriver {
  /** File a request of this kind as `principal` and get it approved+minted. */
  readyToCollect(principal: string): Promise<string>;
}

describe('CLASS GATE: every secret-yielding request kind refuses a non-requesting caller (#2930)', () => {
  /**
   * Keyed by the exported union, NOT by a list written out here: adding a member
   * to `SecretYieldingRequestKind` without adding its driver is a type error in
   * this table, and the runtime check below catches a registry entry that never
   * made it into the union.
   */
  const drivers: Record<import('./tokenRequests').SecretYieldingRequestKind, KindDriver> = {
    standing: {
      async readyToCollect(principal) {
        const { submitTokenRequest, approveTokenRequest } = await loadReq();
        const req = await submitTokenRequest({
          requestedScopes: ['read', 'lifecycle'], requestedTtlSecs: 600, reason: 'standing grant', requestedBy: principal,
        });
        await approveTokenRequest(req.id, { scopes: ['read'], ttlSecs: 600, approvedBy: 'admin' });
        return req.id;
      },
    },
    'one-shot': {
      async readyToCollect(principal) {
        const { submitTokenRequest, mintOneShotForRequest } = await loadReq();
        const req = await submitTokenRequest({
          requestedScopes: ['destroy'], requestedTtlSecs: 300, reason: 'one-shot elevation', requestedBy: principal,
          oneShotOp: { toolName: 'delete_service', service: 'media' },
        });
        await mintOneShotForRequest(req.id);
        return req.id;
      },
    },
  };

  it('the registry, the union and this table describe the same set of kinds', async () => {
    const { SECRET_YIELDING_REQUEST_KINDS } = await loadReq();
    expect(Object.keys(drivers).sort()).toEqual(Object.keys(SECRET_YIELDING_REQUEST_KINDS).sort());
  });

  it('every mint site in tokenRequests.ts is a registered kind', async () => {
    // The union is only trustworthy while it still covers the source. Derive the
    // real mint sites — every function that stashes a `pendingSecret` — and hold
    // the registry against them, so a THIRD mint path added without registering
    // it (and therefore without a driver above) turns this red.
    const src = await fsp.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokenRequests.ts'),
      'utf-8',
    );
    const lines = src.split('\n');
    const mintSites = new Set<string>();
    let current = '';
    for (const line of lines) {
      const fn = line.match(/^export (?:async )?function ([A-Za-z0-9_]+)/);
      if (fn) current = fn[1];
      if (/\.pendingSecret\s*=[^=]/.test(line) || /^\s*pendingSecret:/.test(line)) {
        expect(current, `a pendingSecret write outside an exported function: ${line.trim()}`).toBeTruthy();
        mintSites.add(current);
      }
    }
    expect(mintSites.size).toBeGreaterThan(0);

    const { SECRET_YIELDING_REQUEST_KINDS } = await loadReq();
    const registered = Object.values(SECRET_YIELDING_REQUEST_KINDS).map(k => k.mintedBy);
    expect([...mintSites].sort()).toEqual([...registered].sort());
  });

  // Derived from the union-keyed table above — never a list spelled out here,
  // so a new `SecretYieldingRequestKind` shows up as a new case automatically.
  const kinds = Object.keys(drivers) as (keyof typeof drivers)[];
  it.each(kinds)('kind "%s": a non-requesting caller cannot collect the secret', async (kind) => {
    const { pollTokenRequest, listTokenRequests, TokenRequestError, SECRET_YIELDING_REQUEST_KINDS } = await loadReq();
    // The row itself must be one this gate knows about (guards a rename).
    expect(SECRET_YIELDING_REQUEST_KINDS[kind]).toBeTruthy();

    const id = await drivers[kind].readyToCollect(OWNER);

    for (const caller of [asOther, asConsole, ...UNRESOLVED.map(u => u.caller)]) {
      const attempt = pollTokenRequest(id, caller);
      await expect(attempt, `${SECRET_YIELDING_REQUEST_KINDS[kind].describe} handed its secret to ${caller.principal || '<unresolved>'}`)
        .rejects.toBeInstanceOf(TokenRequestError);
      await expect(attempt).rejects.toMatchObject({ status: 403 });
    }

    // Nor can a stranger even see the id to try.
    expect((await listTokenRequests('all', asOther)).map(r => r.id)).not.toContain(id);

    // The owner's single hand-off is intact after all of that.
    const collected = await pollTokenRequest(id, asOwner);
    expect(collected.token).toMatch(TOKEN_SHAPE);
  });
});
