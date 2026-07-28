/**
 * #1724 — redeploying the auth stack must NOT drop other stacks' OIDC clients.
 *
 * The freshly mustache-rendered auth `configuration.yml` only contains the
 * baked-in `servicebay` client. These tests assert `mergeAutheliaOidcClients`
 * re-introduces every client already on disk (immich, vaultwarden, …),
 * preserving each one's secret, idempotently, and that a never-installed
 * client stays absent.
 */
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { mergeAutheliaOidcClients } from './autheliaClientMerge';

interface OidcClient {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

function clientsOf(config: string): OidcClient[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = yaml.load(config) as any;
  return doc?.identity_providers?.oidc?.clients ?? [];
}

function ids(config: string): string[] {
  return clientsOf(config).map(c => c.client_id);
}

/** The fresh render: exactly what the mustache produces on a redeploy. */
const RENDERED = `
identity_providers:
  oidc:
    hmac_secret: 'hmac-xyz'
    clients:
      - client_id: 'servicebay'
        client_name: 'ServiceBay'
        client_secret: '$plaintext$sbNEW'
        redirect_uris:
          - 'https://admin.example.com/api/auth/oidc/callback'
`;

/** The on-disk config after immich + vaultwarden registered incrementally. */
const ON_DISK = `
identity_providers:
  oidc:
    hmac_secret: 'hmac-xyz'
    clients:
      - client_id: 'servicebay'
        client_name: 'ServiceBay'
        client_secret: '$plaintext$sbOLD'
        redirect_uris:
          - 'https://admin.example.com/api/auth/oidc/callback'
      - client_id: 'immich'
        client_name: 'Immich'
        client_secret: '$plaintext$immich-real-secret'
        redirect_uris:
          - 'https://photos.example.com/auth/login'
      - client_id: 'vaultwarden'
        client_name: 'Vaultwarden'
        client_secret: '$plaintext$vault-real-secret'
        redirect_uris:
          - 'https://vault.example.com/identity/connect/oidc-signin'
`;

describe('mergeAutheliaOidcClients (#1724)', () => {
  it('re-introduces every on-disk client the fresh render dropped', () => {
    const merged = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    expect(ids(merged).sort()).toEqual(['immich', 'servicebay', 'vaultwarden']);
  });

  it('preserves each preserved client secret (no rotation — #1559 family)', () => {
    const merged = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    const byId = Object.fromEntries(clientsOf(merged).map(c => [c.client_id, c]));
    expect(byId.immich.client_secret).toBe('$plaintext$immich-real-secret');
    expect(byId.vaultwarden.client_secret).toBe('$plaintext$vault-real-secret');
  });

  it('lets the fresh render win for a shared client_id (servicebay baseline)', () => {
    // On-disk servicebay carries the OLD secret; the render is authoritative.
    const merged = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    const sb = clientsOf(merged).find(c => c.client_id === 'servicebay')!;
    expect(sb.client_secret).toBe('$plaintext$sbNEW');
    // and exactly one servicebay entry — no duplicate
    expect(ids(merged).filter(i => i === 'servicebay')).toHaveLength(1);
  });

  /**
   * #2417 — this is the load-bearing asymmetry, so assert it as its own case
   * rather than leaning on the general "render wins" rule.
   *
   * The module's headline property is that it NEVER rotates an already-
   * registered client's secret (#1559). `servicebay` is the ONE deliberate
   * exception: because the auth template's mustache declares that client, the
   * fresh render owns it, and the per-install `SERVICEBAY_OIDC_SECRET` replaces
   * whatever was on disk — which is exactly the mechanism that migrates an
   * existing box off the old hardcoded literal. If this ever flipped to
   * "preserve", the upgrade would silently no-op and every install would keep
   * the world-readable secret forever.
   */
  it('DOES rotate servicebay while preserving every other client secret', () => {
    const merged = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    const byId = Object.fromEntries(clientsOf(merged).map(c => [c.client_id, c]));
    expect(byId.servicebay.client_secret).toBe('$plaintext$sbNEW');   // rotated
    expect(byId.servicebay.client_secret).not.toBe('$plaintext$sbOLD');
    expect(byId.immich.client_secret).toBe('$plaintext$immich-real-secret');       // untouched
    expect(byId.vaultwarden.client_secret).toBe('$plaintext$vault-real-secret');   // untouched
  });

  it('is idempotent — re-running yields no duplicate clients', () => {
    const once = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    const twice = mergeAutheliaOidcClients(RENDERED, once);
    expect(ids(twice).sort()).toEqual(['immich', 'servicebay', 'vaultwarden']);
  });

  it('keeps a never-installed client absent', () => {
    const merged = mergeAutheliaOidcClients(RENDERED, ON_DISK);
    expect(ids(merged)).not.toContain('audiobookshelf');
  });

  it('returns the fresh render unchanged on a fresh install (no on-disk file)', () => {
    expect(mergeAutheliaOidcClients(RENDERED, '')).toBe(RENDERED);
    expect(mergeAutheliaOidcClients(RENDERED, null)).toBe(RENDERED);
    expect(mergeAutheliaOidcClients(RENDERED, undefined)).toBe(RENDERED);
  });

  it('fails soft — a malformed on-disk file leaves the fresh render intact', () => {
    const garbage = 'identity_providers:\n  oidc:\n    clients: [ : : ::';
    expect(mergeAutheliaOidcClients(RENDERED, garbage)).toBe(RENDERED);
  });

  it('drops a duplicate client_id already in the on-disk list (dedup)', () => {
    const dupDisk = ON_DISK + `      - client_id: 'immich'\n        client_secret: '$plaintext$dup'\n`;
    const merged = mergeAutheliaOidcClients(RENDERED, dupDisk);
    expect(ids(merged).filter(i => i === 'immich')).toHaveLength(1);
  });
});
