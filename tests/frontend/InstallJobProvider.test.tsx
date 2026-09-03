import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_POLL_MS, InstallJobProvider } from '@/providers/InstallJobProvider';
import { useInstallJob } from '@/hooks/useInstallJob';
import { useInstallMonitor } from '@/hooks/useInstallMonitor';

/**
 * #2732 — one poll for the whole dashboard.
 *
 * Five surfaces used to poll the install job on their own, at three
 * cadences, with the `/status → /progress` 401 fallback in only some of
 * them. These tests pin the two promises the provider makes: exactly one
 * request per tick no matter how many consumers read it, and exactly one
 * fallback path that keeps the job moving when the operator's cookie
 * stops being trusted mid-install (#663 — S1).
 */

type Call = { url: string; status?: number; body?: unknown };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const runningJob = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  source: 'wizard',
  phase: 'running',
  startedAt: '2026-09-02T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:01.000Z',
  progress: { currentItem: 'immich', deployedNames: [], totalCount: 2 },
  input: { items: [{ name: 'immich', checked: true }, { name: 'nginx', checked: true }], variables: [], templateSource: 'Built-in', host: 'box' },
  credentialsManifest: [{ service: 'immich', username: 'admin', password: 'x', url: '' }],
  ...over,
});

function Badge() {
  const { jobIsActive, stackSetupPending } = useInstallJob();
  return <span data-testid="badge">{jobIsActive || stackSetupPending ? 'active' : 'idle'}</span>;
}

function Card() {
  const { state } = useInstallMonitor();
  return <span data-testid="card">{state ? `${state.percent}%` : 'none'}</span>;
}

function Log() {
  const { logs, phase } = useInstallJob();
  return <pre data-testid="log">{phase}:{logs.join('|')}</pre>;
}

