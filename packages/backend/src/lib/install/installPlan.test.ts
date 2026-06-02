import { describe, it, expect } from 'vitest';
import { computeInstallPlan, type PlanStack } from './installPlan';

const stack = (name: string, over: Partial<PlanStack> = {}): PlanStack => ({
  name,
  installed: false,
  templates: [name],
  atomicWipe: false,
  known: true,
  ...over,
});

describe('computeInstallPlan', () => {
  it('installs desired stacks that are not installed (expanding templates)', () => {
    const catalog = [stack('media', { templates: ['audiobookshelf', 'jellyfin'] })];
    const plan = computeInstallPlan(catalog, ['media']);
    expect(plan.install).toEqual([{ stack: 'media', templates: ['audiobookshelf', 'jellyfin'] }]);
    expect(plan.templatesToDeploy).toEqual(['audiobookshelf', 'jellyfin']);
    expect(plan.uninstall).toEqual([]);
    expect(plan.noop).toBe(false);
  });

  it('treats desired+installed as a no-op unless reinstall is requested', () => {
    const catalog = [stack('media', { installed: true })];
    expect(computeInstallPlan(catalog, ['media']).noop).toBe(true);

    const re = computeInstallPlan(catalog, ['media'], ['media']);
    expect(re.reinstall).toEqual([{ stack: 'media', templates: ['media'] }]);
    expect(re.templatesToDeploy).toEqual(['media']);
    expect(re.noop).toBe(false);
  });

  it('uninstalls installed stacks no longer desired (wipeable only)', () => {
    const catalog = [stack('media', { installed: true })];
    const plan = computeInstallPlan(catalog, []); // media installed but undesired
    expect(plan.uninstall).toEqual([{ stack: 'media' }]);
    expect(plan.blocked).toEqual([]);
  });

  it('blocks uninstall of an atomic-wipe (core) stack — Factory Reset only', () => {
    const catalog = [stack('basic', { installed: true, atomicWipe: true })];
    const plan = computeInstallPlan(catalog, []); // core installed, undesired
    expect(plan.uninstall).toEqual([]);
    expect(plan.blocked).toEqual([{ stack: 'basic', reason: 'core stack — uninstall via Factory Reset, not here' }]);
  });

  it('blocks a desired stack that is not in the catalog', () => {
    const plan = computeInstallPlan([], ['ghost']);
    expect(plan.blocked).toEqual([{ stack: 'ghost', reason: 'unknown stack (not in the catalog)' }]);
    expect(plan.install).toEqual([]);
  });

  it('de-duplicates shared templates across install + reinstall', () => {
    const catalog = [
      stack('a', { templates: ['nginx', 'svc-a'] }),
      stack('b', { installed: true, templates: ['nginx', 'svc-b'] }),
    ];
    const plan = computeInstallPlan(catalog, ['a', 'b'], ['b']);
    expect(plan.templatesToDeploy).toEqual(['nginx', 'svc-a', 'svc-b']); // nginx once, catalog order
  });

  it('handles a mixed desired-state edit (install one, uninstall another, keep a third)', () => {
    const catalog = [
      stack('keep', { installed: true }),
      stack('add'),
      stack('drop', { installed: true }),
    ];
    const plan = computeInstallPlan(catalog, ['keep', 'add']);
    expect(plan.install.map(i => i.stack)).toEqual(['add']);
    expect(plan.uninstall).toEqual([{ stack: 'drop' }]);
    expect(plan.reinstall).toEqual([]);
    expect(plan.noop).toBe(false);
  });

  it('is a no-op when desired exactly matches what is installed', () => {
    const catalog = [stack('a', { installed: true }), stack('b', { installed: false })];
    expect(computeInstallPlan(catalog, ['a']).noop).toBe(true);
  });
});
