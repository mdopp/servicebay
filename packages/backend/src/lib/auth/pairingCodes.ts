/**
 * Device-pairing one-time codes (#2251, epic #2242) — the transient store
 * behind `POST /napi/pair` (mint) and `POST /napi/pair/redeem` (public redeem).
 *
 * SECURITY MODEL — this backs the ONE public token-minting surface, so it is
 * deliberately paranoid:
 *   - A code is minted ONLY by an authenticated admin (the route enforces the
 *     Authelia-session trust model; this store just issues + tracks).
 *   - A code is short (6 chars) and short-lived (≤ 5 min TTL). It is single-use:
 *     `redeemCode` atomically marks it consumed before it can mint anything, so
 *     two concurrent redeems can never both succeed (mirrors the read-modify-
 *     write concurrency discipline in apiTokens.ts, #2239).
 *   - Redeem compares in constant time (crypto.timingSafeEqual over a normalized
 *     candidate) so a timing oracle can't leak a partially-correct code.
 *   - A global attempt cap rate-limits brute force: once the failed-redeem
 *     budget in the current window is exhausted, every redeem fails closed until
 *     the window rolls, regardless of correctness. A leaked/guessed code must
 *     never mint anything after first use, after expiry, or past the cap.
 *
 * The store is IN-MEMORY only (per issue): codes are ephemeral (≤ 5 min), so no
 * persistence is needed or wanted — a restart simply invalidates outstanding
 * codes, which is the safe direction (fail closed).
 */
import crypto from 'crypto';

/** Alphabet for the human-typed code: unambiguous base32-ish (no I/O/0/1),
 *  matching the token secret alphabet so read-aloud/typed codes don't collide. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 6 chars from a 32-symbol alphabet → 32^6 ≈ 1.07e9 combinations. Combined
 *  with the ≤5-min TTL and the attempt cap below, brute force is infeasible. */
const CODE_LEN = 6;
/** Hard TTL cap for a pairing code: 5 minutes (issue: "≤ 5 min"). */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Failed-redeem budget per rolling window. Once exhausted, every redeem fails
 *  closed until the window rolls — a brute-force damper independent of any one
 *  code's validity. Successful redeems do not consume the budget. */
const MAX_FAILED_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 60 * 1000;

interface PairingCode {
  /** The normalized (upper-case) code string. */
  code: string;
  createdAt: number;
  expiresAt: number;
  /** Flipped true the instant a redeem claims this code — single-use latch. */
  consumed: boolean;
  /** Who minted it (audit only): the Authelia-identified admin. */
  createdBy: string;
}

// Single in-memory map, keyed by normalized code. A restart drops it (safe).
const store = new Map<string, PairingCode>();

// Rolling failed-attempt counter for the brute-force damper.
let failedCount = 0;
let windowStart = Date.now();

function now(): number {
  return Date.now();
}

/** Drop expired entries so the map can't grow unbounded across many mints. */
function sweepExpired(t: number): void {
  for (const [key, c] of store) {
    if (c.expiresAt < t || c.consumed) store.delete(key);
  }
}

function genCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Normalize a candidate for comparison: strip whitespace, upper-case. Returns
 *  '' for anything non-string so a missing/garbage code fails the length check. */
function normalize(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Mint a fresh single-use pairing code. Called by `POST /napi/pair` AFTER the
 * route has proven the caller is an Authelia-verified admin. Returns the code
 * and its absolute expiry (epoch ms). Sweeps expired/consumed entries first.
 */
export function createPairingCode(createdBy: string): { code: string; expiresAt: number; ttlMs: number } {
  const t = now();
  sweepExpired(t);
  // Regenerate on the astronomically-unlikely collision with a live code.
  let code = genCode();
  while (store.has(code)) code = genCode();
  const expiresAt = t + PAIRING_CODE_TTL_MS;
  store.set(code, { code, createdAt: t, expiresAt, consumed: false, createdBy });
  return { code, expiresAt, ttlMs: PAIRING_CODE_TTL_MS };
}

/** Result of a redeem attempt. `ok:true` is the ONLY branch the route may mint
 *  a token on. Everything else is fail-closed with a caller-safe reason. */
export type RedeemResult =
  | { ok: true; createdBy: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'rate_limited' };

/**
 * Atomically redeem a pairing code. Single-use: on success the code is marked
 * consumed (and removed) BEFORE this returns, so a racing second redeem of the
 * same code sees `consumed` / absence and fails. Node's single-threaded event
 * loop makes the check-then-mark below atomic (no `await` between them), which
 * is the same guarantee apiTokens.ts relies on for its append (#2239).
 *
 * Fail-closed: an invalid, expired, already-used, or garbage code returns
 * `ok:false` and mints nothing. A constant-time compare against the stored code
 * avoids leaking how many leading chars matched.
 */
export function redeemCode(raw: unknown): RedeemResult {
  const t = now();

  // Roll the attempt window if it has elapsed.
  if (t - windowStart >= ATTEMPT_WINDOW_MS) {
    windowStart = t;
    failedCount = 0;
  }
  // Brute-force damper: once the failed budget is spent, fail closed for every
  // redeem in the window — even a correct code — so an attacker can't keep
  // guessing at line rate. (A legitimate user retries after the short window.)
  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: 'rate_limited' };
  }

  const candidate = normalize(raw);
  if (candidate.length !== CODE_LEN) {
    failedCount++;
    return { ok: false, reason: 'invalid' };
  }

  // Constant-time scan over live entries: we compare the candidate against each
  // stored code with timingSafeEqual so the reject path doesn't leak (via
  // timing) whether/where it diverged. The map is tiny (a handful of live codes)
  // so the linear scan is negligible.
  let match: PairingCode | undefined;
  const candBuf = Buffer.from(candidate, 'utf8');
  for (const c of store.values()) {
    const storedBuf = Buffer.from(c.code, 'utf8');
    if (storedBuf.length === candBuf.length && crypto.timingSafeEqual(storedBuf, candBuf)) {
      match = c;
      break;
    }
  }

  if (!match) {
    failedCount++;
    return { ok: false, reason: 'invalid' };
  }
  if (match.consumed) {
    // Should already be swept, but latch defensively.
    store.delete(match.code);
    failedCount++;
    return { ok: false, reason: 'used' };
  }
  if (match.expiresAt < t) {
    store.delete(match.code);
    failedCount++;
    return { ok: false, reason: 'expired' };
  }

  // SUCCESS: claim it atomically. Mark consumed + remove from the store BEFORE
  // returning so a concurrent redeem of the same code can't also mint. No await
  // between the check above and this claim → the single-threaded loop makes it
  // indivisible.
  match.consumed = true;
  store.delete(match.code);
  return { ok: true, createdBy: match.createdBy };
}

/** Test-only: reset the in-memory store + attempt counters between cases. */
export function __resetPairingCodesForTest(): void {
  store.clear();
  failedCount = 0;
  windowStart = Date.now();
}
