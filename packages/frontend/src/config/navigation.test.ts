import { describe, it, expect } from 'vitest';
import { isNavActive, NAVIGATION_ENTRIES } from './navigation';

describe('isNavActive', () => {
  it('marks Home (root) active ONLY on the exact root path', () => {
    expect(isNavActive('/', '/')).toBe(true);
    // The bug: startsWith('/') matched every page, so Home stayed highlighted
    // alongside the real section.
    expect(isNavActive('/services', '/')).toBe(false);
    expect(isNavActive('/settings', '/')).toBe(false);
  });

  it('marks a section active on its own path and sub-paths', () => {
    expect(isNavActive('/services', '/services')).toBe(true);
    expect(isNavActive('/services/immich', '/services')).toBe(true);
  });

  it('does not match a different section sharing a prefix', () => {
    expect(isNavActive('/servicesX', '/services')).toBe(false);
    expect(isNavActive('/health', '/services')).toBe(false);
  });
});

describe('mobile reachability (#1992)', () => {
  // MobileNav renders the bottom bar from entries WITHOUT hiddenOnMobileBottom
  // and the top-bar icon row from entries WITH it. Every entry must land in
  // exactly one of those buckets, so nothing is unreachable on a phone.
  it('keeps Backup top-level but off the bottom bar (surfaced in the top bar)', () => {
    const backup = NAVIGATION_ENTRIES.find(e => e.id === 'backup');
    expect(backup, 'Backup must stay a top-level nav entry (operator preference)').toBeDefined();
    expect(backup?.hiddenOnMobileBottom).toBe(true);
  });

  it('has a Status entry linking to /status, kept off the bottom bar (#2030)', () => {
    const status = NAVIGATION_ENTRIES.find(e => e.id === 'status');
    expect(status, 'Status must be a top-level nav entry (IA slice 2)').toBeDefined();
    expect(status?.path).toBe('/status');
    expect(status?.name).toBe('Status');
    // Bottom bar already holds 5 (home/services/network/health/terminal); Status
    // surfaces in the mobile top-bar icon row instead, like Settings/Backup.
    expect(status?.hiddenOnMobileBottom).toBe(true);
  });

  it('every entry is reachable on mobile (bottom bar OR top-bar icon row)', () => {
    const bottom = NAVIGATION_ENTRIES.filter(e => !e.hiddenOnMobileBottom);
    const top = NAVIGATION_ENTRIES.filter(e => e.hiddenOnMobileBottom);
    expect(bottom.length + top.length).toBe(NAVIGATION_ENTRIES.length);
    // Bottom bar must stay small enough that a phone row doesn't overflow into
    // a crush; the scroll fallback exists, but the default set should fit.
    expect(bottom.length).toBeLessThanOrEqual(5);
  });
});
