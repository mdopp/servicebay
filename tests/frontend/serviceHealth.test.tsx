import { renderHook, render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Check, ServiceViewModel } from '@servicebay/api-client';

// Identity-stable so the summary's own effects don't churn.
const toast = vi.hoisted(() => ({ addToast: vi.fn(), updateToast: vi.fn() }));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));

import { useServiceHealth } from '@/components/serviceDetail/serviceHealth';
import ServiceDetailSummary from '@/components/serviceDetail/ServiceDetailSummary';

/**
 * #2455 — `useServiceHealth` re-runs its load on every service switch, so two
 * `/api/health/checks` fetches can be in flight at once. Both hit the SAME
 * endpoint and return the SAME full list; what differs is the `baseName` each
 * load captured to filter with. That's what made the bug invisible in casual
 * use and lethal under fast switching: the older load's *filter* is what
 * clobbers state, not older data.
 *
 * These tests drive the resolution ORDER by hand (deferred fetch promises) so
 * the out-of-order case is deterministic, not timing-dependent.
 */

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

/** A check attributed to `service` by the structural `target` shape. */
function check(id: string, service: string, status: Check['status'] = 'ok'): Check {
  return {
    id,
    name: `Service: ${service}`,
    type: 'service',
    target: service,
    interval: 60,
    enabled: true,
    created_at: '2026-07-29T00:00:00Z',
    status,
    lastRun: '2026-07-29T00:01:00Z',
    lastResult: status,
    history: [],
  } as Check;
}

/** A box-wide check (node-scoped type) — belongs to no service. */
function boxWideCheck(id: string): Check {
  return {
    id,
    name: 'Agent',
    type: 'agent',
    target: 'Local',
    interval: 60,
    enabled: true,
    created_at: '2026-07-29T00:00:00Z',
    status: 'ok',
    lastRun: '2026-07-29T00:01:00Z',
    lastResult: 'ok',
    history: [],
  } as Check;
}

/** The full list the endpoint returns, regardless of which service asked. */
const ALL_CHECKS: Check[] = [check('alpha', 'alpha'), check('beta', 'beta', 'fail'), boxWideCheck('agent-local')];

