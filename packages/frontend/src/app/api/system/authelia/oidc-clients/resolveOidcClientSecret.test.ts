import { describe, it, expect, vi } from 'vitest';
import { resolveOidcClientSecret, extractPlaintextSecret } from './route';

describe('extractPlaintextSecret', () => {
  it('strips the $plaintext$ prefix off a stored secret', () => {
    expect(extractPlaintextSecret('$plaintext$abc123')).toBe('abc123');
  });

  it('returns a prefix-less value verbatim (legacy / hand-edited config)', () => {
    expect(extractPlaintextSecret('rawSecretValue')).toBe('rawSecretValue');
  });

  it('returns null for a one-way hashed secret (not reusable as plaintext)', () => {
    expect(extractPlaintextSecret('$pbkdf2-sha512$310000$abc$def')).toBeNull();
    expect(extractPlaintextSecret('$argon2id$v=19$m=65536$x$y')).toBeNull();
  });

  it('returns null for an empty / non-string / empty-plaintext value', () => {
    expect(extractPlaintextSecret('')).toBeNull();
    expect(extractPlaintextSecret(undefined)).toBeNull();
    expect(extractPlaintextSecret(null)).toBeNull();
    expect(extractPlaintextSecret('$plaintext$')).toBeNull();
  });
});

describe('resolveOidcClientSecret (#1738 — reconcile, never regenerate)', () => {
  it('REUSES the persisted on-disk secret for an existing client (no regeneration)', () => {
    const generate = vi.fn(() => 'FRESH_GENERATED');
    const res = resolveOidcClientSecret('$plaintext$persistedValue', undefined, generate);
    expect(res).toEqual({ secret: 'persistedValue', reused: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it('persisted secret wins over a (re-)supplied value — never rotates a live client', () => {
    const generate = vi.fn(() => 'FRESH_GENERATED');
    const res = resolveOidcClientSecret('$plaintext$persistedValue', 'suppliedValue', generate);
    expect(res).toEqual({ secret: 'persistedValue', reused: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it('GENERATES + flags not-reused for a brand-new client with no persisted/supplied secret', () => {
    const generate = vi.fn(() => 'FRESH_GENERATED');
    const res = resolveOidcClientSecret(undefined, undefined, generate);
    expect(res).toEqual({ secret: 'FRESH_GENERATED', reused: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses the supplied (installedSecrets) value when the client was dropped from Authelia', () => {
    // Client_id no longer on disk (persisted undefined) but the service still
    // holds its secret, surfaced via variables[clientSecretVar] → reuse it,
    // do not mint a new one that would diverge from the service.
    const generate = vi.fn(() => 'FRESH_GENERATED');
    const res = resolveOidcClientSecret(undefined, 'installedSecretValue', generate);
    expect(res).toEqual({ secret: 'installedSecretValue', reused: true });
    expect(generate).not.toHaveBeenCalled();
  });

  it('falls back to generate when the persisted secret is hashed (unrecoverable)', () => {
    const generate = vi.fn(() => 'FRESH_GENERATED');
    const res = resolveOidcClientSecret('$pbkdf2-sha512$x$y$z', undefined, generate);
    expect(res).toEqual({ secret: 'FRESH_GENERATED', reused: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — re-resolving an existing client yields the same secret', () => {
    const a = resolveOidcClientSecret('$plaintext$stable', 'irrelevant');
    const b = resolveOidcClientSecret('$plaintext$stable', 'irrelevant');
    expect(a.secret).toBe('stable');
    expect(b.secret).toBe('stable');
  });
});
