/**
 * #2417 — the `servicebay` Authelia OIDC client's per-install secret.
 *
 * These cover the three decisions that make the rotation safe:
 *   - reading the secret back OUT of Authelia's config (ServiceBay follows the
 *     file, never leads it);
 *   - what `config.oidc` becomes, including the cases that must NOT write;
 *   - the break-glass pre-flight that refuses to rotate the only credential a
 *     box has.
 */
import { describe, it, expect } from 'vitest';
import {
  extractServicebayClientSecret,
  decideOidcSecretUpdate,
  assertBreakGlassLogin,
  isServicebaySecretRotation,
  SERVICEBAY_CLIENT_ID,
} from './servicebayOidcSecret';

const config = (sbSecret: string, extra = '') => `
identity_providers:
  oidc:
    hmac_secret: 'hmac-xyz'
    clients:
      - client_id: 'servicebay'
        client_name: 'ServiceBay'
        client_secret: '${sbSecret}'
        redirect_uris:
          - 'https://admin.example.com/api/auth/oidc/callback'
      - client_id: 'other-service'
        client_secret: '$plaintext$other-secret'
${extra}`;

describe('extractServicebayClientSecret', () => {
  it('pulls the servicebay client secret and strips the $plaintext$ prefix', () => {
    expect(extractServicebayClientSecret(config('$plaintext$perBoxValue'))).toBe('perBoxValue');
  });

  it('picks servicebay specifically, not just the first client', () => {
    const reordered = `
identity_providers:
  oidc:
    clients:
      - client_id: 'other-service'
        client_secret: '$plaintext$other-secret'
      - client_id: 'servicebay'
        client_secret: '$plaintext$theRightOne'
`;
    expect(extractServicebayClientSecret(reordered)).toBe('theRightOne');
  });

  it('honours an explicit client_id argument', () => {
    expect(extractServicebayClientSecret(config('$plaintext$sb'), 'other-service')).toBe('other-secret');
  });

  it('exports the client_id the auth template declares', () => {
    expect(SERVICEBAY_CLIENT_ID).toBe('servicebay');
  });

  // The refusals below all matter for the same reason: returning a wrong or
  // useless value here would OVERWRITE a working config.oidc.clientSecret.
  it('returns null for a HASHED secret — a hash can never be replayed', () => {
    expect(extractServicebayClientSecret(config('$pbkdf2-sha512$310000$abc$def'))).toBeNull();
    expect(extractServicebayClientSecret(config('$argon2id$v=19$m=65536$abc$def'))).toBeNull();
  });

  it('returns null for an empty $plaintext$ value', () => {
    expect(extractServicebayClientSecret(config('$plaintext$'))).toBeNull();
  });

  it('returns null when the servicebay client is absent', () => {
    const noSb = `
identity_providers:
  oidc:
    clients:
      - client_id: 'other-service'
        client_secret: '$plaintext$other-secret'
`;
    expect(extractServicebayClientSecret(noSb)).toBeNull();
  });

  it('returns null — never throws — on empty / malformed / shapeless input', () => {
    expect(extractServicebayClientSecret('')).toBeNull();
    expect(extractServicebayClientSecret(null)).toBeNull();
    expect(extractServicebayClientSecret(undefined)).toBeNull();
    expect(extractServicebayClientSecret('identity_providers:\n  oidc:\n    clients: [ : : ::')).toBeNull();
    expect(extractServicebayClientSecret('session:\n  secret: nope\n')).toBeNull();
    expect(extractServicebayClientSecret('identity_providers:\n  oidc:\n    clients: not-a-list\n')).toBeNull();
  });
});

