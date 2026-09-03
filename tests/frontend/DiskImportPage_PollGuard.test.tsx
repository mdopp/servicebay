import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #2457 — the disk-import tile polls `/api/system/disk-import/status` every 2 s.
 * Pre-fix, ANY non-2xx answer collapsed to `run = null`, which drops `tileState`
 * back to `'pick'` — so one transient 500 (or a network blip) threw the operator
 * back to the device picker while the worker was still importing, with no error
 * shown at all.
 *
 * Post-fix: only the route's real "no active run" answer (404) clears the tile;
 * every other failure keeps the last-known run on screen behind a soft indicator,
 * and the next good poll clears it.
 *
 * The poll cadence is driven by hand (fake timers + explicit flushes) rather than
 * RTL's `waitFor`, which does not cooperate with faked intervals.
 */

import DiskImportPage from '@/app/(dashboard)/disk-import/page';

const DEVICES = { ok: true, devices: [{ path: '/dev/sdb1', display: 'Kingston 64 GB (/dev/sdb1)' }] };

/** A running scan — the state that must survive a failed poll. */
const SCANNING = {
  ok: true,
  runId: 'run-1',
  running: true,
  status: {
    phase: 'scanning',
    step: 'Walking /mnt/usb',
    mode: 'dry-run',
    scanned: 1234,
    planned: 0,
    applied: 0,
    conflicts: 0,
    error: null,
  },
};

const STALE_NOTE = /showing the last\s+known progress/;

type StatusAnswer = { status: number; body?: unknown } | 'network-error';

/** What the next `/status` poll answers. Reassigned mid-test to inject a failure. */
let statusAnswer: StatusAnswer;
let statusCalls: number;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  statusCalls = 0;
  statusAnswer = { status: 200, body: SCANNING };
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/disk-import/status')) {
      statusCalls += 1;
      if (statusAnswer === 'network-error') throw new TypeError('Failed to fetch');
      return json(statusAnswer.body ?? { ok: false, error: 'boom' }, statusAnswer.status);
    }
    if (url.includes('/disk-import/list-devices')) return json(DEVICES);
    if (url.includes('/disk-import/profiles')) return json({ ok: true, profiles: [] });
    return json({ ok: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Render + let the mount-time poll / device / profile loads land. */
async function renderAndSettle() {
  render(<DiskImportPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // Baseline: the tile shows the live worker run, not the picker.
  expect(screen.getByText('Walking /mnt/usb')).toBeTruthy();
}

/** Drive one 2 s poll tick and flush its async handler. */
async function tick() {
  const before = statusCalls;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(statusCalls).toBeGreaterThan(before);
}

describe('disk-import status poll — transient-failure guard (#2457)', () => {
  it('keeps the in-progress run on screen with a soft indicator when a poll 500s', async () => {
    await renderAndSettle();

    statusAnswer = { status: 500, body: { ok: false, error: 'worker unreachable' } };
    await tick();

    // The run view survives: still the worker-progress step + counts, NOT the picker.
    expect(screen.getByText('Walking /mnt/usb')).toBeTruthy();
    expect(screen.getByText('1234')).toBeTruthy();
    expect(screen.queryByText(/Kingston 64 GB/)).toBeNull();
    expect(screen.queryByText(/Scan disk/)).toBeNull();

    // …behind a soft indicator that says the status is stale, not that the run died.
    expect(screen.getByText(STALE_NOTE)).toBeTruthy();
  });

  it('keeps the run when the poll fetch rejects outright', async () => {
    await renderAndSettle();

    statusAnswer = 'network-error';
    await tick();

    expect(screen.getByText('Walking /mnt/usb')).toBeTruthy();
    expect(screen.getByText(STALE_NOTE)).toBeTruthy();
  });

  it('clears the stale indicator on the next successful poll', async () => {
    await renderAndSettle();

    statusAnswer = { status: 503, body: {} };
    await tick();
    expect(screen.getByText(STALE_NOTE)).toBeTruthy();

    statusAnswer = {
      status: 200,
      body: { ...SCANNING, status: { ...SCANNING.status, step: 'Planning', scanned: 4321 } },
    };
    await tick();

    expect(screen.getByText('Planning')).toBeTruthy();
    expect(screen.queryByText(STALE_NOTE)).toBeNull();
  });

  it('still resets to the device picker on the route 404 that means "no active run"', async () => {
    await renderAndSettle();

    statusAnswer = { status: 404, body: { ok: false, error: 'no active run' } };
    await tick();

    expect(screen.getByText(/Kingston 64 GB/)).toBeTruthy();
    expect(screen.queryByText('Walking /mnt/usb')).toBeNull();
    expect(screen.queryByText(STALE_NOTE)).toBeNull();
  });

  it('stops polling once the page unmounts', async () => {
    const { unmount } = render(<DiskImportPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = statusCalls;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(statusCalls).toBe(afterMount);
  });
});
