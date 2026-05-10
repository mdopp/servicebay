import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerProbeAction,
  actionsForProbe,
  dispatchProbeAction,
  resolveItemActions,
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
    expect(handler).toHaveBeenCalledWith({ node: 'Local', payload: { foo: 'bar' }, itemId: undefined });
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

describe('inline-form inputs', () => {
  it('rejects dispatch when required inputs are missing', async () => {
    const handler = vi.fn(async () => ({ ok: true, message: 'should not run' }));
    registerProbeAction(
      'p1',
      {
        id: 'a1',
        label: 'A',
        description: 'd',
        inputs: [
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'password', label: 'Password', type: 'password' /* required defaults true */ },
        ],
      },
      handler,
    );
    const result = await dispatchProbeAction({
      probeId: 'p1',
      actionId: 'a1',
      node: 'Local',
      payload: { email: 'a@b.c' /* password missing */ },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Password/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects dispatch when required inputs are empty strings', async () => {
    const handler = vi.fn(async () => ({ ok: true, message: '' }));
    registerProbeAction(
      'p1',
      {
        id: 'a1',
        label: 'A',
        description: 'd',
        inputs: [{ name: 'email', label: 'Email', type: 'email', required: true }],
      },
      handler,
    );
    const result = await dispatchProbeAction({
      probeId: 'p1',
      actionId: 'a1',
      node: 'Local',
      payload: { email: '' },
    });
    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes payload through when all required inputs are present', async () => {
    const handler = vi.fn(async () => ({ ok: true, message: 'saved' }));
    registerProbeAction(
      'p1',
      {
        id: 'a1',
        label: 'A',
        description: 'd',
        inputs: [
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'note', label: 'Note', type: 'text', required: false },
        ],
      },
      handler,
    );
    const result = await dispatchProbeAction({
      probeId: 'p1',
      actionId: 'a1',
      node: 'Local',
      payload: { email: 'a@b.c' /* note optional, omitted */ },
    });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ node: 'Local', payload: { email: 'a@b.c' }, itemId: undefined });
  });

  it('exposes inputs[] via actionsForProbe', () => {
    registerProbeAction(
      'p1',
      {
        id: 'a1',
        label: 'A',
        description: 'd',
        inputs: [{ name: 'email', label: 'Email', type: 'email' }],
      },
      async () => ({ ok: true, message: '' }),
    );
    const [action] = actionsForProbe('p1');
    expect(action.inputs).toHaveLength(1);
    expect(action.inputs?.[0].name).toBe('email');
  });
});

describe('per-item actions', () => {
  it('threads itemId through to the handler', async () => {
    const handler = vi.fn(async () => ({ ok: true, message: 'deleted' }));
    registerProbeAction('p1', { id: 'delete', label: 'Delete', description: 'd' }, handler);
    const result = await dispatchProbeAction({
      probeId: 'p1',
      actionId: 'delete',
      itemId: 'host-42',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ node: 'Local', payload: undefined, itemId: 'host-42' });
  });

  it('resolveItemActions inlines action metadata for each item', () => {
    registerProbeAction(
      'p1',
      { id: 'delete', label: 'Delete', description: 'wipe', destructive: true },
      async () => ({ ok: true, message: '' }),
    );
    registerProbeAction(
      'p1',
      { id: 'renew', label: 'Renew', description: 'extend' },
      async () => ({ ok: true, message: '' }),
    );

    const resolved = resolveItemActions('p1', [
      { id: 'item-1', label: 'first', actionIds: ['delete', 'renew'] },
      { id: 'item-2', label: 'second', actionIds: ['renew'] },
      { id: 'item-3', label: 'third', actionIds: ['nonexistent'] },
    ]);

    expect(resolved[0].actions.map(a => a.id)).toEqual(['delete', 'renew']);
    expect(resolved[0].actions[0].destructive).toBe(true);
    expect(resolved[1].actions.map(a => a.id)).toEqual(['renew']);
    // Unknown action ids drop silently rather than crashing the page.
    expect(resolved[2].actions).toEqual([]);
  });

  it('resolveItemActions preserves item label, detail, status', () => {
    registerProbeAction(
      'p1',
      { id: 'a1', label: 'A', description: '' },
      async () => ({ ok: true, message: '' }),
    );
    const [resolved] = resolveItemActions('p1', [
      { id: 'i1', label: 'L', detail: 'D', status: 'fail', actionIds: ['a1'] },
    ]);
    expect(resolved.label).toBe('L');
    expect(resolved.detail).toBe('D');
    expect(resolved.status).toBe('fail');
  });
});
