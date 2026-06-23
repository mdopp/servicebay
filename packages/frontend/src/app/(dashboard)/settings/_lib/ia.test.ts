import { describe, it, expect } from 'vitest';

import { SETTINGS_GROUPS, SEARCH_INDEX, DEFAULT_GROUP, searchSettings } from './ia';

describe('settings IA — cross-cutting only, no Services group (spec §4.4 / §8)', () => {
  it('has no Services group — services live on the Services nav + Operate page', () => {
    expect(SETTINGS_GROUPS.find(g => g.id === 'services')).toBeUndefined();
  });

  it('exposes exactly the cross-cutting groups + Maintenance', () => {
    expect(SETTINGS_GROUPS.map(g => g.id)).toEqual([
      'network-domain',
      'access',
      'notifications',
      'system',
      'maintenance',
    ]);
  });

  it('lands on Network & Domain, not Services', () => {
    expect(DEFAULT_GROUP.id).toBe('network-domain');
  });

  it('drops the services search entry', () => {
    expect(searchSettings('immich').some(h => h.group.id === 'services')).toBe(false);
    expect(SEARCH_INDEX.some(h => h.group.id === 'services')).toBe(false);
  });

  it('drops the Stacks & templates entry — stack management moved to /services (#2081)', () => {
    const system = SETTINGS_GROUPS.find(g => g.id === 'system')!;
    expect(system.entries.find(e => e.id === 'stacks')).toBeUndefined();
    expect(SEARCH_INDEX.some(h => h.entry.id === 'stacks')).toBe(false);
    // The old "stack"/"template registry" keyword search no longer lands a hit.
    expect(searchSettings('stack').some(h => h.entry.id === 'stacks')).toBe(false);
  });
});

describe('settings IA — Maintenance launcher (#1958 follow-up)', () => {
  it('has a Maintenance group with the disk-import launcher', () => {
    const group = SETTINGS_GROUPS.find(g => g.id === 'maintenance');
    expect(group).toBeDefined();
    const importEntry = group!.entries.find(e => e.id === 'disk-import');
    expect(importEntry?.launchHref).toBe('/disk-import');
  });

  it('searching "import" jumps straight to the importer route, not a settings anchor', () => {
    const hits = searchSettings('import');
    const importHit = hits.find(h => h.entry.id === 'disk-import');
    expect(importHit).toBeDefined();
    expect(importHit!.href).toBe('/disk-import');
  });

  it('also finds the importer by synonyms (usb, sort, photos)', () => {
    for (const term of ['usb', 'sort', 'photos']) {
      expect(searchSettings(term).some(h => h.entry.id === 'disk-import')).toBe(true);
    }
  });

  it('non-launcher entries still deep-link to their in-page settings anchor', () => {
    const updates = SEARCH_INDEX.find(h => h.entry.id === 'updates');
    expect(updates?.href).toBe('/settings/system#updates');
  });
});

describe('settings IA — Portal access lives under Access & People (#2084)', () => {
  // "Portal access" thematically belongs with who-can-get-in (Access & People),
  // not the internet-reachability concern (Network & Domain).
  it('has the portal-access entry under the access group, not network-domain', () => {
    const access = SETTINGS_GROUPS.find(g => g.id === 'access')!;
    const network = SETTINGS_GROUPS.find(g => g.id === 'network-domain')!;
    expect(access.entries.some(e => e.id === 'portal-access')).toBe(true);
    expect(network.entries.some(e => e.id === 'portal-access')).toBe(false);
  });

  it('keeps the portal-access tier (advanced) and keywords', () => {
    const access = SETTINGS_GROUPS.find(g => g.id === 'access')!;
    const portal = access.entries.find(e => e.id === 'portal-access')!;
    expect(portal.tier).toBe('advanced');
    expect(portal.keywords).toEqual(['portal', 'public page', 'landing']);
  });

  it('deep-links portal-access to the access group anchor', () => {
    const hit = SEARCH_INDEX.find(h => h.entry.id === 'portal-access');
    expect(hit).toBeDefined();
    expect(hit!.group.id).toBe('access');
    expect(hit!.href).toBe('/settings/access#portal-access');
  });

  it('stays findable by name from search', () => {
    const hit = searchSettings('portal').find(h => h.entry.id === 'portal-access');
    expect(hit).toBeDefined();
    expect(hit!.group.id).toBe('access');
  });
});

describe('settings IA — SSH Terminal relocated off the top nav (#2030, IA slice 2)', () => {
  // The console is no longer a top-nav noun; it lives under System as an advanced
  // launch card → /terminal, and must stay findable by name so the capability is
  // never lost (spec §8: "don't mutilate — every knob stays reachable").
  it('has an SSH Terminal launcher under the System group → /terminal', () => {
    const system = SETTINGS_GROUPS.find(g => g.id === 'system');
    expect(system).toBeDefined();
    const terminal = system!.entries.find(e => e.id === 'terminal');
    expect(terminal?.launchHref).toBe('/terminal');
  });

  it('searching "terminal" / "ssh" / "console" jumps straight to /terminal', () => {
    for (const term of ['terminal', 'ssh', 'console', 'shell']) {
      const hit = searchSettings(term).find(h => h.entry.id === 'terminal');
      expect(hit, `"${term}" should find the SSH Terminal launcher`).toBeDefined();
      expect(hit!.href).toBe('/terminal');
    }
  });
});
