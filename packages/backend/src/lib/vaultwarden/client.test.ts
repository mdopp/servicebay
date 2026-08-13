/**
 * Push-client tests against a **fake Vaultwarden that only ever sees
 * opaque strings** (#2519).
 *
 * The fake reimplements the server's half honestly: it holds the
 * organization key wrapped to the account's RSA public key, stores
 * ciphers verbatim, and never decrypts anything. So the assertions below
 * are end-to-end statements about the protocol, not about our own mock —
 * in particular "the stored item decrypts with the organization key" is
 * what proves we did not push plaintext (the failure mode named in
 * `assists/footgun-vaultwarden-personal-vault-write.md`, where a vault
 * happily stores unreadable rows).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, publicEncrypt, constants, randomBytes, randomUUID } from 'node:crypto';
import {
  decryptText,
  deriveMasterKey,
  deriveMasterPasswordHash,
  encryptSymmetric,
  stretchMasterKey,
  symmetricKeyFromRaw,
  type SymmetricKey,
} from './crypto';
import { connectVault, IDENTITY_FIELD, VaultwardenError, type VaultItem } from './client';

const EMAIL = 'servicebay@dopp.cloud';
const PASSWORD = 'nJ6yQ2-generated-by-servicebay';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const COLLECTION_ID = '22222222-2222-2222-2222-222222222222';
const KDF_ITERATIONS = 100_000;

interface StoredCipher {
  id: string;
  organizationId: string;
  collectionIds: string[];
  name: string;
  login: { username: string; password: string };
  fields: Array<{ type: number; name: string; value: string }>;
}

/** The server half: holds wrapped keys, stores opaque ciphertext. */
class FakeVault {
  readonly orgKey: SymmetricKey;
  readonly ciphers = new Map<string, StoredCipher>();
  readonly calls: string[] = [];
  /** Set to corrupt what a read-back returns (a vault that "accepted" but
   *  did not really store the item). */
  corruptReadBack: ((c: StoredCipher) => StoredCipher) | null = null;
  private readonly protectedUserKey: string;
  private readonly protectedPrivateKey: string;
  private readonly wrappedOrgKey: string;
  private readonly expectedHash: string;

  constructor(opts: { kdfType?: number; password?: string } = {}) {
    const password = opts.password ?? PASSWORD;
    const masterKey = deriveMasterKey(password, EMAIL, { type: 0, iterations: KDF_ITERATIONS });
    this.expectedHash = deriveMasterPasswordHash(masterKey, password);

    const userKeyRaw = randomBytes(64);
    this.protectedUserKey = encryptSymmetric(userKeyRaw, stretchMasterKey(masterKey));
    const userKey = symmetricKeyFromRaw(userKeyRaw);

    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    this.protectedPrivateKey = encryptSymmetric(der, userKey);

    const orgKeyRaw = randomBytes(64);
    this.orgKey = symmetricKeyFromRaw(orgKeyRaw);
    this.wrappedOrgKey = `4.${publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      orgKeyRaw,
    ).toString('base64')}`;
  }

  /** Membership of a *different* org — used to prove the client refuses. */
  otherOrgId = '99999999-9999-9999-9999-999999999999';
  memberOfOrgId = ORG_ID;

