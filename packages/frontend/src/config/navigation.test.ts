import { describe, it, expect } from 'vitest';
import { isNavActive, NAVIGATION_ENTRIES, resolveNavigationEntries } from './navigation';
import type { InternalNavigationEntry } from './navigation';

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

describe('top nav — Home + the four nouns + Network Map + Terminal (IA slice 2, #2030/#1950, #2083)', () => {
  // Spec §3/§4.1/§8: the four nouns (Services · Status · Settings · Backup) plus
  // Network Map, kept top-level by operator preference. Home is restored by
  // operator request as a lean, status-led landing (spec §4.3 spirit).
  // Terminal is back in the sidebar by operator request (#2083): a host shell is
  // a recovery tool and must not be buried in a Settings launch card.
  // Diagnostics stays off the top nav (it lives under Status).
  const ids = NAVIGATION_ENTRIES.map(e => e.id);
  // The schema is a union since #2521 (external entries carry an href, not a
  // route), so a path assertion narrows to the in-app half first.
  const internal = (id: string) =>
    NAVIGATION_ENTRIES.find((e): e is InternalNavigationEntry => e.id === id && !e.external);

  it('is exactly Home · Services · Status · Settings · Backup · Network Map · Terminal', () => {
    // The unconditional in-app destinations. Maintenance Chat is in the schema
    // too but only renders when solilos-chat is installed, and the two
    // app-leaving links are a separate group — neither is a new top-level
    // destination (#2521 moved them out of Sidebar.tsx, it did not add them).
    const alwaysOn = NAVIGATION_ENTRIES
      .filter(e => !e.external && !e.requiresTemplate)
      .map(e => e.id);
    expect(alwaysOn).toEqual(['home', 'services', 'status', 'settings', 'backup', 'network', 'terminal']);
  });

  it('Home is the first entry and renders at /', () => {
    expect(ids[0]).toBe('home');
    const home = internal('home');
    expect(home?.path).toBe('/');
  });

  it('drops Diagnostics from the top nav', () => {
    expect(ids).not.toContain('health');
  });

  it('keeps Terminal in the sidebar as a recovery tool (#2083) → /terminal', () => {
    const terminal = internal('terminal');
    expect(terminal, 'Terminal must be a top-level nav entry (recovery tool, not buried)').toBeDefined();
    expect(terminal?.path).toBe('/terminal');
    expect(terminal?.name).toBe('Terminal');
    // Expert/recovery tool — off the phone bottom bar, surfaced in the mobile top-bar row.
    expect(terminal?.hiddenOnMobileBottom).toBe(true);
  });

  it('Services links to /services (the list of every app)', () => {
    const services = internal('services');
    expect(services?.path).toBe('/services');
  });

  it('Status links to /status (the single box-wide health screen)', () => {
    const status = internal('status');
    expect(status?.path).toBe('/status');
    expect(status?.name).toBe('Status');
  });

  it('keeps Network Map top-level (operator preference)', () => {
    const network = internal('network');
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

describe('conditional + external schema entries (#2521)', () => {
  // These three used to be inline JSX in Sidebar.tsx, which is exactly the
  // drift docs/UX_DECISIONS.md forbids ("Sidebar.tsx / MobileNav.tsx map over
  // the schema; no inline entries") and the reason mobile showed a different
  // set of destinations than desktop.
  const byId = (id: string) => NAVIGATION_ENTRIES.find(e => e.id === id);

  it('Maintenance Chat is a schema entry gated on the solilos-chat template', () => {
    const chat = byId('chat');
    expect(chat, 'Maintenance Chat must live in the schema, not inline in Sidebar.tsx').toBeDefined();
    expect(chat?.requiresTemplate).toBe('solilos-chat');
    expect(chat?.external).toBeUndefined();
    expect(chat && !chat.external && chat.path).toBe('/chat');
  });

  it('Users & Groups is external with a runtime href source (LLDAP)', () => {
    const users = byId('users');
    expect(users?.external).toBe(true);
    expect(users && users.external && users.hrefSource).toBe('lldap');
    // No static href — the URL only exists once LLDAP is deployed.
    expect(users && users.external && users.href).toBeUndefined();
  });

  it('View as user is external with a static href to the family portal', () => {
    const portal = byId('portal');
    expect(portal?.external).toBe(true);
    expect(portal && portal.external && portal.href).toBe('/portal');
  });

  it('every app-leaving entry stays off the phone bottom bar', () => {
    for (const entry of NAVIGATION_ENTRIES.filter(e => e.external)) {
      expect(entry.hiddenOnMobileBottom, `${entry.id} must not sit in the bottom bar`).toBe(true);
    }
  });

  it('external entries are the ONLY app-leaving ones (no new destinations)', () => {
    expect(NAVIGATION_ENTRIES.filter(e => e.external).map(e => e.id)).toEqual(['users', 'portal']);
  });
});

describe('resolveNavigationEntries — the one list both nav components render (#2521)', () => {
  const full = { installedTemplates: ['solilos-chat'], lldapUrl: 'https://ldap.example.com', node: null };

  it('hides Maintenance Chat until solilos-chat is installed', () => {
    const without = resolveNavigationEntries({ installedTemplates: ['media'] });
    expect(without.map(e => e.id)).not.toContain('chat');
    const withChat = resolveNavigationEntries({ installedTemplates: ['media', 'solilos-chat'] });
    expect(withChat.map(e => e.id)).toContain('chat');
  });

  it('hides Users & Groups until the LLDAP url resolves, then uses it as the href', () => {
    expect(resolveNavigationEntries({}).map(e => e.id)).not.toContain('users');
    const users = resolveNavigationEntries({ lldapUrl: 'https://ldap.example.com' }).find(e => e.id === 'users');
    expect(users?.href).toBe('https://ldap.example.com');
    expect(users?.external).toBe(true);
    // External entries have no route — they must never be matched by isNavActive.
    expect(users?.path).toBeNull();
  });

  it('keeps View as user unconditional and pointed at /portal', () => {
    const portal = resolveNavigationEntries({}).find(e => e.id === 'portal');
    expect(portal?.href).toBe('/portal');
    expect(portal?.external).toBe(true);
  });

  it('threads ?node= onto in-app routes only, never onto an external url', () => {
    const entries = resolveNavigationEntries({ ...full, node: 'edge-1' });
    expect(entries.find(e => e.id === 'services')?.href).toBe('/services?node=edge-1');
    expect(entries.find(e => e.id === 'chat')?.href).toBe('/chat?node=edge-1');
    expect(entries.find(e => e.id === 'users')?.href).toBe('https://ldap.example.com');
    expect(entries.find(e => e.id === 'portal')?.href).toBe('/portal');
  });

  it('resolves every destination the desktop sidebar and mobile nav share', () => {
    const resolved = resolveNavigationEntries(full);
    // The sidebar renders the whole list; mobile splits it into the bottom bar
    // and the top-bar icon row. That partition must cover it exactly — that IS
    // the desktop/mobile parity guarantee.
    const bottom = resolved.filter(e => !e.hiddenOnMobileBottom);
    const top = resolved.filter(e => e.hiddenOnMobileBottom);
    expect([...bottom, ...top].map(e => e.id).sort()).toEqual(resolved.map(e => e.id).sort());
    expect(bottom.length).toBeLessThanOrEqual(5);
    expect(resolved.map(e => e.id)).toEqual([
      'home', 'services', 'status', 'settings', 'backup', 'network', 'terminal', 'chat', 'users', 'portal',
    ]);
  });

  it('renders nothing conditional on a bare box (no chat, no LLDAP)', () => {
    expect(resolveNavigationEntries({}).map(e => e.id)).toEqual([
      'home', 'services', 'status', 'settings', 'backup', 'network', 'terminal', 'portal',
    ]);
  });
});
