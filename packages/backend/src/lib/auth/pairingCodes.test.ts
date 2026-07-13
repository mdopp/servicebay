/**
 * Device-pairing one-time code store (#2251) — the security core behind the ONE
 * public token-minting surface. These tests pin the fail-closed guarantees:
 * single-use (incl. the concurrent-redeem race), TTL expiry, garbage rejection,
 * and the brute-force attempt cap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPairingCode,
  redeemCode,
  __resetPairingCodesForTest,
  PAIRING_CODE_TTL_MS,
} from './pairingCodes';

describe('pairingCodes store (#2251)', () => {
  beforeEach(() => {
    __resetPairingCodesForTest();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a 6-char code from the unambiguous alphabet', () => {
    const { code, expiresAt } = createPairingCode('authelia:admin');
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('redeems a valid code exactly once and returns the minter', () => {
    const { code } = createPairingCode('authelia:alice');
    const r = redeemCode(code);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.createdBy).toBe('authelia:alice');
  });

  it('SINGLE-USE: a second redeem of the same code fails closed', () => {
    const { code } = createPairingCode('authelia:admin');
    expect(redeemCode(code).ok).toBe(true);
    const second = redeemCode(code);
    expect(second.ok).toBe(false);
    // The code is gone from the store, so the second attempt reads as invalid.
    if (!second.ok) expect(['used', 'invalid']).toContain(second.reason);
  });

  it('SINGLE-USE RACE: two synchronous redeems of one code — exactly one wins', () => {
    // The store is synchronous (no await between check and claim), so two
    // back-to-back redeems in the same tick model the concurrent case: the
    // first claims + removes the code atomically, the second can't also mint.
    const { code } = createPairingCode('authelia:admin');
    const a = redeemCode(code);
    const b = redeemCode(code);
    const wins = [a, b].filter(r => r.ok).length;
    expect(wins).toBe(1);
  });

  it('EXPIRY: a code past its TTL fails closed with reason "expired"', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { code } = createPairingCode('authelia:admin');
    vi.setSystemTime(start + PAIRING_CODE_TTL_MS + 1000);
    const r = redeemCode(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('rejects an unknown / garbage / missing code without minting', () => {
    createPairingCode('authelia:admin'); // a real live code exists
    expect(redeemCode('ZZZZZZ').ok).toBe(false);       // wrong 6-char
    expect(redeemCode('short').ok).toBe(false);         // wrong length
    expect(redeemCode('').ok).toBe(false);              // empty
    expect(redeemCode(undefined).ok).toBe(false);       // missing
    expect(redeemCode(12345).ok).toBe(false);           // non-string
    expect(redeemCode({ code: 'x' }).ok).toBe(false);   // object
  });

  it('normalizes whitespace + case on redeem', () => {
    const { code } = createPairingCode('authelia:admin');
    const r = redeemCode(`  ${code.toLowerCase()}  `);
    expect(r.ok).toBe(true);
  });

  it('RATE-LIMIT: exhausting the failed-attempt budget fails closed even for a valid code', () => {
    const { code } = createPairingCode('authelia:admin');
    // Burn the budget with wrong guesses (10 failures in the window).
    for (let i = 0; i < 12; i++) redeemCode('ZZZZZZ');
    const r = redeemCode(code); // correct code, but budget spent
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rate_limited');
  });

  it('RATE-LIMIT resets after the window rolls, then the valid code redeems', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { code } = createPairingCode('authelia:admin');
    for (let i = 0; i < 12; i++) redeemCode('ZZZZZZ');
    expect(redeemCode(code).ok).toBe(false); // rate-limited now
    vi.setSystemTime(start + 61 * 1000);     // roll the 60s window
    const r = redeemCode(code);              // budget reset, code still live
    expect(r.ok).toBe(true);
  });
});
