/**
 * MCP-driven scoped token *request* queue (#2139, security).
 *
 * A caller with no (or a narrow) token asks for a short-lived, least-privilege
 * `sb_` token via the MCP `request_token` tool: it names the scopes it wants, a
 * human reason, and a requested TTL — and gets back a pending *request id*, NOT
 * a token. A ServiceBay admin then approves (optionally narrowing the granted
 * scopes and/or overriding the TTL) or denies from the dashboard. Only on
 * approval does a real token get minted (via `createToken`), and the caller
 * fetches it exactly once by polling with `poll_token_request`.
 *
 * WHY A DEDICATED STORE (not `config.accessRequests`):
 * `config.accessRequests` is the LLDAP *user-onboarding* queue — its one-click
 * approve provisions an LLDAP account and demands a `username`. Overloading it
 * to also mint API tokens would fuse the (security-sensitive) token-issuance
 * path into the user-provisioning route and force every consumer to branch on a
 * `kind`. Instead this mirrors the same pending→approve/adjust/deny→poll
 * *pattern* in its own file, exactly as `approvals/index.ts` (the file-move
 * approval queue) already coexists with `config.accessRequests` as a parallel
 * approval mechanism. The token store (`apiTokens.ts`) is where issuance lives,
 * so its request queue lives right beside it.
 *
 * Least privilege by default: the admin can only grant scopes the requester
 * asked for OR fewer — this store never lets an approval *widen* beyond the
 * request (a widen attempt is rejected). The TTL can be overridden freely
 * (shorter is safer; the admin owns the ceiling).
 *
 * Persistence is a single JSON file under DATA_DIR, atomic-written like the
 * token store itself. A missing/corrupt file reads back as an empty list.
 * The minted token's *secret* is held only transiently in memory for the
 * single poll that retrieves it — never persisted here (only the public
 * token id is recorded, for the lifecycle/audit view).
 */
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { atomicWriteFile } from '@/lib/util/atomicWrite';
import { logger } from '@/lib/logger';
import { ALL_SCOPES, type ApiScope } from './apiScope';
import { createToken, revokeToken } from './apiTokens';

const TAG = 'auth:tokenRequests';
const STORE_PATH = path.join(DATA_DIR, 'token-requests.json');

/** Anti-spam cap on outstanding pending token requests (mirrors the
 *  access-request MAX_PENDING). A hostile caller can't fill the disk. */
export const MAX_PENDING_TOKEN_REQUESTS = 50;

/** Hard ceiling on a requested/granted TTL: 30 days in seconds. A token
 *  minted through this flow is meant to be short-lived; this caps a runaway
 *  or fat-fingered TTL so an "approve" can't accidentally mint a near-eternal
 *  credential. The admin can still grant anything up to this. */
export const MAX_TTL_SECS = 30 * 24 * 60 * 60;

export type TokenRequestStatus = 'pending' | 'approved' | 'denied';

export interface TokenRequest {
  id: string;
  /** Scopes the caller asked for (validated against ALL_SCOPES at submit). */
  requestedScopes: ApiScope[];
  /** Requested time-to-live, in seconds. */
  requestedTtlSecs: number;
  /** Human-readable justification for the admin to weigh. */
  reason: string;
  /** Calling agent/token identity for the audit trail (optional). */
  requestedBy?: string;
  status: TokenRequestStatus;
  createdAt: string;
  /** ISO time the admin approved/denied it. */
  resolvedAt?: string;
  /** Scopes actually granted (⊆ requestedScopes). Set on approve. */
  grantedScopes?: ApiScope[];
  /** TTL the admin granted (≤ MAX_TTL_SECS). Set on approve. */
  grantedTtlSecs?: number;
  /** Expiry of the minted token. Set on approve. */
  expiresAt?: string;
  /** Public id of the minted token (never the secret). Set on approve. */
  tokenId?: string;
  /**
   * The clear-text `sb_..._...` secret, held ONLY until the first successful
   * poll retrieves it, then wiped from the store. Never surfaced by the list
   * view. This is the one-time hand-off channel — poll once, or re-request.
   */
  pendingSecret?: string;
}

/** Caller-facing view: the one-time secret is stripped from every list/audit
 *  surface. Only `poll` ever returns the secret, and only once. */
export type TokenRequestView = Omit<TokenRequest, 'pendingSecret'>;

function publicView(r: TokenRequest): TokenRequestView {
  const { pendingSecret: _secret, ...rest } = r;
  void _secret;
  return rest;
}

