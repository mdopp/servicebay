import { describe, it, expect } from 'vitest';
import { isNavActive } from './navigation';

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