describe('useServiceHealth — stale-response guard on rapid service switching (#2455)', () => {
  let pending: Deferred[];

  beforeEach(() => {
    pending = [];
    // Every fetch hands back a promise this test resolves explicitly, so the
    // interleaving is ours to choose.
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Settle one in-flight fetch with a 200 carrying the whole check list. */
  const settle = async (index: number, body: Check[] = ALL_CHECKS) => {
    await act(async () => {
      pending[index].resolve({ ok: true, json: async () => body });
      // Let the hook's `await res.json()` microtask run to completion.
      await Promise.resolve();
    });
  };

  const settleWithError = async (index: number) => {
    await act(async () => {
      pending[index].reject(new Error('network down'));
      await Promise.resolve();
    });
  };

  /** Mount on `alpha`, then switch to `beta` — two loads now in flight. */
  const switchAlphaToBeta = () => {
    const view = renderHook(
      ({ service }) => useServiceHealth(service),
      { initialProps: { service: { id: 'alpha.service', name: 'alpha' } } },
    );
    expect(pending).toHaveLength(1);
    act(() => {
      view.rerender({ service: { id: 'beta.service', name: 'beta' } });
    });
    expect(pending).toHaveLength(2);
    return view;
  };

  it('reproduces the race: the older service load resolving LAST must not overwrite the newer service', async () => {
    const view = switchAlphaToBeta();

    // Out of order on purpose: `beta` (current selection) comes back first,
    // then the superseded `alpha` load lands. Pre-fix, this last write won and
    // the detail view showed alpha's check under beta's header.
    await settle(1);
    await settle(0);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.checks.map(c => c.id)).toEqual(['beta']);
    // beta's check fails; alpha's is ok — so the roll-up counts prove which
    // service's health dot is being shown, not just which ids are in the list.
    expect(view.result.current.counts).toMatchObject({ fail: 1, ok: 0 });
  });

  it('commits the newest service when responses arrive in order', async () => {
    const view = switchAlphaToBeta();

    await settle(0); // stale alpha lands first (the benign ordering)
    await settle(1); // then the current beta

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.checks.map(c => c.id)).toEqual(['beta']);
  });

  it('keeps the spinner up when only the superseded load has landed', async () => {
    const view = switchAlphaToBeta();

    await settle(0); // superseded alpha resolves; beta still in flight

    // A stale response must not clear `loading` — that would flash an empty
    // "loaded, no checks" state for the service still being fetched.
    expect(view.result.current.loading).toBe(true);
    expect(view.result.current.checks).toEqual([]);

    await settle(1);
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.checks.map(c => c.id)).toEqual(['beta']);
  });

  it('a superseded load that FAILS does not disturb the current service', async () => {
    const view = switchAlphaToBeta();

    await settle(1); // beta committed
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await settleWithError(0); // the abandoned alpha load errors out afterwards

    expect(view.result.current.checks.map(c => c.id)).toEqual(['beta']);
    expect(view.result.current.loading).toBe(false);
  });

  it('a manual reload() supersedes the load already in flight', async () => {
    const view = renderHook(() => useServiceHealth({ id: 'beta.service', name: 'beta' }));
    expect(pending).toHaveLength(1);

    // Operator hits refresh while the mount load is still open.
    act(() => { void view.result.current.reload(); });
    expect(pending).toHaveLength(2);

    // The refresh returns a list where beta has recovered; the older mount
    // load then returns the pre-recovery list. The newer answer must stand.
    await settle(1, [check('beta', 'beta', 'ok')]);
    await settle(0, [check('beta', 'beta', 'fail')]);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.counts).toMatchObject({ ok: 1, fail: 0 });
  });

  it('still loads the happy path: own checks and box-wide checks are split', async () => {
    const view = renderHook(() => useServiceHealth({ id: 'alpha.service', name: 'alpha' }));

    await settle(0);

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.checks.map(c => c.id)).toEqual(['alpha']);
    expect(view.result.current.boxWideChecks.map(c => c.id)).toEqual(['agent-local']);
    expect(view.result.current.counts).toMatchObject({ ok: 1, fail: 0 });
  });

  // The acceptance criterion is about what the operator SEES, so assert the
  // rendered summary — the status word next to the service name, the
  // StatusDot's accessible label, and the roll-up's check row — not just hook
  // state. `alpha` is healthy, `beta` is failing, so a stale write is visible
  // as the wrong word under the wrong service name.
  describe('ServiceDetailSummary — the rendered health dot follows the current service', () => {
    const service = (name: string): ServiceViewModel => ({
      name: `${name}.service`,
      id: `${name}.service`,
      displayName: name,
      yamlBasename: null,
      kubeBasename: null,
      active: true,
      type: 'kube',
      ports: [],
    } as ServiceViewModel);

    it('shows the newer service’s status after the older service’s load lands last', async () => {
      const view = render(<ServiceDetailSummary service={service('alpha')} showOperateLink={false} />);
      expect(pending).toHaveLength(1);

      act(() => { view.rerender(<ServiceDetailSummary service={service('beta')} showOperateLink={false} />); });
      expect(pending).toHaveLength(2);

      await settle(1); // beta — the service now on screen
      await settle(0); // alpha — superseded, arrives last

      await waitFor(() => expect(screen.getByText('beta')).toBeTruthy());
      // The dot itself: its colour state and its screen-reader label.
      const dot = screen.getAllByRole('status')[0];
      expect(dot.getAttribute('data-state')).toBe('fail');
      expect(dot.textContent).toContain('Service status: Failing');
      // The visible status word beside the service name.
      expect(screen.getByText('Failing')).toBeTruthy();
      expect(screen.queryByText('Healthy')).toBeNull();
      expect(screen.getByText('1 failing')).toBeTruthy();
      // The roll-up must list beta's check, never alpha's.
      expect(screen.getByText('Service: beta')).toBeTruthy();
      expect(screen.queryByText('Service: alpha')).toBeNull();
    });
  });
});
