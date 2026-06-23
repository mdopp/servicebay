import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageUpdates, type ServiceImageUpdate } from './useImageUpdates';

const upd = (service: string, updateAvailable: boolean): ServiceImageUpdate => ({
  service,
  image: `ghcr.io/${service}:latest`,
  runningDigest: updateAvailable ? 'sha256:old' : 'sha256:same',
  registryDigest: updateAvailable ? 'sha256:new' : 'sha256:same',
  updateAvailable,
});

function respond(services: ServiceImageUpdate[]): Response {
  return new Response(JSON.stringify({ services }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

/** Mount the hook and flush the on-mount fetch (microtasks). */
async function mount() {
  const hook = renderHook(() => useImageUpdates());
  // Flush the effect's async fetch + state updates.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return hook;
}

describe('useImageUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exposes pending updates from the on-mount fetch', async () => {
    fetchMock.mockResolvedValue(respond([upd('ollama', true), upd('immich', false)]));
    const { result } = await mount();

    expect(result.current.loaded).toBe(true);
    expect(result.current.available.map(u => u.service)).toEqual(['ollama']);
    expect([...result.current.availableServices]).toEqual(['ollama']);
  });

  it('verifyAfterUpdate hides the banner once a later re-poll reports the report clean (registry lag, #2106)', async () => {
    // Mount with one pending update, then the action runs. The immediate refresh
    // STILL reports it (registry lags the restart); only the delayed re-poll
    // sees it cleared. The banner must end empty without a reload.
    fetchMock
      .mockResolvedValueOnce(respond([upd('ollama', true)])) // on-mount
      .mockResolvedValueOnce(respond([upd('ollama', true)])) // immediate refresh — still stale
      .mockResolvedValue(respond([])); // delayed re-poll — now clean

    const { result } = await mount();
    expect(result.current.available).toHaveLength(1);

    let done: Promise<void>;
    await act(async () => {
      done = result.current.verifyAfterUpdate();
      await vi.runAllTimersAsync();
      await done;
    });

    expect(result.current.available).toHaveLength(0);
    // on-mount + immediate + at least one delayed re-poll.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('verifyAfterUpdate stops early once the report is clean (no spinning)', async () => {
    fetchMock
      .mockResolvedValueOnce(respond([upd('ollama', true)])) // on-mount
      .mockResolvedValue(respond([])); // immediate refresh is already clean

    const { result } = await mount();

    let done: Promise<void>;
    await act(async () => {
      done = result.current.verifyAfterUpdate();
      await vi.runAllTimersAsync();
      await done;
    });

    expect(result.current.available).toHaveLength(0);
    // on-mount + exactly one (immediate) refresh — no further delayed re-polls.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('verifyAfterUpdate keeps the banner when the update did not take (report stays)', async () => {
    // The update genuinely failed/didn't propagate: every poll still reports it.
    // The banner must STAY (feedback_dont_mask_failures) — never hide on a
    // persistent report.
    fetchMock.mockResolvedValue(respond([upd('ollama', true)]));

    const { result } = await mount();

    let done: Promise<void>;
    await act(async () => {
      done = result.current.verifyAfterUpdate();
      await vi.runAllTimersAsync();
      await done;
    });

    expect(result.current.available).toHaveLength(1);
  });

  it('refresh leaves existing state intact on a failed fetch (never falsely clears)', async () => {
    fetchMock
      .mockResolvedValueOnce(respond([upd('ollama', true)])) // on-mount: populate
      .mockResolvedValueOnce(new Response('boom', { status: 500 })); // refresh fails

    const { result } = await mount();
    expect(result.current.available).toHaveLength(1);

    let count: number | null = 0;
    await act(async () => { count = await result.current.refresh(); });

    expect(count).toBeNull();
    expect(result.current.available).toHaveLength(1); // unchanged, not wiped
  });
});
