/**
 * Vaultwarden push client (#2519) — writes ServiceBay's operational
 * credentials into a shared **organization collection** as a dedicated
 * technical account.
 *
 * Identity: ServiceBay logs in as its own account with a master password
 * it holds as a runtime secret (`config.credentialVault.password`,
 * encrypted at rest by the `SENSITIVE_KEYS` regex). It never asks for,
 * stores or derives the operator's master password — see
 * `assists/footgun-vaultwarden-personal-vault-write.md`. Everything the
 * technical account can decrypt is either an item ServiceBay wrote or an
 * item somebody deliberately shared into the same organization.
 *
 * Addressing (ADR 0007 Decision 3): the vault is reached over
 * `host.containers.internal:<hostPort>` — the podman-provided name for
 * the box — with the host loopback as the documented fallback for a
 * ServiceBay running in the host netns. Never a hardcoded IP, never
 * `LAN_IP`, never the public domain (that would loop out through NPM and
 * Authelia for a machine-to-machine call).
 *
 * Confirmation, not optimism: `upsert()` returning an id proves an HTTP
 * call succeeded. `verify()` re-reads the item from the server and
 * decrypts it with the organization key, so "secured" means the item is
 * actually in the vault and actually readable — the local copy is dropped
 * only after that (see `sync.ts`).
 */
import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import {
  decryptRsa,
  decryptSymmetric,
  decryptText,
  deriveMasterKey,
  deriveMasterPasswordHash,
  encryptSymmetric,
  stretchMasterKey,
  symmetricKeyFromRaw,
  VaultCryptoError,
  type KdfParams,
  type SymmetricKey,
} from './crypto';

/** Why a push could not be completed. Every one of these leaves the
 *  affected entries **unsecured** — there is no reason value that means
 *  "probably fine". */
export type VaultFailureReason =
  | 'not_configured'
  | 'unreachable'
  | 'auth_failed'
  | 'crypto_unsupported'
  | 'org_unavailable'
  | 'push_failed'
  | 'verify_failed';

export class VaultwardenError extends Error {
  reason: VaultFailureReason;
  constructor(reason: VaultFailureReason, message: string) {
    super(message);
    this.name = 'VaultwardenError';
    this.reason = reason;
  }
}

/** Everything needed to log in and write. Built by `config.ts` helpers. */
export interface VaultConnection {
  /** Candidate base URLs, tried in order (see module header). */
  baseUrls: string[];
  email: string;
  password: string;
  organizationId: string;
  collectionId: string;
}

/** A credential as it should exist in the vault. */
export interface VaultItem {
  /** Stable identity, written to the `servicebay-id` custom field. It is
   *  what makes a repeat push an UPDATE instead of a duplicate. */
  key: string;
  name: string;
  username: string;
  password: string;
  uri?: string;
  notes?: string;
}

/** Custom-field name carrying `VaultItem.key`. Not a secret — it is
 *  `<template>::<service>::<username>`. */
export const IDENTITY_FIELD = 'servicebay-id';

const REQUEST_TIMEOUT_MS = 15_000;
const CIPHER_TYPE_LOGIN = 1;
const FIELD_TYPE_TEXT = 0;

/** Read a JSON property regardless of the casing this Vaultwarden build
 *  uses — releases moved from PascalCase to camelCase mid-life and both
 *  are in the wild. */
function pick<T = unknown>(obj: unknown, ...names: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const n of names) {
    if (rec[n] !== undefined && rec[n] !== null) return rec[n] as T;
    const lower = n.charAt(0).toLowerCase() + n.slice(1);
    if (rec[lower] !== undefined && rec[lower] !== null) return rec[lower] as T;
    const upper = n.charAt(0).toUpperCase() + n.slice(1);
    if (rec[upper] !== undefined && rec[upper] !== null) return rec[upper] as T;
  }
  return undefined;
}

interface HttpOpts {
  method?: string;
  body?: unknown;
  form?: Record<string, string>;
  token?: string;
  headers?: Record<string, string>;
}

