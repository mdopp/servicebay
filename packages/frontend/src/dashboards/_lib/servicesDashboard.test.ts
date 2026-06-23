import { describe, it, expect } from 'vitest';
import type { ServiceViewModel, StackManifest } from '@servicebay/api-client';

import {
  groupServicesByStack,
  groupContainersByStack,
  baseUnitName,
  isCoreInfraService,
  UNGROUPED_STACK_ID,
  CORE_STACK_ID,
  OTHER_CONTAINERS_ID,
  type StackSummaryLite,
} from './servicesDashboard';

function svc(name: string, over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return { id: name, name, displayName: name, ...over } as ServiceViewModel;
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
      [svc('jellyfin'), svc('immich.service')],
      [
        ...stacks,
        { name: 'media', manifest: manifest({ name: 'media', label: 'Media', templates: ['jellyfin'] }) },
      ],
    );
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    expect(byId.media.services.map(s => s.name)).toEqual(['jellyfin']);
    expect(byId.immich.services.map(s => s.name)).toEqual(['immich.service']);
  });

  it('folds core (atomic-wipe) stack services into the Core services group', () => {
    const groups = groupServicesByStack(
      [svc('nginx.service'), svc('auth'), svc('immich.service')],
      stacks,
    );
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    expect(byId.basic).toBeUndefined();
    expect(byId[CORE_STACK_ID].label).toBe('Core services');
    expect(byId[CORE_STACK_ID].services.map(s => s.name)).toEqual(['nginx.service', 'auth']);
    expect(byId[CORE_STACK_ID].wipeable).toBe(false);
  });

  it('groups the gateway / reverse proxy / system service under Core services, sorted first', () => {
    const groups = groupServicesByStack(
      [
        svc('immich.service'),
        svc('Internet Gateway', { type: 'gateway' }),
        svc('nginx', { labels: { 'servicebay.role': 'reverse-proxy' } }),
        svc('servicebay', { labels: { 'servicebay.role': 'system' } }),
      ],
      stacks,
    );
    expect(groups[0].id).toBe(CORE_STACK_ID);
    expect(groups[0].label).toBe('Core services');
    expect(groups[0].services.map(s => s.name)).toEqual([
      'Internet Gateway',
      'nginx',
      'servicebay',
    ]);
    // No Ungrouped bucket for the infra services.
    expect(groups.some(g => g.id === UNGROUPED_STACK_ID)).toBe(false);
  });

  it('detects core infra services from type / servicebay.role', () => {
    expect(isCoreInfraService(svc('gw', { type: 'gateway' }))).toBe(true);
    expect(isCoreInfraService(svc('nginx', { labels: { 'servicebay.role': 'reverse-proxy' } }))).toBe(true);
    expect(isCoreInfraService(svc('sb', { labels: { 'servicebay.role': 'system' } }))).toBe(true);
    expect(isCoreInfraService(svc('immich.service'))).toBe(false);
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
    // basic's services fold into the never-wipeable Core group.
    expect(groups.find(g => g.id === CORE_STACK_ID)?.wipeable).toBe(false);
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

describe('groupContainersByStack (#2095)', () => {
  const stacks: StackSummaryLite[] = [
    { name: 'basic', manifest: manifest({ name: 'basic', label: 'Core', tier: 'core', lifecycle: 'atomic-wipe', templates: ['nginx', 'auth'] }) },
    { name: 'immich', manifest: manifest({ name: 'immich', label: 'Photos', templates: ['immich'] }) },
  ];

  type C = { id: string; serviceName?: string | null; isInfra?: boolean };
  const accessor = (c: C) => ({ serviceName: c.serviceName, isInfra: c.isInfra });

  it('mirrors the /services stack grouping — same group ids/labels/membership', () => {
    const groups = groupContainersByStack(
      [
        { id: 'c1', serviceName: 'immich' },
        { id: 'c2', serviceName: 'nginx' },
        { id: 'c3', serviceName: 'auth' },
      ],
      accessor,
      stacks,
    );
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    // nginx/auth belong to the atomic-wipe core stack -> Core services.
    expect(byId[CORE_STACK_ID].label).toBe('Core services');
    expect(byId[CORE_STACK_ID].containers.map(c => c.id)).toEqual(['c2', 'c3']);
    // immich keeps its own labelled stack section, mirroring /services.
    expect(byId.immich.label).toBe('Photos');
    expect(byId.immich.containers.map(c => c.id)).toEqual(['c1']);
  });

  it('routes infra containers to Core, sorted first', () => {
    const groups = groupContainersByStack(
      [{ id: 'photo', serviceName: 'immich' }, { id: 'pause', isInfra: true }],
      accessor,
      stacks,
    );
    expect(groups[0].id).toBe(CORE_STACK_ID);
    expect(groups[0].containers.map(c => c.id)).toEqual(['pause']);
  });

  it('buckets stack-less containers into "Other containers", listed last', () => {
    const groups = groupContainersByStack(
      [{ id: 'immich-c', serviceName: 'immich' }, { id: 'loose' }],
      accessor,
      stacks,
    );
    const last = groups[groups.length - 1];
    expect(last.id).toBe(OTHER_CONTAINERS_ID);
    expect(last.label).toBe('Other containers');
    expect(last.containers.map(c => c.id)).toEqual(['loose']);
  });

  it('keeps a service with no matching stack as its own labelled section', () => {
    const groups = groupContainersByStack(
      [{ id: 'x', serviceName: 'standalone-svc' }],
      accessor,
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('standalone-svc');
    expect(groups[0].containers.map(c => c.id)).toEqual(['x']);
  });
});
