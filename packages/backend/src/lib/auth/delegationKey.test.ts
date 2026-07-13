import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { getDelegationKey, resetDelegationKeyCache } from './delegationKey';

// #2270 — the delegated-admin trust key is DERIVED from AUTH_SECRET (ADR 0009
// root-of-trust), so it inherits AUTH_SECRET's wipe-config-reinstall survival:
// as long as AUTH_SECRET is preserved (which ADR 0009 §1 mandates), the derived
// key is byte-identical across restarts/reinstalls — no new persisted file, no
// key that "regenerates on reinstall".

const ORIG = process.env.AUTH_SECRET;
const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);

beforeEach(() => resetDelegationKeyCache());
afterEach(() => {
  if (ORIG === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIG;
  resetDelegationKeyCache();
});

describe('delegationKey', () => {
  it('derives a 32-byte HMAC key from AUTH_SECRET', () => {
    process.env.AUTH_SECRET = SECRET_A;
    const key = getDelegationKey();
    expect(key).toHaveLength(32);
  });

  it('is deterministic for a given AUTH_SECRET (survives a simulated reinstall that preserves it)', () => {
    process.env.AUTH_SECRET = SECRET_A;
    const before = getDelegationKey();
    // Simulate a wipe-config reinstall: process restart (cache cleared) but
    // AUTH_SECRET is preserved per ADR 0009 §1.
    resetDelegationKeyCache();
    const after = getDelegationKey();
    expect(after.equals(before)).toBe(true);
  });

  it('changes when AUTH_SECRET changes (a fresh identity yields a fresh key)', () => {
    process.env.AUTH_SECRET = SECRET_A;
    const keyA = getDelegationKey();
    resetDelegationKeyCache();
    process.env.AUTH_SECRET = SECRET_B;
    const keyB = getDelegationKey();
    expect(keyB.equals(keyA)).toBe(false);
  });

  it('is domain-separated from the internal API token key (independent derivation)', () => {
    process.env.AUTH_SECRET = SECRET_A;
    const delegationKey = getDelegationKey().toString('hex');
    // The internalToken derivation uses a different label over the same secret;
    // the two outputs must not collide.
    const internalTokenKey = crypto
      .createHmac('sha256', SECRET_A)
      .update('servicebay:internal-api:v1')
      .digest('hex');
    expect(delegationKey).not.toBe(internalTokenKey);
  });

  it('falls closed (random, non-deterministic) when AUTH_SECRET is unset', () => {
    delete process.env.AUTH_SECRET;
    const k1 = getDelegationKey();
    resetDelegationKeyCache();
    const k2 = getDelegationKey();
    // Two independent random keys → verification of any externally-minted
    // assertion fails closed rather than authenticating.
    expect(k1.equals(k2)).toBe(false);
  });
});
