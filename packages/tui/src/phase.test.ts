import { describe, it, expect } from 'vitest';
import {
  detectPhase,
  actionsForPhase,
  describePhase,
  type PhaseProbes,
  type PhaseState,
} from './phase';

function probes(over: Partial<{ isoBuilt: boolean; reachable: boolean; wizardDone: boolean }>): PhaseProbes {
  return {
    isoBuilt: async () => over.isoBuilt ?? false,
    boxStatus: async () => ({ reachable: over.reachable ?? false, wizardDone: over.wizardDone ?? false }),
  };
}

describe('detectPhase', () => {
  it('is no-iso when nothing is built and the box is down', async () => {
    expect((await detectPhase(probes({}))).phase).toBe('no-iso');
  });

  it('is iso-ready when an ISO exists but the box is unreachable', async () => {
    const s = await detectPhase(probes({ isoBuilt: true }));
    expect(s.phase).toBe('iso-ready');
    expect(s.isoBuilt).toBe(true);
  });

  it('is installing when the box is reachable but the wizard is not done', async () => {
    const s = await detectPhase(probes({ reachable: true, wizardDone: false }));
    expect(s.phase).toBe('installing');
    expect(s.boxReachable).toBe(true);
  });

  it('is ready when the box is reachable and the wizard is done', async () => {
    const s = await detectPhase(probes({ reachable: true, wizardDone: true }));
    expect(s.phase).toBe('ready');
    expect(s.wizardDone).toBe(true);
  });

  it('a reachable box wins over a stale local ISO', async () => {
    const s = await detectPhase(probes({ isoBuilt: true, reachable: true, wizardDone: true }));
    expect(s.phase).toBe('ready');
  });
});

describe('actionsForPhase', () => {
  const state = (over: Partial<PhaseState>): PhaseState => ({
    phase: 'no-iso',
    isoBuilt: false,
    boxReachable: false,
    wizardDone: false,
    ...over,
  });

  it('no-iso offers Choose-ISO + Build but not Watch (nothing to watch yet)', () => {
    const ids = actionsForPhase(state({ phase: 'no-iso' })).map(a => a.id);
    expect(ids[0]).toBe('choose-iso');
    expect(ids).toContain('build-iso');
    expect(ids).not.toContain('watch-install');
    expect(ids).toContain('quit');
  });

  it('iso-ready offers Choose-ISO + Rebuild + Watch', () => {
    const actions = actionsForPhase(state({ phase: 'iso-ready', isoBuilt: true }));
    const ids = actions.map(a => a.id);
    expect(ids).toContain('choose-iso');
    expect(ids).toContain('build-iso');
    expect(ids).toContain('watch-install');
    expect(actions.find(a => a.id === 'build-iso')!.label).toMatch(/Rebuild/);
  });

  it('does not offer Choose-ISO once the box is reachable', () => {
    const ids = actionsForPhase(state({ phase: 'ready', boxReachable: true, wizardDone: true })).map(a => a.id);
    expect(ids).not.toContain('choose-iso');
  });

  it('installing offers Watch but not Build (box is already up)', () => {
    const ids = actionsForPhase(state({ phase: 'installing', boxReachable: true })).map(a => a.id);
    expect(ids).toEqual(['watch-install', 'refresh', 'quit']);
  });

  it('always ends with refresh + quit', () => {
    for (const phase of ['no-iso', 'iso-ready', 'installing', 'ready'] as const) {
      const ids = actionsForPhase(state({ phase, boxReachable: phase === 'installing' || phase === 'ready', isoBuilt: phase === 'iso-ready' })).map(a => a.id);
      expect(ids.slice(-2)).toEqual(['refresh', 'quit']);
    }
  });
});

describe('describePhase', () => {
  it('returns a distinct sentence per phase', () => {
    const phases = ['no-iso', 'iso-ready', 'installing', 'ready'] as const;
    const lines = phases.map(phase =>
      describePhase({ phase, isoBuilt: false, boxReachable: false, wizardDone: false }),
    );
    expect(new Set(lines).size).toBe(phases.length);
  });
});
