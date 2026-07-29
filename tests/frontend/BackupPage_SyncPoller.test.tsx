import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #2459 — "Run Now" on the Backup Sync panel started a 5 s `setInterval` inline,
 * with no ref and no cleanup. Pre-fix, navigating away from /backup mid-sync left
 * that interval alive for the rest of the session: it kept polling
 * `/api/settings/backup-sync` and kept calling setState on an unmounted view.
 *
 * Post-fix the interval lives in a ref, is cleared on unmount, and its in-flight
 * answer is dropped when the interval it belongs to is no longer the live one — so
 * unmount really ends the poll.
 *
 * The 5 s cadence is driven by hand (fake timers + explicit flushes) rather than
 * RTL's `waitFor`, which does not cooperate with faked intervals.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/backup',
  useSearchParams: () => new URLSearchParams(),
}));

const toast = vi.hoisted(() => ({ addToast: vi.fn(), updateToast: vi.fn() }));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));
vi.mock('@/app/actions/nodes', () => ({ getNodes: vi.fn(async () => []) }));

// Panels with their own fetching/state that this lifecycle test doesn't exercise.
vi.mock('@/app/(dashboard)/backup/_lib/ExternalBackupDestinationSection', () => ({ default: () => null }));
vi.mock('@/app/(dashboard)/backup/_lib/LocalTargetPicker', () => ({ default: () => null }));
vi.mock('@/components/FileViewer', () => ({ default: () => null }));

import BackupPage from '@/app/(dashboard)/backup/page';

/** How many times the "Run Now" poller has polled (mount-time load excluded). */
let syncPolls: number;
/** Flipped once the mount-time load is done, so polls can be counted apart from it. */
let started: boolean;
/** What a poll reports — the sync stays running until a test says otherwise. */
let syncRunning: boolean;
/** Set by a test to hold a poll response open past unmount. */
let holdPoll: boolean;
let releasePoll: (() => void) | null;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// `enabled: true` because the panel that hosts Run Now only renders for an
// enabled sync config.
const CONFIG = {
  enabled: true,
  schedule: 'daily',
  time: '02:00',
  target: { type: 'local', path: '/mnt/backup' },
  lastStatus: 'success',
  lastMessage: 'Backup completed',
};

beforeEach(() => {
  syncPolls = 0;
  started = false;
  syncRunning = true;
  holdPoll = false;
  releasePoll = null;
  toast.addToast.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/settings/backup-sync')) {
      if ((init?.method ?? 'GET') !== 'GET') return json({ ok: true });
      // Mount-time load: nothing is running yet, so the Run Now button is live.
      if (!started) return json({ running: false, config: CONFIG, history: [] });
      syncPolls += 1;
      if (holdPoll) await new Promise<void>(resolve => { releasePoll = resolve; });
      return json({ running: syncRunning, config: CONFIG, history: [] });
    }
    if (url.startsWith('/api/settings/backups')) return json([]);
    if (url.startsWith('/api/system/external-backup/list')) {
      return json({ configured: false, connection: null, backups: [] });
    }
    return json({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Mount the page, let its initial loads land, then start a sync run. */
async function renderAndRunSync() {
  const view = render(<BackupPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  started = true;

  fireEvent.click(screen.getByRole('button', { name: /Run Now/i }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // The run started: the button reports progress, so the poller is live.
  expect(screen.getByRole('button', { name: /Running/i })).toBeTruthy();
  return view;
}

/** Advance N poll intervals (5 s each), flushing each handler. */
async function pollTicks(n: number) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
  }
}

describe('Backup Sync "Run Now" poller — lifecycle (#2459)', () => {
  it('polls while mounted and stops polling once the page unmounts', async () => {
    const { unmount } = await renderAndRunSync();

    await pollTicks(2);
    expect(syncPolls).toBe(2);

    // Navigating away from /backup mid-sync.
    unmount();
    await pollTicks(6);
    expect(syncPolls).toBe(2);
  });

  it('stops polling and reports the result when the run finishes', async () => {
    await renderAndRunSync();

    syncRunning = false;
    await pollTicks(1);
    expect(syncPolls).toBe(1);
    expect(toast.addToast.mock.calls.some(c => c[0] === 'success' && c[2] === 'Backup completed')).toBe(true);

    // Terminal answer ⇒ the interval is gone, not merely idle.
    await pollTicks(4);
    expect(syncPolls).toBe(1);
    expect(screen.getByRole('button', { name: /Run Now/i })).toBeTruthy();
  });

  it('does not write state from a poll answer that lands after unmount', async () => {
    const { unmount } = await renderAndRunSync();

    // Hold the poll response open so it resolves only after the page is gone —
    // pre-fix that answer called setBackupSyncRunning/setBackupSync on a dead view.
    holdPoll = true;
    syncRunning = false;
    await pollTicks(1);
    expect(syncPolls).toBe(1);
    expect(releasePoll).not.toBeNull();

    unmount();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      releasePoll!();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The late answer is discarded: no completion toast for a view that is gone,
    // and React never warns about an update on an unmounted component.
    expect(toast.addToast.mock.calls.some(c => c[2] === 'Backup completed')).toBe(false);
    expect(errors.mock.calls.some(c => String(c[0]).includes('unmounted'))).toBe(false);
    errors.mockRestore();
  });
});