describe('InstallJobProvider (#2732)', () => {
  let calls: Call[];
  let respond: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse({ job: null, jobIsActive: false, stackSetupPending: false, serverStartedAt: '2026-09-02T09:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      calls.push({ url });
      return respond(url);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const statusCalls = () => calls.filter(c => c.url.startsWith('/api/install/status'));
  const progressCalls = () => calls.filter(c => c.url.startsWith('/api/install/progress'));

  describe('one cadence', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it('makes exactly one /status request per tick for every consumer under it', async () => {
      render(
        <InstallJobProvider>
          <Badge /><Card /><Log />
        </InstallJobProvider>,
      );
      // First poll fires on mount, once — not once per consumer.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(statusCalls()).toHaveLength(1);
      expect(calls).toHaveLength(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS - 1); });
      expect(calls).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(calls).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 3); });
      expect(calls).toHaveLength(5);
      // Every request went to the one endpoint; nothing polled /current or
      // /progress on its own.
      expect(calls.every(c => c.url.startsWith('/api/install/status'))).toBe(true);
      expect(screen.getByTestId('badge').textContent).toBe('idle');
      expect(screen.getByTestId('card').textContent).toBe('none');
    });

    it('does not tick faster while a job is running — the cadence is one constant', async () => {
      respond = () => jsonResponse({ job: runningJob(), jobIsActive: true, logs: 'Installing immich...\n', logsOffset: 21 });
      render(<InstallJobProvider><Badge /><Card /><Log /></InstallJobProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('badge').textContent).toBe('active');
      expect(screen.getByTestId('card').textContent).toBe('0%');
      expect(screen.getByTestId('log').textContent).toBe('installing:Installing immich...');

      await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 2); });
      expect(calls).toHaveLength(3);
      // Once the job is known and active, the poll pins it and asks for the
      // log tail from where it left off — not the whole file again.
      expect(calls[1].url).toBe(`/api/install/status?logsSince=21&jobId=job-1`);
    });

    it('never overlaps ticks: a slow response is awaited before the next request', async () => {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      respond = async () => { await gate; return jsonResponse({ job: null, jobIsActive: false }); };
      render(<InstallJobProvider><Badge /></InstallJobProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS * 4); });
      expect(calls).toHaveLength(1);
      release();
      await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS); });
      expect(calls).toHaveLength(2);
    });
  });

  describe('one 401 fallback (#663 — S1)', () => {
    it('falls back to /progress for the tracked job and keeps the full snapshot underneath', async () => {
      let cookieTrusted = true;
      respond = (url) => {
        if (url.startsWith('/api/install/status')) {
          if (!cookieTrusted) return jsonResponse({ error: 'unauthorized' }, 401);
          return jsonResponse({ job: runningJob(), jobIsActive: true, logs: 'one\n', logsOffset: 4 });
        }
        // The sanitised endpoint: boolean needsCredentials, no input, no manifest.
        return jsonResponse({
          job: { id: 'job-1', phase: 'needs_credentials', progress: { currentItem: 'nginx', deployedNames: ['immich'], totalCount: 2 }, needsCredentials: true },
          jobIsActive: true,
          logs: 'two\n',
          logsOffset: 8,
        });
      };
      const { result } = renderHook(() => useInstallJob(), { wrapper: InstallJobProvider });
      await waitFor(() => expect(result.current.job?.id).toBe('job-1'));
      expect(result.current.logs).toEqual(['one']);

      // AUTH_SECRET rotated mid-install: /status now 401s.
      cookieTrusted = false;
      let found = false;
      await act(async () => { found = await result.current.track('job-1'); });
      expect(found).toBe(true);
      expect(progressCalls().map(c => c.url)).toEqual(['/api/install/progress?jobId=job-1&logsSince=4']);

      const job = result.current.job!;
      expect(job.phase).toBe('needs_credentials');
      expect(job.progress.deployedNames).toEqual(['immich']);
      // What /progress strips is carried over from the last full answer.
      expect(job.input?.items.map(i => i.name)).toEqual(['immich', 'nginx']);
      expect(job.credentialsManifest).toHaveLength(1);
      // And the boolean becomes the prompt shape every consumer reads.
      expect(result.current.credentials.prompt).toBe(true);
      expect(result.current.logs).toEqual(['one', 'two']);
    });

    it('does not fall back when no job is being followed — /progress needs a jobId', async () => {
      respond = () => jsonResponse({ error: 'unauthorized' }, 401);
      const { result } = renderHook(() => useInstallJob(), { wrapper: InstallJobProvider });
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(statusCalls()).toHaveLength(1);
      expect(progressCalls()).toHaveLength(0);
      expect(result.current.job).toBeNull();
    });
  });

  describe('log continuity', () => {
    it('starts the log over when the server answers with a different job', async () => {
      let served = 'job-1';
      respond = (url) => {
        const since = Number(new URL(url, 'http://x').searchParams.get('logsSince'));
        if (served === 'job-1') return jsonResponse({ job: runningJob(), jobIsActive: true, logs: since === 0 ? 'a\nb\n' : '', logsOffset: 4 });
        return jsonResponse({ job: runningJob({ id: 'job-2' }), jobIsActive: true, logs: since === 0 ? 'fresh\n' : 'TAIL-FROM-WRONG-OFFSET\n', logsOffset: 6 });
      };
      const { result } = renderHook(() => useInstallJob(), { wrapper: InstallJobProvider });
      await waitFor(() => expect(result.current.logs).toEqual(['a', 'b']));

      served = 'job-2';
      await act(async () => { await result.current.track('job-2'); });
      // track() reset the offset, so the new job's log came from 0.
      expect(result.current.job?.id).toBe('job-2');
      expect(result.current.logs).toEqual(['fresh']);
    });

    it('answers the credentials prompt once per poll: submit hides it, the next snapshot decides again', async () => {
      respond = (url) => {
        if (url.startsWith('/api/install/credentials')) return jsonResponse({ ok: true });
        return jsonResponse({
          job: runningJob({ phase: 'needs_credentials', needsCredentials: { fallback: { email: 'a@b.c', password: 'pw' } } }),
          jobIsActive: true,
        });
      };
      const { result } = renderHook(() => useInstallJob(), { wrapper: InstallJobProvider });
      await waitFor(() => expect(result.current.credentials.prompt).toBe(true));
      expect(result.current.credentials.fallback).toEqual({ email: 'a@b.c', password: 'pw' });

      await act(async () => { await result.current.submitCredentials('a@b.c', 'pw'); });
      expect(result.current.credentials.prompt).toBe(false);
      expect(calls.some(c => c.url === '/api/install/credentials')).toBe(true);

      // The runner is still waiting after the next poll → the prompt is back.
      await act(async () => { await result.current.track('job-1'); });
      expect(result.current.credentials.prompt).toBe(true);
    });
  });
});
