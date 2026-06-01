import { describe, it, expect, vi } from 'vitest';
import { reconcileLogin, type ReconcileDeps } from './reconcile';

// Fake scrypt-like primitives: a "hash" is just `h:<plain>`, and verify checks
// the plaintext against the encoded plaintext. Lets the policy be asserted
// without real crypto.
function fakeDeps(): ReconcileDeps {
  return {
    hashPassword: vi.fn(async (plain: string) => `h:${plain}`),
    verifyPassword: vi.fn(async (plain: string, encoded: string) => encoded === `h:${plain}`),
  };
}

describe('reconcileLogin', () => {
  it('accepts the stored password and does NOT re-key (operator-changed pw wins)', async () => {
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'operator-pw', storedHash: 'h:operator-pw', bootstrapPassword: 'new-env-pw' },
      deps,
    );
    expect(res).toEqual({ authenticated: true });
    expect(res.newStoredHash).toBeUndefined();
  });

  it('reconciles on reinstall: stored hash rejects, env password accepts and re-keys', async () => {
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'new-env-pw', storedHash: 'h:old-install-pw', bootstrapPassword: 'new-env-pw' },
      deps,
    );
    expect(res.authenticated).toBe(true);
    expect(res.newStoredHash).toBe('h:new-env-pw');
  });

  it('does not let the env password win while a stored hash still authenticates the request', async () => {
    // Wrong candidate: neither the stored nor the env password matches.
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'guess', storedHash: 'h:operator-pw', bootstrapPassword: 'new-env-pw' },
      deps,
    );
    expect(res).toEqual({ authenticated: false });
  });

  it('rejects when stored hash rejects and there is no bootstrap password', async () => {
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'whatever', storedHash: 'h:operator-pw', bootstrapPassword: null },
      deps,
    );
    expect(res).toEqual({ authenticated: false });
  });

  it('seeds the stored hash from the env password on a first login with no stored hash', async () => {
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'env-pw', storedHash: null, bootstrapPassword: 'env-pw' },
      deps,
    );
    expect(res.authenticated).toBe(true);
    expect(res.newStoredHash).toBe('h:env-pw');
  });

  it('rejects when nothing is configured (no stored hash, no bootstrap)', async () => {
    const deps = fakeDeps();
    const res = await reconcileLogin(
      { candidate: 'x', storedHash: null, bootstrapPassword: null },
      deps,
    );
    expect(res).toEqual({ authenticated: false });
  });

  it('tries the stored hash before the env password (precedence order)', async () => {
    const order: string[] = [];
    const deps: ReconcileDeps = {
      hashPassword: async (p) => `h:${p}`,
      verifyPassword: async (_p, encoded) => {
        order.push(encoded);
        return false; // force fall-through so both verifies run
      },
    };
    await reconcileLogin(
      { candidate: 'c', storedHash: 'h:stored', bootstrapPassword: 'env' },
      deps,
    );
    expect(order).toEqual(['h:stored', 'h:env']);
  });
});