async function readStore(): Promise<TokenRequest[]> {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TokenRequest[]) : [];
  } catch {
    return []; // missing (fresh box) or corrupt → no pending requests
  }
}

async function writeStore(requests: TokenRequest[]): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await atomicWriteFile(STORE_PATH, JSON.stringify(requests, null, 2));
  // Same protection class as api-tokens.json — a live grant's one-time secret
  // sits here between approve and the first poll.
  try { await fsp.chmod(STORE_PATH, 0o600); } catch { /* best-effort */ }
}

function assertScopes(scopes: readonly string[], label: string): asserts scopes is ApiScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TokenRequestError(`${label}: at least one scope is required`, 400);
  }
  for (const s of scopes) {
    if (!ALL_SCOPES.includes(s as ApiScope)) {
      throw new TokenRequestError(`${label}: unknown scope "${s}"`, 400);
    }
  }
}

function assertTtl(ttlSecs: number, label: string): void {
  if (!Number.isFinite(ttlSecs) || ttlSecs <= 0) {
    throw new TokenRequestError(`${label}: ttlSecs must be a positive number`, 400);
  }
  if (ttlSecs > MAX_TTL_SECS) {
    throw new TokenRequestError(`${label}: ttlSecs ${ttlSecs} exceeds the ${MAX_TTL_SECS}s ceiling`, 400);
  }
}

/** Raised on an invalid request/approve. `status` maps to the HTTP response
 *  in the admin route; the MCP tools surface `.message`. */
export class TokenRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'TokenRequestError';
  }
}

/** File a pending token request. Returns its id + status — NO token yet. */
export async function submitTokenRequest(input: {
  requestedScopes: ApiScope[];
  requestedTtlSecs: number;
  reason: string;
  requestedBy?: string;
}): Promise<TokenRequestView> {
  assertScopes(input.requestedScopes, 'requestedScopes');
  assertTtl(input.requestedTtlSecs, 'requestedTtlSecs');
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new TokenRequestError('reason is required', 400);

  const all = await readStore();
  const pending = all.filter(r => r.status === 'pending');
  if (pending.length >= MAX_PENDING_TOKEN_REQUESTS) {
    throw new TokenRequestError(
      `Too many pending token requests (${pending.length}/${MAX_PENDING_TOKEN_REQUESTS}). The admin must resolve existing ones first.`,
      409,
    );
  }

  const request: TokenRequest = {
    id: randomUUID(),
    requestedScopes: [...new Set(input.requestedScopes)],
    requestedTtlSecs: input.requestedTtlSecs,
    reason: reason.slice(0, 1000),
    ...(input.requestedBy ? { requestedBy: input.requestedBy.slice(0, 120) } : {}),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  all.push(request);
  await writeStore(all);
  logger.info(TAG, `submitted token request ${request.id} scopes=[${request.requestedScopes.join(',')}] ttl=${request.requestedTtlSecs}s by ${input.requestedBy ?? 'anon'}`);
  return publicView(request);
}

/** List every request (newest first). Secrets are never included. */
export async function listTokenRequests(
  status?: TokenRequestStatus | 'all',
): Promise<TokenRequestView[]> {
  const all = await readStore();
  const filtered = !status || status === 'all' ? all : all.filter(r => r.status === status);
  return [...filtered]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicView);
}

/** Fetch one request (no secret), or null. */
export async function getTokenRequest(id: string): Promise<TokenRequestView | null> {
  const all = await readStore();
  const r = all.find(x => x.id === id);
  return r ? publicView(r) : null;
}

/**
 * Admin approves a pending request, optionally narrowing the granted scopes
 * and/or overriding the TTL. Mints the real token via `createToken`, records
 * the granted grant + minted token id + expiry, and stashes the one-time
 * secret for the caller's next poll. Least privilege is enforced: the granted
 * scopes must be a SUBSET of what was requested (a widen is rejected).
 */
