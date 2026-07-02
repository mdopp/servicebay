/**
 * Scoped API tokens — the single store for ServiceBay's named, revocable
 * Bearer credentials. Originally MCP-only (`mcp/tokens.ts`); relocated here
 * under `auth/` in #1264 once `requireSession` started accepting the same
 * tokens on REST too, so both surfaces share one place. The MCP server and
 * the REST gate both import from here.
 *
 * Replaces the all-or-nothing session-cookie auth path with named, revocable
 * tokens that carry an explicit scope set.
 *
 * Scopes (cumulative — a token can have any subset; the gate is per-tool):
 *   - read       list_*, get_*, diagnose, list_trashed_services
 *   - lifecycle  start/stop/restart, run_check_now, refresh_agent
 *   - mutate     deploy_service, update_service_yaml, add_proxy_route,
 *                create_health_check, run_backup, restore_trashed_service,
 *                rename_service
 *   - destroy    delete_service, delete_health_check, remove_proxy_route,
 *                restore_backup, purge_trashed_service, update_config,
 *                exec_command
 *
 * Token format on the wire: `sb_<id>_<secret>` (Bearer header). The id is
 * a public 8-char hex; the secret is 32 random base32-alphabet characters.
 * We persist only sha-256(secret) plus the id so a stolen tokens.json
 * file doesn't leak active credentials.
 *
 * Cookie auth (the original surface) still works and is treated as
 * "all scopes" so we don't break clients that worked before this PR.
 */
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '@/lib/dirs';
import { atomicWriteFile } from '@/lib/util/atomicWrite';
import { logger } from '@/lib/logger';

// Scope grain lives in `./apiScope.ts` (#601 cycle-break) — re-exported
// here so existing consumers don't need to change imports.
//
// Scope grain — each tool is mapped to exactly one (`TOOL_SCOPES` in
// server.ts). `exec` was split out of `destroy` (#591): the original
// model gave `exec_command` and `update_config` the same blast-radius
// label, but `update_config` is allow-listed to safe keys and never
// reaches the shell. Tokens issued today as `destroy` continue to work
// for everything they previously could — we additively add `exec`
// without removing `destroy`'s grants.
export { type ApiScope, ALL_SCOPES } from './apiScope';
import { ALL_SCOPES, type ApiScope, scopesAreSubset } from './apiScope';

export interface ApiToken {
  id: string;            // 8-hex public id
  name: string;          // operator-supplied label
  scopes: ApiScope[];
  hash: string;          // sha256(secret), hex
  prefix: string;        // first 4 chars of secret, for UI display only
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  createdBy: string;     // session.user at creation time
  // Lineage (#2048): set when a token holder delegates a child token. The id
  // of the parent token this one was minted from. Absent on directly-minted
  // (session/admin) tokens — existing tokens have no parentId, which is fine;
  // this is purely additive and never settable by an external caller.
  parentId?: string;
}

/** Raised by createDelegatedToken when the parent credential or the requested
 *  narrowing is invalid. The route maps `status` to the HTTP response. */
export class DelegateError extends Error {
  constructor(message: string, readonly status: 400 | 403) {
    super(message);
    this.name = 'DelegateError';
  }
}

const TOKENS_FILE = path.join(DATA_DIR, 'api-tokens.json');
// Pre-#1264 location, back when the store was MCP-only. loadFile adopts it
// once if the new file is absent so tokens minted before the relocation
// keep authenticating.
const LEGACY_TOKENS_FILE = path.join(DATA_DIR, 'mcp-tokens.json');
const SECRET_LEN = 32;
const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // base32-ish, no I/0/O/1

interface TokensFile { tokens: ApiToken[] }

async function loadFile(): Promise<TokensFile> {
  try {
    const raw = await fsp.readFile(TOKENS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tokens)) return parsed;
  } catch { /* fall through to legacy / empty */ }
  // One-time migration from the pre-relocation mcp-tokens.json (#1264).
  // Best-effort: adopt the legacy file, persist it under the new name at
  // 0600, then remove the old one so this runs at most once.
  try {
    const legacyRaw = await fsp.readFile(LEGACY_TOKENS_FILE, 'utf-8');
    const legacy = JSON.parse(legacyRaw);
    if (legacy && Array.isArray(legacy.tokens)) {
      await saveFile(legacy);
      await fsp.unlink(LEGACY_TOKENS_FILE).catch(() => { /* best-effort */ });
      logger.info('auth:apiTokens', `Migrated ${legacy.tokens.length} token(s) from legacy mcp-tokens.json to api-tokens.json`);
      return legacy;
    }
  } catch { /* no legacy file — fall through to empty */ }
  return { tokens: [] };
}

