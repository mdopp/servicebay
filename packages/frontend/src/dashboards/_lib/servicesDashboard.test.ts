import { describe, it, expect } from 'vitest';
import type { ServiceViewModel, StackManifest } from '@servicebay/api-client';

import {
  groupServicesByStack,
  baseUnitName,
  UNGROUPED_STACK_ID,
  type StackSummaryLite,
} from './servicesDashboard';

function svc(name: string): ServiceViewModel {
  return { id: name, name, displayName: name } as ServiceViewModel;
}

function manifest(over: Partial<StackManifest>): StackManifest {
  return {
    name: 'x',
    label: 'X',
    tier: 'feature',
    lifecycle: 'wipeable',
    dependsOnStacks: [],
    templates: [],
    ...over,
  };
}

describe('groupServicesByStack (#2081)', () => {
  const stacks: StackSummaryLite[] = [
    { name: 'basic', manifest: manifest({ name: 'basic', label: 'Core', tier: 'core', lifecycle: 'atomic-wipe', templates: ['nginx', 'auth'] }) },
    { name: 'immich', manifest: manifest({ name: 'immich', label: 'Photos', templates: ['immich'] }) },
  ];

  it('groups services under their owning stack, by template membership', () => {
    const groups = groupServicesByStack(
      [svc('nginx.service'), svc('auth'), svc('immich.service')],
      stacks,
    );
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    expect(byId.basic.services.map(s => s.name)).toEqual(['nginx.service', 'auth']);
    expect(byId.immich.services.map(s => s.name)).toEqual(['immich.service']);
  });

  it('matches on base name regardless of the .service suffix', () => {
    expect(baseUnitName('immich.service')).toBe('immich');
    const groups = groupServicesByStack([svc('immich')], stacks);
    expect(groups.find(g => g.id === 'immich')?.services.map(s => s.name)).toEqual(['immich']);
  });

  it('puts services with no owning stack in the ungrouped bucket, listed last', () => {
    const groups = groupServicesByStack([svc('immich.service'), svc('gateway')], stacks);
    expect(groups[groups.length - 1].id).toBe(UNGROUPED_STACK_ID);
    expect(groups[groups.length - 1].services.map(s => s.name)).toEqual(['gateway']);
    expect(groups[groups.length - 1].wipeable).toBe(false);
  });

  it('marks only feature/wipeable stacks wipeable; core + atomic-wipe are blocked', () => {
    const groups = groupServicesByStack([svc('nginx.service'), svc('immich.service')], stacks);
    expect(groups.find(g => g.id === 'basic')?.wipeable).toBe(false);
    expect(groups.find(g => g.id === 'immich')?.wipeable).toBe(true);
  });

  it('omits stacks that have no installed services (no empty headers)', () => {
    const groups = groupServicesByStack([svc('immich.service')], stacks);
    expect(groups.map(g => g.id)).toEqual(['immich']);
    expect(groups.find(g => g.id === 'basic')).toBeUndefined();
  });

  it('uses the manifest label as the group label, falling back to the stack name', () => {
    const noLabel: StackSummaryLite = { name: 'media', manifest: manifest({ name: 'media', label: '', templates: ['jellyfin'] }) };
    const groups = groupServicesByStack([svc('jellyfin')], [noLabel]);
    expect(groups[0].label).toBe('media');
  });
});
