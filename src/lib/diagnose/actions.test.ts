import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerProbeAction,
  actionsForProbe,
  dispatchProbeAction,
  _resetRegistryForTesting,
} from './actions';

beforeEach(() => {
  _resetRegistryForTesting();
});

describe('probe-action registry', () => {
  it('registers and lists actions per probe', () => {
    registerProbeAction(
      'p1',
      { id: 'a1', label: 'A1', description: 'desc' },
      async () => ({ ok: true, message: 'done' }),
    );
    registerProbeAction(
      'p1',
      { id: 'a2', label: 'A2', description: 'desc 2', destructive: true },
      async () => ({ ok: true, message: 'done 2' }),
    );
    registerProbeAction(
      'p2',
      { id: 'a1', label: 'P2-A1', description: '' },
      async () => ({ ok: true, message: '' }),
    );

    const p1 = actionsForProbe('p1');
    expect(p1.map(a => a.id).sort()).toEqual(['a1', 'a2']);
    expect(p1.find(a => a.id === 'a2')?.destructive).toBe(true);

    expect(actionsForProbe('p2').map(a => a.id)).toEqual(['a1']);
    expect(actionsForProbe('nonexistent')).toEqual([]);
  });

  it('rejects duplicate registrations', () => {
    registerProbeAction('p1', { id: 'a1', label: 'A', description: 'd' }, async () => ({ ok: true, message: '' }));
    expect(() =>
      registerProbeAction('p1', { id: 'a1', label: 'A', description: 'd' }, async () => ({ ok: true, message: '' })),
    ).toThrow(/already registered/);
  });
});

describe('dispatchProbeAction', () => {
  it('routes to the registered handler with node + payload', async () => {
    const handler = vi.fn(async () => ({ ok: true, message: 'fixed' }));
    registerProbeAction('p1', { id: 'a1', label: 'A', description: 'd' }, handler);

    const result = await dispatchProbeAction({
      probeId: 'p1',
      actionId: 'a1',
      node: 'Local',
      payload: { foo: 'bar' },
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('fixed');
    expect(result.refresh).toBe(true); // default
    expect(handler).toHaveBeenCalledWith({ node: 'Local', payload: { foo: 'bar' } });
  });

  it('returns ok=false for unknown probe/action pair', async () => {
    const result = await dispatchProbeAction({
      probeId: 'no-such-probe',
      actionId: 'no-such-action',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unknown probe action/);
    expect(result.refresh).toBe(false);
  });

  it('catches handler exceptions and returns ok=false', async () => {
    registerProbeAction('p1', { id: 'a1', label: 'A', description: 'd' }, async () => {
      throw new Error('boom');
    });
    const result = await dispatchProbeAction({ probeId: 'p1', actionId: 'a1', node: 'Local' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/boom/);
    expect(result.refresh).toBe(false);
  });

  it('honors handler-supplied refresh=false', async () => {
    registerProbeAction('p1', { id: 'a1', label: 'A', description: 'd' }, async () => ({
      ok: true,
      message: 'partial',
      refresh: false,
    }));
    const result = await dispatchProbeAction({ probeId: 'p1', actionId: 'a1', node: 'Local' });
    expect(result.ok).toBe(true);
    expect(result.refresh).toBe(false);
  });
});
