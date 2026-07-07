/**
 * Health "pending vs healthy-silent" distinction (#2166).
 *
 * `isCheckPending` classifies a resultless check as pending (just created,
 * first tick pending) only while inside the grace window — a resultless check
 * older than the window is NOT pending (that's a genuine stale signal). Before
 * #2166 both collapsed to status:'unknown'/lastRun:null and were
 * indistinguishable.
 */

import { describe, it, expect } from 'vitest';
import { isCheckPending, PENDING_GRACE_MS } from '@/lib/health/types';

describe('isCheckPending (#2166)', () => {
  const now = Date.now();

  it('a check created just now with no result is pending', () => {
    expect(isCheckPending(new Date(now).toISOString(), false, now)).toBe(true);
  });

  it('a check created within the grace window with no result is pending', () => {
    const created = new Date(now - (PENDING_GRACE_MS - 1_000)).toISOString();
    expect(isCheckPending(created, false, now)).toBe(true);
  });

  it('a resultless check older than the grace window is NOT pending (healthy-silent / stale)', () => {
    const created = new Date(now - (PENDING_GRACE_MS + 1_000)).toISOString();
    expect(isCheckPending(created, false, now)).toBe(false);
  });

  it('a check with a result is never pending, even if just created', () => {
    expect(isCheckPending(new Date(now).toISOString(), true, now)).toBe(false);
  });

  it('a check with no created_at is not treated as pending', () => {
    expect(isCheckPending(undefined, false, now)).toBe(false);
  });

  it('an unparseable created_at is not treated as pending', () => {
    expect(isCheckPending('not-a-date', false, now)).toBe(false);
  });
});