async function request(url: string, opts: HttpOpts = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new VaultwardenError('unreachable', e instanceof Error ? e.message : 'connection failed');
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 400 on the token endpoint is a rejected password, not an outage.
    const reason: VaultFailureReason = res.status === 400 || res.status === 401 ? 'auth_failed' : 'push_failed';
    throw new VaultwardenError(reason, `HTTP ${res.status} from ${new URL(url).pathname}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new VaultwardenError('push_failed', `non-JSON response from ${new URL(url).pathname}`);
  }
}

interface CipherIndexEntry {
  id: string;
  /** Decrypted `servicebay-id`, or null when the item is not ours. */
  key: string | null;
}

/**
 * An authenticated, unlocked session against one organization collection.
 *
 * Construct with `connectVault`; the constructor is private-by-convention
 * so nothing can hold a half-built session with no organization key.
 */
export class VaultwardenSession {
  private constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly orgKey: SymmetricKey,
    private readonly conn: VaultConnection,
    private readonly index: Map<string, CipherIndexEntry>,
  ) {}

  /** Number of ServiceBay-owned items already in the organization. */
  get knownItemCount(): number {
    return this.index.size;
  }

  static async open(conn: VaultConnection): Promise<VaultwardenSession> {
    if (!conn.email || !conn.password || !conn.organizationId || !conn.collectionId) {
      throw new VaultwardenError('not_configured', 'the Vaultwarden push account is not fully configured');
    }
    let lastError: VaultwardenError | null = null;
    for (const base of conn.baseUrls) {
      try {
        return await VaultwardenSession.openAt(base.replace(/\/+$/, ''), conn);
      } catch (e) {
        const err = e instanceof VaultwardenError
          ? e
          : new VaultwardenError('push_failed', e instanceof Error ? e.message : String(e));
        // Only a transport failure is worth trying the next address for;
        // a rejected password will be rejected there too.
        if (err.reason !== 'unreachable') throw err;
        lastError = err;
      }
    }
    throw lastError ?? new VaultwardenError('not_configured', 'no Vaultwarden address to try');
  }

  private static async openAt(baseUrl: string, conn: VaultConnection): Promise<VaultwardenSession> {
    const { token, masterKey, tokenRes } = await authenticate(baseUrl, conn);
    const sync = await request(`${baseUrl}/api/sync?excludeDomains=true`, { token });
    const profile = pick<Record<string, unknown>>(sync, 'profile') ?? (tokenRes as Record<string, unknown>);
    const orgKey = unwrapOrgKey(profile, tokenRes, masterKey, conn.organizationId);

    const index = buildIndex(pick<unknown[]>(sync, 'ciphers') ?? [], conn.organizationId, orgKey);
    return new VaultwardenSession(baseUrl, token, orgKey, conn, index);
  }

  private encrypt(value: string): string {
    return encryptSymmetric(value, this.orgKey);
  }

  private buildCipher(item: VaultItem): Record<string, unknown> {
    return {
      type: CIPHER_TYPE_LOGIN,
      organizationId: this.conn.organizationId,
      name: this.encrypt(item.name),
      notes: item.notes ? this.encrypt(item.notes) : null,
      favorite: false,
      reprompt: 0,
      fields: [
        { type: FIELD_TYPE_TEXT, name: this.encrypt(IDENTITY_FIELD), value: this.encrypt(item.key) },
      ],
      login: {
        username: this.encrypt(item.username),
        password: this.encrypt(item.password),
        totp: null,
        uris: item.uri ? [{ uri: this.encrypt(item.uri), match: null }] : [],
      },
    };
  }

  /**
   * Create the item, or update the one already carrying this `key`.
   *
   * The update branch is what keeps a re-install or a rotation from
   * growing a second copy: identity is the `servicebay-id` field, read
   * back out of the organization at connect time, so it survives
   * ServiceBay forgetting everything about the entry locally.
   */
  async upsert(item: VaultItem): Promise<{ id: string; created: boolean }> {
    const existing = [...this.index.values()].find(e => e.key === item.key);
    const cipher = this.buildCipher(item);
    if (existing) {
      await request(`${this.baseUrl}/api/ciphers/${encodeURIComponent(existing.id)}`, {
        method: 'PUT',
        body: cipher,
        token: this.token,
      });
      return { id: existing.id, created: false };
    }
    const created = await request(`${this.baseUrl}/api/ciphers/create`, {
      method: 'POST',
      body: { cipher, collectionIds: [this.conn.collectionId] },
      token: this.token,
    });
    const id = pick<string>(created, 'id');
    if (!id) throw new VaultwardenError('push_failed', 'Vaultwarden accepted the item but returned no id');
    this.index.set(id, { id, key: item.key });
    return { id, created: true };
  }

  /** Does the fetched cipher decrypt to exactly the item we pushed? */
  private matches(fetched: unknown, item: VaultItem): boolean {
    if (String(pick<string>(fetched, 'organizationId') ?? '') !== this.conn.organizationId) return false;
    const collectionIds = pick<string[]>(fetched, 'collectionIds');
    const misfiled = Array.isArray(collectionIds)
      && collectionIds.length > 0
      && !collectionIds.includes(this.conn.collectionId);
    if (misfiled) return false;

    const login = pick<Record<string, unknown>>(fetched, 'login') ?? {};
    const read = (v: unknown) => decryptText(String(v ?? ''), this.orgKey);
    return read(pick<string>(fetched, 'name')) === item.name
      && read(pick<string>(login, 'username')) === item.username
      && read(pick<string>(login, 'password')) === item.password;
  }

  /**
   * Re-read the item from the server and decrypt it.
   *
   * This is the criterion the whole feature turns on: a 2xx from
   * `upsert` says the request was accepted, not that a readable item
   * exists. Nothing is marked secured until this returns true, and a
   * false here is a **failure**, not a warning.
   */
  async verify(id: string, item: VaultItem): Promise<boolean> {
    let fetched: unknown;
    try {
      fetched = await request(`${this.baseUrl}/api/ciphers/${encodeURIComponent(id)}/details`, {
        token: this.token,
      });
    } catch (e) {
      logger.warn('Vaultwarden', `read-back of item ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    try {
      return this.matches(fetched, item);
    } catch (e) {
      logger.warn('Vaultwarden', `read-back of item ${id} did not decrypt: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}

/** Log in: prelogin for the KDF, then the password grant. */
async function authenticate(baseUrl: string, conn: VaultConnection): Promise<{
  token: string;
  masterKey: Buffer;
  tokenRes: unknown;
}> {
  const pre = await request(`${baseUrl}/identity/accounts/prelogin`, { body: { email: conn.email } });
  const kdf: KdfParams = {
    type: Number(pick<number>(pre, 'kdf') ?? 0),
    iterations: Number(pick<number>(pre, 'kdfIterations') ?? 0),
  };

  let masterKey: Buffer;
  let passwordHash: string;
  try {
    masterKey = deriveMasterKey(conn.password, conn.email, kdf);
    passwordHash = deriveMasterPasswordHash(masterKey, conn.password);
  } catch (e) {
    throw new VaultwardenError('crypto_unsupported', e instanceof Error ? e.message : String(e));
  }

  const tokenRes = await request(`${baseUrl}/identity/connect/token`, {
    form: {
      grant_type: 'password',
      username: conn.email,
      password: passwordHash,
      scope: 'api offline_access',
      client_id: 'cli',
      deviceType: '8',
      deviceIdentifier: deviceIdentifier(conn.email),
      deviceName: 'servicebay',
    },
    headers: { 'Auth-Email': Buffer.from(conn.email, 'utf8').toString('base64url') },
  });
  const token = pick<string>(tokenRes, 'access_token');
  if (!token) throw new VaultwardenError('auth_failed', 'Vaultwarden returned no access token');
  return { token, masterKey, tokenRes };
}

/**
 * Walk the rest of the ladder: stretched key → user key → RSA private key
 * → organization key. Any step failing means we cannot produce items the
 * humans could read, so it is an error, never a fallback.
 */
function unwrapOrgKey(
  profile: Record<string, unknown>,
  tokenRes: unknown,
  masterKey: Buffer,
  organizationId: string,
): SymmetricKey {
  try {
    const stretched = stretchMasterKey(masterKey);
    const protectedUserKey = pick<string>(profile, 'key') ?? pick<string>(tokenRes, 'key');
    if (!protectedUserKey) throw new VaultCryptoError('the vault returned no account key');
    const userKey = symmetricKeyFromRaw(decryptSymmetric(protectedUserKey, stretched));

    const protectedPrivateKey = pick<string>(profile, 'privateKey') ?? pick<string>(tokenRes, 'privateKey');
    if (!protectedPrivateKey) throw new VaultCryptoError('the vault returned no account private key');
    const privateKeyDer = decryptSymmetric(protectedPrivateKey, userKey);

    const orgs = pick<unknown[]>(profile, 'organizations') ?? [];
    const org = orgs.find(o => String(pick<string>(o, 'id') ?? '') === organizationId);
    if (!org) {
      throw new VaultwardenError(
        'org_unavailable',
        `the ServiceBay vault account is not a member of organization ${organizationId}`,
      );
    }
    const wrappedOrgKey = pick<string>(org, 'key');
    if (!wrappedOrgKey) throw new VaultwardenError('org_unavailable', 'the organization returned no key');
    return symmetricKeyFromRaw(decryptRsa(wrappedOrgKey, privateKeyDer));
  } catch (e) {
    if (e instanceof VaultwardenError) throw e;
    throw new VaultwardenError('crypto_unsupported', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Index the organization's existing ciphers by their `servicebay-id`
 * field so `upsert` can update instead of duplicating. Items we cannot
 * decrypt (someone else's, or a shape we don't understand) are skipped,
 * never overwritten.
 */
function buildIndex(ciphers: unknown[], organizationId: string, orgKey: SymmetricKey): Map<string, CipherIndexEntry> {
  const index = new Map<string, CipherIndexEntry>();
  for (const c of ciphers) {
    const id = pick<string>(c, 'id');
    if (!id) continue;
    if (String(pick<string>(c, 'organizationId') ?? '') !== organizationId) continue;
    const fields = pick<unknown[]>(c, 'fields') ?? [];
    let key: string | null = null;
    for (const f of fields) {
      try {
        const name = decryptText(String(pick<string>(f, 'name') ?? ''), orgKey);
        if (name !== IDENTITY_FIELD) continue;
        key = decryptText(String(pick<string>(f, 'value') ?? ''), orgKey);
        break;
      } catch {
        // Not ours / not decryptable with the org key — leave it alone.
      }
    }
    if (key) index.set(id, { id, key });
  }
  return index;
}

/**
 * Stable per-account device id. Vaultwarden records one device row per
 * identifier; deriving it from the account e-mail keeps a box from
 * growing a new device on every push, without persisting extra state.
 */
function deviceIdentifier(email: string): string {
  const h = createHash('sha256').update(`servicebay:${email}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Open a session. Exported as a function so callers never see the class ctor. */
export function connectVault(conn: VaultConnection): Promise<VaultwardenSession> {
  return VaultwardenSession.open(conn);
}
