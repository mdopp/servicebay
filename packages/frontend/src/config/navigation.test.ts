import { describe, it, expect } from 'vitest';
import { isNavActive, NAVIGATION_ENTRIES } from './navigation';

describe('isNavActive', () => {
  it('marks the root path active ONLY on the exact root path', () => {
    expect(isNavActive('/', '/')).toBe(true);
    // startsWith('/') would match every page, so the root must compare exactly.
    expect(isNavActive('/services', '/')).toBe(false);
    expect(isNavActive('/settings', '/')).toBe(false);
  });

  it('marks a section active on its own path and sub-paths', () => {
    expect(isNavActive('/services', '/services')).toBe(true);
    expect(isNavActive('/services/immich', '/services')).toBe(true);
    expect(isNavActive('/status', '/status')).toBe(true);
    expect(isNavActive('/status?tab=containers', '/status')).toBe(false); // query is on pathname, not here
  });

  it('does not match a different section sharing a prefix', () => {
    expect(isNavActive('/servicesX', '/services')).toBe(false);
    expect(isNavActive('/status', '/services')).toBe(false);
  });
});

describe('top nav — Home + the four nouns + Network Map (IA slice 2, #2030/#1950)', () => {
  // Spec §3/§4.1/§8: the four nouns (Services · Status · Settings · Backup) plus
  // Network Map, kept top-level by operator preference. Home is restored by
  // operator request as a lean, status-led landing (spec §4.3 spirit).
  // Diagnostics and SSH Terminal stay off the top nav.
  const ids = NAVIGATION_ENTRIES.map(e => e.id);

  it('is exactly Home · Services · Status · Settings · Backup · Network Map', () => {
    expect(ids).toEqual(['home', 'services', 'status', 'settings', 'backup', 'network']);
  });

  it('Home is the first entry and renders at /', () => {
    expect(ids[0]).toBe('home');
    const home = NAVIGATION_ENTRIES.find(e => e.id === 'home');
    expect(home?.path).toBe('/');
  });

  it('drops Diagnostics and SSH Terminal from the top nav', () => {
    expect(ids).not.toContain('health');
    expect(ids).not.toContain('terminal');
  });

  it('Services links to /services (the list of every app)', () => {
    const services = NAVIGATION_ENTRIES.find(e => e.id === 'services');
    expect(services?.path).toBe('/services');
  });

  it('Status links to /status (the single box-wide health screen)', () => {
    const status = NAVIGATION_ENTRIES.find(e => e.id === 'status');
    expect(status?.path).toBe('/status');
    expect(status?.name).toBe('Status');
  });

  it('keeps Network Map top-level (operator preference)', () => {
    const network = NAVIGATION_ENTRIES.find(e => e.id === 'network');
    expect(network, 'Network Map must stay a top-level nav entry').toBeDefined();
    expect(network?.path).toBe('/network');
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

  it('keeps Status off the bottom bar (surfaced in the mobile top-bar icon row)', () => {
    const status = NAVIGATION_ENTRIES.find(e => e.id === 'status');
    expect(status?.hiddenOnMobileBottom).toBe(true);
  });

  it('every entry is reachable on mobile (bottom bar OR top-bar icon row)', () => {
    const bottom = NAVIGATION_ENTRIES.filter(e => !e.hiddenOnMobileBottom);
    const top = NAVIGATION_ENTRIES.filter(e => e.hiddenOnMobileBottom);
    expect(bottom.length + top.length).toBe(NAVIGATION_ENTRIES.length);
    // Bottom bar must stay small enough that a phone row doesn't overflow.
    expect(bottom.length).toBeLessThanOrEqual(5);
  });
});
