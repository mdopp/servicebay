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
import { ALL_SCOPES, type ApiScope } from './apiScope';

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
}): Promise<{ token: Omit<ApiToken, 'hash'>; secret: string }> {
  if (!input.name?.trim()) throw new Error('Token name is required');
  if (!input.scopes?.length) throw new Error('At least one scope is required');
  for (const s of input.scopes) {
    if (!ALL_SCOPES.includes(s)) throw new Error(`Unknown scope: ${s}`);
  }
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
  };
  data.tokens.push(token);
  await saveFile(data);
  logger.info('auth:apiTokens', `Created API token ${id} ("${token.name}") scopes=[${token.scopes.join(',')}] by ${input.createdBy}`);

  // The "first user-minted token revokes the bootstrap" rule (#322) used
  // to live here as a dynamic `await import('../mcp/bootstrapToken')` —
  // that formed a tokens ↔ bootstrapToken cycle that depcruise flagged.
  // Moved to the calling route (app/api/system/api-tokens/route.ts) so
  // this module no longer reaches into bootstrapToken (#601).

  // The clear-text token is `sb_<id>_<secret>` — returned exactly once.
  return { token: publicView(token), secret: `sb_${id}_${secret}` };
}

export async function revokeToken(id: string): Promise<boolean> {
  const data = await loadFile();
  const before = data.tokens.length;
  data.tokens = data.tokens.filter(t => t.id !== id);
  if (data.tokens.length === before) return false;
  await saveFile(data);
  logger.info('auth:apiTokens', `Revoked API token ${id}`);
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

  // Stamp lastUsedAt — best-effort, doesn't block auth.
  token.lastUsedAt = new Date().toISOString();
  saveFile(data).catch(e => logger.warn('auth:apiTokens', `Could not update lastUsedAt for ${id}: ${e instanceof Error ? e.message : String(e)}`));

  return publicView(token);
}
