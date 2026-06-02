/**
 * useInstallPlan — thin client for the box-side desired-state install
 * plan (#1537). Verifies it forwards the desired/reinstall/node body to
 * POST /api/install/plan, surfaces the resolved plan, and that the
 * uninstall action posts the `WIPE-<stack>` confirmation the wipe
 * endpoint requires.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInstallPlan, type InstallPlan } from './useInstallPlan';

const EMPTY_PLAN: InstallPlan = {
  install: [],
  reinstall: [],
  uninstall: [],
  blocked: [],
  templatesToDeploy: [],
  noop: true,
};

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.restoreAllMocks(); });

describe('useInstallPlan', () => {
  it('POSTs desired/reinstall/node to /api/install/plan and returns the plan', async () => {
    const plan: InstallPlan = {
      ...EMPTY_PLAN,
      noop: false,
      install: [{ stack: 'cloud', templates: ['immich'] }],
      uninstall: [{ stack: 'home' }],
      blocked: [{ stack: 'basic', reason: 'core stack — uninstall via Factory Reset, not here' }],
      templatesToDeploy: ['immich'],
    };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(plan), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useInstallPlan());
    let returned: InstallPlan | null = null;
    await act(async () => {
      returned = await result.current.fetchPlan(['cloud'], ['cloud'], 'Local');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/install/plan', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ desired: ['cloud'], reinstall: ['cloud'], node: 'Local' });
    expect(returned).toEqual(plan);
    await waitFor(() => expect(result.current.plan).toEqual(plan));
  });

  it('surfaces an error and returns null when the plan endpoint fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), {
      status: 500, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useInstallPlan());
    let returned: InstallPlan | null = EMPTY_PLAN;
    await act(async () => {
      returned = await result.current.fetchPlan([]);
    });
    expect(returned).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('boom'));
  });

  it('uninstall posts the WIPE-<stack> confirmation token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, deleted: ['immich'] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useInstallPlan());
    let res: { ok: boolean; error?: string } = { ok: false };
    await act(async () => {
      res = await result.current.uninstall('cloud', 'Local');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/system/stacks/cloud/wipe', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ confirm: 'WIPE-cloud', node: 'Local' });
    expect(res.ok).toBe(true);
  });

  it('uninstall reports the box error (e.g. atomic-wipe refusal)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'Stack `basic` is atomic-wipe — use Settings → System → Factory Reset instead.',
    }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const { result } = renderHook(() => useInstallPlan());
    let res: { ok: boolean; error?: string } = { ok: true };
    await act(async () => {
      res = await result.current.uninstall('basic');
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/atomic-wipe/);
  });

  it('uninstall treats a partial-failure result (ok:false) as a failure', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: false, deleted: [], failed: [{ template: 'immich', error: 'unit busy' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const { result } = renderHook(() => useInstallPlan());
    let res: { ok: boolean; error?: string } = { ok: true };
    await act(async () => {
      res = await result.current.uninstall('cloud');
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('immich: unit busy');
  });
});