async function saveFile(data: TokensFile): Promise<void> {
  await atomicWriteFile(TOKENS_FILE, JSON.stringify(data, null, 2));
  // chmod restrict: tokens file holds password hashes — same protection
  // class as auth.passwordHash in config.json.
  try { await fsp.chmod(TOKENS_FILE, 0o600); } catch { /* best-effort */ }
}

// Tracks verifyToken's most recent fire-and-forget lastUsedAt write. Auth never
// awaits it inline (the stamp must not block auth), but the mutating ops
// (createToken/revokeToken) await it before their own read-modify-write so a
// stale stamp snapshot can't clobber a concurrent mint/revoke. Tests drain it
// via flushPendingStamps() so a leaked write doesn't land mid-teardown.
let pendingStamp: Promise<unknown> = Promise.resolve();

/** Await the most recent lastUsedAt stamp write. Test/teardown helper only. */
export async function flushPendingStamps(): Promise<void> {
  await pendingStamp;
}

function genId(): string {
  return crypto.randomBytes(4).toString('hex');
}
function genSecret(): string {
  // 32 chars from base32-ish alphabet → ~160 bits of entropy.
  const bytes = crypto.randomBytes(SECRET_LEN);
  let out = '';
  for (let i = 0; i < SECRET_LEN; i++) {
    out += SECRET_ALPHABET[bytes[i] % SECRET_ALPHABET.length];
  }
  return out;
}
function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Strip the hash field for any caller-facing list. The hash never leaves
 *  the server. */
function publicView(t: ApiToken): Omit<ApiToken, 'hash'> {
  // Underscore-prefixed `_hash` matches the unused-vars rule's allow
  // pattern, so the destructuring stays explicit about which field is
  // being stripped without needing a per-line disable.
  const { hash: _hash, ...rest } = t;
  void _hash;
  return rest;
}

export async function listTokens(): Promise<Array<Omit<ApiToken, 'hash'>>> {
  const data = await loadFile();
  return data.tokens.map(publicView);
}

export async function createToken(input: {
  name: string;
  scopes: ApiScope[];
  expiresAt?: string;
  createdBy: string;
  // Lineage marker (#2048). Set only by the delegated-mint path — the public
  // mint route never passes it, so an external caller can't forge a parent.
  parentId?: string;
}): Promise<{ token: Omit<ApiToken, 'hash'>; secret: string }> {
  if (!input.name?.trim()) throw new Error('Token name is required');
  if (!input.scopes?.length) throw new Error('At least one scope is required');
  for (const s of input.scopes) {
    if (!ALL_SCOPES.includes(s)) throw new Error(`Unknown scope: ${s}`);
  }
  await pendingStamp; // settle any in-flight lastUsedAt write so it can't clobber this append
  const data = await loadFile();
  const id = genId();
  const secret = genSecret();
  const token: ApiToken = {
    id,
    name: input.name.trim().slice(0, 100),
    scopes: [...new Set(input.scopes)],
    hash: sha256(secret),
    prefix: secret.slice(0, 4),
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    ...(input.parentId ? { parentId: input.parentId } : {}),
  };
  data.tokens.push(token);
  await saveFile(data);
  logger.info('auth:apiTokens', `Created API token ${id} ("${token.name}") scopes=[${token.scopes.join(',')}]${token.parentId ? ` parent=${token.parentId}` : ''} by ${input.createdBy}`);

  // The "first user-minted token revokes the bootstrap" rule (#322) used
  // to live here as a dynamic `await import('../mcp/bootstrapToken')` —
  // that formed a tokens ↔ bootstrapToken cycle that depcruise flagged.
  // Moved to the calling route (app/api/system/api-tokens/route.ts) so
  // this module no longer reaches into bootstrapToken (#601).

  // The clear-text token is `sb_<id>_<secret>` — returned exactly once.
  return { token: publicView(token), secret: `sb_${id}_${secret}` };
}

/**
 * Delegated child-mint (#2048) — the foundation of the token chain-of-trust
 * (epic #2047). A *holder* of a raw parent token ("sb_<id>_<secret>") mints a
 * child whose authority is strictly bounded by the parent:
 *   - scopes ⊆ parent.scopes (implied scopes count — a `destroy` parent may
 *     mint a `reboot`/`exec` child; see scopesAreSubset)
 *   - expiresAt ≤ parent.expiresAt (TTL can only narrow, never extend; if the
 *     parent never expires the child may set any expiry)
 * The parent must be present, unexpired, and verify against its stored hash.
 * The child records `parentId` = the parent's id.
 *
 * NOTE: this does NOT implement cascading revocation in verifyToken — that's
 * #2049, which builds on the parentId chain landed here.
 */