export async function approveTokenRequest(
  id: string,
  opts: { scopes?: ApiScope[]; ttlSecs?: number; approvedBy?: string } = {},
): Promise<TokenRequestView> {
  const all = await readStore();
  const req = all.find(r => r.id === id);
  if (!req) throw new TokenRequestError(`Token request not found: ${id}`, 404);
  if (req.status !== 'pending') {
    throw new TokenRequestError(`Token request ${id} is already ${req.status}`, 409);
  }

  // Resolve the granted scopes: default to what was requested; if the admin
  // adjusts, it must stay within the requested set (grant fewer, never more).
  const grantedScopes = opts.scopes ?? req.requestedScopes;
  assertScopes(grantedScopes, 'grantedScopes');
  const requestedSet = new Set(req.requestedScopes);
  const widened = grantedScopes.filter(s => !requestedSet.has(s));
  if (widened.length > 0) {
    throw new TokenRequestError(
      `Cannot grant scopes beyond the request: [${widened.join(',')}] were not requested. Grant fewer, never more.`,
      403,
    );
  }

  const grantedTtlSecs = opts.ttlSecs ?? req.requestedTtlSecs;
  assertTtl(grantedTtlSecs, 'grantedTtlSecs');
  const expiresAt = new Date(Date.now() + grantedTtlSecs * 1000).toISOString();

  const minted = await createToken({
    name: `mcp-request:${id.slice(0, 8)}`,
    scopes: [...new Set(grantedScopes)],
    expiresAt,
    createdBy: opts.approvedBy ? `admin:${opts.approvedBy}` : 'admin:token-request',
  });

  req.status = 'approved';
  req.resolvedAt = new Date().toISOString();
  req.grantedScopes = [...new Set(grantedScopes)];
  req.grantedTtlSecs = grantedTtlSecs;
  req.expiresAt = expiresAt;
  req.tokenId = minted.token.id;
  req.pendingSecret = minted.secret; // one-time hand-off, wiped on first poll
  await writeStore(all);
  logger.info(TAG, `approved token request ${id} → token ${minted.token.id} scopes=[${req.grantedScopes.join(',')}] ttl=${grantedTtlSecs}s`);
  return publicView(req);
}

/** Admin denies a pending request. No token is minted. */
export async function denyTokenRequest(id: string): Promise<TokenRequestView> {
  const all = await readStore();
  const req = all.find(r => r.id === id);
  if (!req) throw new TokenRequestError(`Token request not found: ${id}`, 404);
  if (req.status !== 'pending') {
    throw new TokenRequestError(`Token request ${id} is already ${req.status}`, 409);
  }
  req.status = 'denied';
  req.resolvedAt = new Date().toISOString();
  await writeStore(all);
  logger.info(TAG, `denied token request ${id}`);
  return publicView(req);
}

/**
 * Result of polling a token request. On the FIRST poll after approval it
 * carries the freshly-minted `token` (the `sb_..._...` secret) — thereafter
 * the secret is gone and `token` is null (the grant is still `approved`, just
 * already collected).
 */
export interface PollResult {
  id: string;
  status: TokenRequestStatus;
  /** The `sb_` token secret — present exactly once, on the first poll after
   *  approval. Null when pending, denied, or already collected. */
  token: string | null;
  grantedScopes?: ApiScope[];
  expiresAt?: string;
  /** True on the poll that returned the secret; false on later polls. */
  collected?: boolean;
}

/**
 * Poll a request for its outcome. On approval's first poll this returns the
 * clear-text token and wipes the stored secret (so it can't be replayed from
 * disk). A pending/denied request returns no token. An unknown id → not-found.
 *
 * NOTE: a token whose expiry has already lapsed by the time the caller polls
 * is reported without a token — the minted row is left for the sweeper to
 * delete; we don't hand out an already-dead credential.
 */
export async function pollTokenRequest(id: string): Promise<PollResult | { id: string; status: 'not-found'; token: null }> {
  const all = await readStore();
  const req = all.find(r => r.id === id);
  if (!req) return { id, status: 'not-found', token: null };

  if (req.status !== 'approved') {
    return { id, status: req.status, token: null };
  }

  // Approved. Hand over the secret exactly once, then wipe it.
  if (req.pendingSecret) {
    const secret = req.pendingSecret;
    delete req.pendingSecret;
    // If the grant already expired before it was ever collected, revoke the
    // dead token and don't hand out a useless credential.
    const expired = req.expiresAt ? Date.parse(req.expiresAt) < Date.now() : false;
    await writeStore(all);
    if (expired) {
      if (req.tokenId) await revokeToken(req.tokenId).catch(() => undefined);
      logger.warn(TAG, `token request ${id} approved but expired before collection — not returned`);
      return { id, status: 'approved', token: null, grantedScopes: req.grantedScopes, expiresAt: req.expiresAt, collected: false };
    }
    logger.info(TAG, `token request ${id} collected → token ${req.tokenId}`);
    return { id, status: 'approved', token: secret, grantedScopes: req.grantedScopes, expiresAt: req.expiresAt, collected: true };
  }

  // Already collected: report status + grant metadata, but no secret.
  return { id, status: 'approved', token: null, grantedScopes: req.grantedScopes, expiresAt: req.expiresAt, collected: false };
}
