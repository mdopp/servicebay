import { describe, it, expect } from 'vitest';

import { SETTINGS_GROUPS, SEARCH_INDEX, searchSettings } from './ia';

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