describe('decideOidcSecretUpdate', () => {
  const current = { enabled: true, issuer: 'https://auth.example.com', clientId: 'servicebay', clientSecret: 'oldValue' };

  it('adopts the Authelia secret when it differs', () => {
    const { result, next } = decideOidcSecretUpdate(current, 'newValue');
    expect(result.outcome).toBe('changed');
    expect(next!.clientSecret).toBe('newValue');
  });

  it('preserves enabled / issuer / allowedGroups while swapping the secret', () => {
    const withGroups = { ...current, allowedGroups: ['admins'] };
    const { next } = decideOidcSecretUpdate(withGroups, 'newValue');
    expect(next).toEqual({
      enabled: true,
      issuer: 'https://auth.example.com',
      clientId: 'servicebay',
      clientSecret: 'newValue',
      allowedGroups: ['admins'],
    });
  });

  it('no-ops when the two sides already agree (idempotent re-run)', () => {
    const { result, next } = decideOidcSecretUpdate({ ...current, clientSecret: 'same' }, 'same');
    expect(result.outcome).toBe('aligned');
    expect(next).toBeUndefined();
  });

  it('records the secret on a box with no oidc block, WITHOUT enabling SSO', () => {
    const { result, next } = decideOidcSecretUpdate(undefined, 'newValue');
    expect(result.outcome).toBe('changed');
    expect(next!.clientSecret).toBe('newValue');
    expect(next!.clientId).toBe('servicebay');
    // Whether the admin panel offers SSO stays the operator's decision.
    expect(next!.enabled).toBe(false);
  });

  it('never turns a working SSO config OFF', () => {
    const { next } = decideOidcSecretUpdate(current, 'newValue');
    expect(next!.enabled).toBe(true);
  });

  it('writes NOTHING when the Authelia secret is unreadable', () => {
    // The dangerous case: an unreadable/hashed file must not clobber a value
    // the admin panel is currently logging in with.
    const { result, next } = decideOidcSecretUpdate(current, null);
    expect(result.outcome).toBe('skipped');
    expect(next).toBeUndefined();
  });

  it('keeps the secret out of every operator-facing message', () => {
    for (const [cur, sec] of [[current, 'sup3rSecretValue'], [undefined, 'sup3rSecretValue'], [current, null]] as const) {
      const { result } = decideOidcSecretUpdate(cur, sec);
      expect(result.message).not.toContain('sup3rSecretValue');
      expect(result.message).not.toContain('oldValue');
    }
  });
});

describe('isServicebaySecretRotation', () => {
  it('is true when the render carries a different secret than the disk', () => {
    expect(isServicebaySecretRotation(config('$plaintext$newOne'), config('$plaintext$oldOne'))).toBe(true);
  });

  it('is false in the steady state (same value re-rendered)', () => {
    expect(isServicebaySecretRotation(config('$plaintext$same'), config('$plaintext$same'))).toBe(false);
  });

  it('is false on a fresh install — no working login to break', () => {
    expect(isServicebaySecretRotation(config('$plaintext$newOne'), null)).toBe(false);
    expect(isServicebaySecretRotation(config('$plaintext$newOne'), '')).toBe(false);
  });

  it('is false when either side is unreadable (fail-soft, never block a deploy)', () => {
    expect(isServicebaySecretRotation(config('$plaintext$newOne'), 'garbage: [ : :')).toBe(false);
    expect(isServicebaySecretRotation('garbage: [ : :', config('$plaintext$oldOne'))).toBe(false);
  });
});

describe('assertBreakGlassLogin', () => {
  it('allows the rotation when a stored admin password hash exists', () => {
    expect(assertBreakGlassLogin('scrypt$abc', undefined)).toBeNull();
  });

  it('allows the rotation when only the SERVICEBAY_PASSWORD bootstrap is set', () => {
    expect(assertBreakGlassLogin(undefined, 'bootstrap-pw')).toBeNull();
  });

  it('REFUSES when SSO is the only door into the admin panel', () => {
    const reason = assertBreakGlassLogin(undefined, undefined);
    expect(reason).toBeTruthy();
    // The message has to be actionable — this is the operator's only clue.
    expect(reason).toContain('SERVICEBAY_PASSWORD');
    expect(reason).toContain('#2417');
  });

  it('treats an empty string as absent, not as a credential', () => {
    expect(assertBreakGlassLogin('', '')).toBeTruthy();
  });
});