export async function createDelegatedToken(input: {
  parentRaw: string;
  name: string;
  scopes: ApiScope[];
  expiresAt?: string;
}): Promise<{ token: Omit<ApiToken, 'hash'>; secret: string }> {
  if (!input.scopes?.length) throw new DelegateError('At least one scope is required', 400);
  for (const s of input.scopes) {
    if (!ALL_SCOPES.includes(s)) throw new DelegateError(`Unknown scope: ${s}`, 400);
  }

  // Resolve + authenticate the parent credential. verifyToken returns null for
  // a malformed/unknown/expired token or a bad secret — all of which mean the
  // caller doesn't hold a valid parent, so the delegation is forbidden.
  const parent = await verifyToken(input.parentRaw);
  if (!parent) throw new DelegateError('Invalid, expired, or revoked parent token', 403);
  // Note: verifyToken stamped the parent's lastUsedAt via a detached write; the
  // createToken below awaits that pending stamp before it appends, so the
  // (childless) stamp snapshot can't land after the append and drop the child.

  // Scope narrowing: every requested scope must be held (directly or implied)
  // by the parent. A child can never widen beyond its parent's authority.
  if (!scopesAreSubset(input.scopes, parent.scopes)) {
    throw new DelegateError('Requested scopes exceed the parent token’s scopes', 403);
  }

  // TTL narrowing: a child may expire no later than its parent. An
  // unbounded-lifetime parent imposes no upper bound on the child.
  if (parent.expiresAt) {
    const parentExp = Date.parse(parent.expiresAt);
    if (!input.expiresAt) {
      throw new DelegateError('Child token must expire no later than its parent (parent has an expiry)', 403);
    }
    const childExp = Date.parse(input.expiresAt);
    if (!Number.isFinite(childExp) || childExp > parentExp) {
      throw new DelegateError('Child token expiry exceeds the parent token’s expiry', 403);
    }
  }

  return createToken({
    name: input.name,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    createdBy: `token:${parent.id}`,
    parentId: parent.id,
  });
}

/**
 * Sweep expired tokens out of `api-tokens.json` (#2139). `verifyToken`
 * already *rejects* an expired token, but a rejected-yet-present row is a
 * dead credential lingering in the store — noisy in the UI and a latent
 * data-at-rest liability. This deletes every row whose `expiresAt` is in the
 * past, so a self-expiring token (e.g. a short-TTL grant from the MCP
 * request_token flow) leaves no trace once it lapses.
 *
 * Fire-and-forget-safe: it settles any in-flight lastUsedAt stamp first (so a
 * stale snapshot can't resurrect a swept row), no-ops when nothing is expired
 * (no write), and returns the ids it removed for the audit log. Called on a
 * timer by the server bootstrap AND opportunistically off the verify path, so
 * expiry cleanup happens without a dedicated cron.
 */
export async function sweepExpiredTokens(now: number = Date.now()): Promise<string[]> {
  await pendingStamp; // settle any in-flight stamp so it can't re-add a swept row
  const data = await loadFile();
  const expired = data.tokens.filter(t => t.expiresAt && Date.parse(t.expiresAt) < now);
  if (expired.length === 0) return []; // nothing to do → no write
  const expiredIds = new Set(expired.map(t => t.id));
  data.tokens = data.tokens.filter(t => !expiredIds.has(t.id));
  await saveFile(data);
  const ids = [...expiredIds];
  logger.info('auth:apiTokens', `Swept ${ids.length} expired API token(s): [${ids.join(',')}]`);
  return ids;
}

export async function revokeToken(id: string): Promise<boolean> {
  await pendingStamp; // settle any in-flight lastUsedAt write so it can't resurrect this revoked token
  const data = await loadFile();
  const before = data.tokens.length;
  data.tokens = data.tokens.filter(t => t.id !== id);
  if (data.tokens.length === before) return false;
  await saveFile(data);
  logger.info('auth:apiTokens', `Revoked API token ${id}`);
  return true;
}

/**
 * Is the token with this id still live — present, unexpired, and with a live
 * ancestor chain? Unlike verifyToken this takes only the id (no secret), so the
 * token→session bridge's `requireSession` re-check can confirm a bridged
 * session's source token hasn't been revoked/expired without holding the
 * secret. Revoking the token (or any ancestor) → false → the bridged session
 * dies on its next request (#2047 cascading revocation, extended to sessions).
 */
export async function tokenIsLive(id: string): Promise<boolean> {
  if (!id) return false;
  const data = await loadFile();
  const token = data.tokens.find(t => t.id === id);
  if (!token) return false;                                                   // revoked/absent
  if (token.expiresAt && Date.parse(token.expiresAt) < Date.now()) return false; // expired
  return ancestorChainIsLive(token, data.tokens);
}