  handle(url: string, init: RequestInit | undefined): Response {
    const path = new URL(url).pathname;
    this.calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/identity/accounts/prelogin') {
      return json({ Kdf: 0, KdfIterations: KDF_ITERATIONS });
    }
    if (path === '/identity/connect/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('password') !== this.expectedHash) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (path === '/api/sync') {
      return json({
        Profile: {
          Key: this.protectedUserKey,
          PrivateKey: this.protectedPrivateKey,
          Organizations: [{ Id: this.memberOfOrgId, Key: this.wrappedOrgKey, Name: 'ServiceBay' }],
        },
        Ciphers: [...this.ciphers.values()],
      });
    }
    if (path === '/api/ciphers/create') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const id = randomUUID();
      this.ciphers.set(id, { ...body.cipher, id, collectionIds: body.collectionIds });
      return json({ id });
    }
    const detail = /^\/api\/ciphers\/([^/]+)\/details$/.exec(path);
    if (detail) {
      const stored = this.ciphers.get(decodeURIComponent(detail[1]));
      if (!stored) return json({ error: 'not found' }, 404);
      return json(this.corruptReadBack ? this.corruptReadBack(stored) : stored);
    }
    const put = /^\/api\/ciphers\/([^/]+)$/.exec(path);
    if (put && init?.method === 'PUT') {
      const id = decodeURIComponent(put[1]);
      const prev = this.ciphers.get(id);
      if (!prev) return json({ error: 'not found' }, 404);
      this.ciphers.set(id, { ...JSON.parse(String(init.body)), id, collectionIds: prev.collectionIds });
      return json({ id });
    }
    return json({ error: `unhandled ${path}` }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

const BASE = 'http://host.containers.internal:8222';
const FALLBACK = 'http://127.0.0.1:8222';

function conn(baseUrls = [BASE]) {
  return { baseUrls, email: EMAIL, password: PASSWORD, organizationId: ORG_ID, collectionId: COLLECTION_ID };
}

const ITEM: VaultItem = {
  key: 'immich::Immich::admin@dopp.cloud',
  name: 'Immich',
  username: 'admin@dopp.cloud',
  password: 'sup3r-s3cret-value',
  uri: 'https://photos.dopp.cloud',
  notes: 'Written by ServiceBay (template: immich).',
};

let vault: FakeVault;

function installFetch(routes: Record<string, FakeVault | 'refused'>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const origin = new URL(url).origin;
    const target = routes[origin];
    if (!target) throw new Error(`unexpected origin ${origin}`);
    if (target === 'refused') throw new Error('connect ECONNREFUSED');
    return target.handle(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vault = new FakeVault();
});

describe('vaultwarden push client', () => {
  it('writes an item the organization key can decrypt — never plaintext', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id, created } = await session.upsert(ITEM);

    expect(created).toBe(true);
    const stored = vault.ciphers.get(id)!;
    // The server never sees any of this in the clear.
    expect(JSON.stringify(stored)).not.toContain('sup3r-s3cret-value');
    expect(JSON.stringify(stored)).not.toContain('Immich');
    // …but the organization key opens it, which is what makes the item
    // readable for the humans in that collection.
    expect(decryptText(stored.name, vault.orgKey)).toBe('Immich');
    expect(decryptText(stored.login.password, vault.orgKey)).toBe('sup3r-s3cret-value');
    expect(decryptText(stored.login.username, vault.orgKey)).toBe('admin@dopp.cloud');
    expect(stored.organizationId).toBe(ORG_ID);
    expect(stored.collectionIds).toEqual([COLLECTION_ID]);
  });

  it('carries the identity field a repeat push matches on', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    const field = vault.ciphers.get(id)!.fields[0];
    expect(decryptText(field.name, vault.orgKey)).toBe(IDENTITY_FIELD);
    expect(decryptText(field.value, vault.orgKey)).toBe(ITEM.key);
  });

  it('UPDATES on a rotation instead of creating a duplicate', async () => {
    installFetch({ [BASE]: vault });
    const first = await connectVault(conn());
    const { id } = await first.upsert(ITEM);

    // A fresh session — ServiceBay has forgotten everything local; the
    // item is re-identified from the organization itself.
    const second = await connectVault(conn());
    expect(second.knownItemCount).toBe(1);
    const rotated = { ...ITEM, password: 'rotated-value' };
    const result = await second.upsert(rotated);

    expect(result.created).toBe(false);
    expect(result.id).toBe(id);
    expect(vault.ciphers.size).toBe(1);
    expect(decryptText(vault.ciphers.get(id)!.login.password, vault.orgKey)).toBe('rotated-value');
    expect(await second.verify(id, rotated)).toBe(true);
  });

  it('verifies by reading the item back and decrypting it', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    expect(await session.verify(id, ITEM)).toBe(true);
    expect(vault.calls).toContain(`GET /api/ciphers/${id}/details`);
  });

  it('does NOT confirm when the vault stored something else', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    // The push returned 2xx; the item in the vault holds a different
    // password. An optimistic implementation would drop the local copy
    // here — this is the criterion the feature turns on.
    vault.corruptReadBack = c => ({ ...c, login: { ...c.login, password: encryptSymmetric('something-else', vault.orgKey) } });
    expect(await session.verify(id, ITEM)).toBe(false);
  });

  it('does NOT confirm when the item is gone', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    vault.ciphers.delete(id);
    expect(await session.verify(id, ITEM)).toBe(false);
  });

  it('does NOT confirm when the item landed outside the target collection', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    vault.corruptReadBack = c => ({ ...c, collectionIds: ['33333333-3333-3333-3333-333333333333'] });
    expect(await session.verify(id, ITEM)).toBe(false);
  });

  it('does NOT confirm when the read-back cannot be decrypted', async () => {
    installFetch({ [BASE]: vault });
    const session = await connectVault(conn());
    const { id } = await session.upsert(ITEM);
    vault.corruptReadBack = c => ({ ...c, name: '2.notbase64|garbage|garbage' });
    expect(await session.verify(id, ITEM)).toBe(false);
  });

  it('falls back to the loopback address when the container name does not resolve', async () => {
    installFetch({ [BASE]: 'refused', [FALLBACK]: vault });
    const session = await connectVault(conn([BASE, FALLBACK]));
    expect(session.baseUrl).toBe(FALLBACK);
  });

  it('reports a rejected password as auth_failed and stops trying addresses', async () => {
    const wrongPassword = { ...conn([BASE, FALLBACK]), password: 'not-the-password' };
    installFetch({ [BASE]: vault, [FALLBACK]: vault });
    await expect(connectVault(wrongPassword)).rejects.toMatchObject({ reason: 'auth_failed' });
    // A bad password is bad at every address — no pointless second try.
    expect(vault.calls.filter(c => c.endsWith('/identity/connect/token'))).toHaveLength(1);
  });

  it('reports a total outage as unreachable', async () => {
    installFetch({ [BASE]: 'refused', [FALLBACK]: 'refused' });
    await expect(connectVault(conn([BASE, FALLBACK]))).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('reports an account that is not in the organization', async () => {
    vault.memberOfOrgId = vault.otherOrgId;
    installFetch({ [BASE]: vault });
    await expect(connectVault(conn())).rejects.toMatchObject({ reason: 'org_unavailable' });
  });

  it('refuses to run half-configured', async () => {
    installFetch({ [BASE]: vault });
    await expect(connectVault({ ...conn(), collectionId: '' }))
      .rejects.toMatchObject({ reason: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses an Argon2id account by name rather than pushing garbage', async () => {
    installFetch({ [BASE]: vault });
    const original = vault.handle.bind(vault);
    vault.handle = (url, init) =>
      new URL(url).pathname === '/identity/accounts/prelogin'
        ? json({ Kdf: 1, KdfIterations: 3 })
        : original(url, init);
    const err = await connectVault(conn()).catch(e => e as VaultwardenError);
    expect(err).toBeInstanceOf(VaultwardenError);
    expect((err as VaultwardenError).reason).toBe('crypto_unsupported');
    expect((err as VaultwardenError).message).toMatch(/Argon2id/);
  });
});