// Max ancestor hops walked by verifyToken before treating the chain as
// invalid (#2049). A real token store is root→leaf, depth ~2; the cap exists
// only to bound a corrupt/cyclic parentId chain. An over-deep or cyclic chain
// is treated as invalid (fail closed) rather than authenticating.
const MAX_ANCESTOR_DEPTH = 16;

/**
 * Lazy cascading revocation (#2049). Given a verified leaf `token`, walk UP the
 * `parentId` chain over the already-loaded in-memory `tokens` array. The chain
 * is valid only if every ancestor is present, not expired, and not revoked
 * (revocation = absence from the store, since revokeToken filters it out).
 *
 * Returns true when the whole chain up to the root is live; false when any
 * ancestor is missing/expired, or the walk is over-deep or cyclic. This makes
 * "revoke a parent → every descendant instantly invalid" free at mint time —
 * no eager tree-walk, just an O(depth) lookup per verify.
 *
 * A root token (no parentId) trivially passes.
 */
function ancestorChainIsLive(token: ApiToken, tokens: ApiToken[]): boolean {
  const now = Date.now();
  const seen = new Set<string>([token.id]);
  let parentId = token.parentId;
  let depth = 0;
  while (parentId) {
    if (++depth > MAX_ANCESTOR_DEPTH) return false; // over-deep → fail closed
    if (seen.has(parentId)) return false;           // cycle → fail closed
    seen.add(parentId);
    const parent = tokens.find(t => t.id === parentId);
    if (!parent) return false;                       // missing/revoked ancestor
    if (parent.expiresAt && Date.parse(parent.expiresAt) < now) return false; // expired ancestor
    parentId = parent.parentId;
  }
  return true;
}

/**
 * Verify a Bearer-style raw token string ("sb_<id>_<secret>"). Returns the
 * token (without hash) on success, or null. Side effect: stamps lastUsedAt
 * on success — the operator wants to see "this token was used 5 minutes
 * ago" in the UI.
 *
 * Constant-time comparison via crypto.timingSafeEqual to avoid timing
 * oracles on the hash check (both sides are sha-256 of equal length).
 *
 * After the token's own hash/expiry check passes, the `parentId` chain is
 * walked (#2049): a token is rejected if any ancestor is revoked, expired, or
 * missing — lazy cascading revocation, so revoking a parent kills every
 * descendant on their next verify.
 */
export async function verifyToken(raw: string): Promise<Omit<ApiToken, 'hash'> | null> {
  const m = raw.match(/^sb_([0-9a-f]{8})_([A-Z2-9]+)$/);
  if (!m) return null;
  const [, id, secret] = m;
  const data = await loadFile();
  const token = data.tokens.find(t => t.id === id);
  if (!token) return null;
  if (token.expiresAt && Date.parse(token.expiresAt) < Date.now()) return null;

  const incomingHash = Buffer.from(sha256(secret), 'hex');
  const storedHash = Buffer.from(token.hash, 'hex');
  if (incomingHash.length !== storedHash.length) return null;
  if (!crypto.timingSafeEqual(incomingHash, storedHash)) return null;

  // Cascading revocation: a live secret is not enough — every ancestor must
  // still be live, else this token is effectively revoked.
  if (!ancestorChainIsLive(token, data.tokens)) return null;

  // Stamp lastUsedAt — best-effort, doesn't block auth. Re-read the file and
  // patch only this token's lastUsedAt rather than writing back our (possibly
  // stale) `data` snapshot: a fire-and-forget overwrite from a snapshot taken
  // before a concurrent revoke / expiry change / sibling stamp would clobber
  // that change (e.g. resurrect a just-revoked ancestor). Re-reading keeps the
  // stamp from undoing another writer's work.
  const stampedAt = new Date().toISOString();
  pendingStamp = (async () => {
    const fresh = await loadFile();
    const now = Date.now();
    // Opportunistic expiry sweep (#2139): drop any dead rows in the same
    // read-modify-write that stamps this token, so expired grants don't
    // linger between the periodic sweeps. Never touches this token (it just
    // verified, so it isn't expired).
    const before = fresh.tokens.length;
    fresh.tokens = fresh.tokens.filter(t => !(t.expiresAt && Date.parse(t.expiresAt) < now));
    const t = fresh.tokens.find(tok => tok.id === id);
    if (!t) return; // token revoked/removed in the meantime — nothing to stamp
    t.lastUsedAt = stampedAt;
    await saveFile(fresh);
    if (fresh.tokens.length < before) {
      logger.info('auth:apiTokens', `Swept ${before - fresh.tokens.length} expired API token(s) during verify of ${id}`);
    }
  })().catch(e => logger.warn('auth:apiTokens', `Could not update lastUsedAt for ${id}: ${e instanceof Error ? e.message : String(e)}`));

  return publicView({ ...token, lastUsedAt: stampedAt });
}
