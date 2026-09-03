/**
 * Sidebar & mobile-nav navigation schema (#845 / ARCH-13).
 *
 * Single source of truth for the primary navigation entries. The
 * sidebar (`Sidebar.tsx`) and the mobile bottom bar (`MobileNav.tsx`)
 * both read from this list — adding, removing, or re-ordering a
 * dashboard link is one edit here, no component changes needed.
 *
 * Extending this is the recommended way to add a new dashboard:
 *   1. Build a route at `/<path>`.
 *   2. Append a NavigationEntry below.
 *   3. (Optional) hide from the mobile bottom bar with
 *      `hiddenOnMobileBottom: true` — Settings & Backup do this so the
 *      bottom bar stays uncluttered (they surface in the mobile top
 *      bar's icon row instead, so they're still reachable on a phone;
 *      see MobileNav.tsx #1992).
 *
 * EVERY entry both nav components render lives here — including the
 * conditional one (Maintenance Chat) and the two that leave the app
 * (Users & Groups → LLDAP, View as user → the family portal). Before
 * #2521 those three were inline JSX in `Sidebar.tsx`, which bypassed the
 * indirection the UX rule depends on (docs/UX_DECISIONS.md → "Primary
 * sidebar is a user-task list": *"Sidebar.tsx / MobileNav.tsx map over
 * the schema; no inline entries"*) and made the desktop sidebar show a
 * different set of destinations than the mobile nav. The schema now
 * carries the two concepts they needed — `external` + href, and
 * `requiresTemplate` — so both components can render from one list.
 * Anything runtime-dependent is resolved by `resolveNavigationEntries`.
 */
import { Home, Box, HeartPulse, Settings, Network, DatabaseBackup, SquareTerminal, MessageCircle, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavigationEntryBase {
  /** Stable identifier used in keys / `data-testid` / `dashboards.id`
   *  references throughout the codebase. Do not change once shipped. */
  id: string;
  /** Sidebar label (full). */
  name: string;
  /** Mobile bottom-bar label (terser). */
  shortLabel: string;
  /** Lucide icon component. Accepts the full Lucide prop surface
   *  (size, strokeWidth, className, color, …). */
  icon: LucideIcon;
  /** When true, the mobile bottom bar omits this entry; instead it is
   *  rendered as an icon in the mobile top bar's right-hand row, so it
   *  stays reachable on a phone (#1992). The desktop sidebar always
   *  renders every entry. Used for Settings, Backup and every external
   *  entry (an app-leaving link never belongs in the bottom bar). */
  hiddenOnMobileBottom?: boolean;
  /** Render this entry only when the named template is installed on the
   *  box (`digital twin → installedTemplates`). Lets a conditional
   *  destination live in the schema instead of as inline component JSX
   *  (#2521). Maintenance Chat uses this. */
  requiresTemplate?: string;
}

/** A destination inside the ServiceBay app — client-side route push. */
export interface InternalNavigationEntry extends NavigationEntryBase {
  external?: false;
  /** Route path. The `usePathname().startsWith(path)` test marks an
   *  entry active, so prefer "/X" over "/X/" or "/X/index". */
  path: string;
}

/** A destination that LEAVES the app — rendered as an `<a target="_blank">`
 *  in its own visual group, never as a router push (#2521). */
interface ExternalNavigationEntry extends NavigationEntryBase {
  external: true;
  /** Static URL, when it is known without asking the box (`/portal`). */
  href?: string;
  /** Where to read the URL at runtime when it depends on the box's
   *  configuration. `'lldap'` → `GET /api/auth/lldap-url`. The entry is
   *  hidden until (and unless) that URL resolves. */
  hrefSource?: 'lldap';
}

export type NavigationEntry = InternalNavigationEntry | ExternalNavigationEntry;

/**
 * Active-route test for a nav entry. The root entry (`/`) must match the
 * pathname EXACTLY — otherwise `startsWith('/')` is true on every page and
 * the root would look active alongside the real section. Deeper entries match
 * by path segment, so `/services/foo` still highlights Services while
 * `/servicesX` does not.
 */
export function isNavActive(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * The collapsed top nav of the IA redesign (slice 2, spec §3/§4.1/§8):
 * **Home · Services · Status · Settings · Backup · Network Map**.
 *
 *   - Home is a lean, status-led landing (restored by operator request, spec
 *     §4.3 spirit): the box-wide health headline + latest diagnose breakdown
 *     ("is my box OK?"). It carries no navigation-shortcut cards (the old hub's
 *     pure-nav grid is covered by this nav), and the live install-progress
 *     monitor stays folded into the Services list, so nothing is duplicated.
 *   - Services is the list of every app (spec §2/§4.1).
 *   - Status is the single box-wide health screen — it absorbs the old
 *     Diagnostics (`/health`), which now redirects to `/status` (spec §4.3/§8).
 *     Box-wide containers live here (and ONLY here); the per-container tab is
 *     gone from any per-service surface.
 *   - Network Map is kept top-level by operator preference (the one allowed
 *     addition beyond the spec's literal four nouns).
 *   - Terminal is back in the sidebar by operator request (#2083): a host shell
 *     is a recovery tool and must not be buried in a Settings launch card. It
 *     renders in the desktop sidebar; `hiddenOnMobileBottom` keeps it out of the
 *     phone bottom bar (expert/recovery tool, surfaced in the mobile top-bar
 *     icon row instead). Route served at `/terminal`.
 *
 * Capabilities that left the top nav stay fully reachable (spec: "don't
 * mutilate — every knob stays reachable"):
 *   - Diagnostics → Status.
 *   - Disk import / Backup heavy UI → their own apps (#1949/#1958).
 *
 * hiddenOnMobileBottom keeps the phone bottom bar at ≤5 (Status/Settings/Backup
 * surface in the mobile top-bar icon row instead).
 */
export const NAVIGATION_ENTRIES: NavigationEntry[] = [
  { id: 'home', name: 'Home', shortLabel: 'Home', icon: Home, path: '/' },
  { id: 'services', name: 'Services', shortLabel: 'Services', icon: Box, path: '/services' },
  { id: 'status', name: 'Status', shortLabel: 'Status', icon: HeartPulse, path: '/status', hiddenOnMobileBottom: true },
  { id: 'settings', name: 'Settings', shortLabel: 'Settings', icon: Settings, path: '/settings', hiddenOnMobileBottom: true },
  { id: 'backup', name: 'Backup & restore', shortLabel: 'Backup', icon: DatabaseBackup, path: '/backup', hiddenOnMobileBottom: true },
  { id: 'network', name: 'Network Map', shortLabel: 'Network', icon: Network, path: '/network' },
  { id: 'terminal', name: 'Terminal', shortLabel: 'Terminal', icon: SquareTerminal, path: '/terminal', hiddenOnMobileBottom: true },
  // Conditional in-app destination: the chat surface only exists once
  // solilos-chat is installed (#1755/#1781). Schema-driven since #2521 —
  // it used to be inline JSX in Sidebar.tsx, so the mobile nav never saw it.
  { id: 'chat', name: 'Maintenance Chat', shortLabel: 'Chat', icon: MessageCircle, path: '/chat', requiresTemplate: 'solilos-chat' },
  // App-leaving links. Not new destinations (#2521 moved them out of
  // Sidebar.tsx verbatim) — they render in their own group, after a
  // divider, and stay off the phone bottom bar.
  { id: 'users', name: 'Users & Groups', shortLabel: 'Users', icon: Users, external: true, hrefSource: 'lldap', hiddenOnMobileBottom: true },
  { id: 'portal', name: 'View as user', shortLabel: 'Portal', icon: Home, external: true, href: '/portal', hiddenOnMobileBottom: true },
];

/** Runtime inputs the schema's conditional / external entries need. */
export interface NavigationContext {
  /** `digitalTwin.installedTemplates` — gates `requiresTemplate` entries. */
  installedTemplates?: string[] | null;
  /** Resolved LLDAP admin URL (`GET /api/auth/lldap-url`), or null when
   *  LLDAP is not deployed / not reachable. */
  lldapUrl?: string | null;
  /** Active `?node=` — threaded onto in-app routes only. */
  node?: string | null;
}

/** A schema entry with everything runtime-dependent already resolved. */
export interface ResolvedNavigationEntry {
  id: string;
  name: string;
  shortLabel: string;
  icon: LucideIcon;
  /** Where the entry goes: an in-app route (with `?node=` threaded) for an
   *  internal entry, an absolute/app-leaving URL for an external one. */
  href: string;
  /** The raw route, for `isNavActive`. `null` for external entries. */
  path: string | null;
  external: boolean;
  hiddenOnMobileBottom: boolean;
}

/**
 * Resolve the schema against live box state — the ONE place a nav
 * component gets its entries from (#2521). Both `Sidebar.tsx` and
 * `MobileNav.tsx` render whatever this returns, which is what keeps
 * desktop and mobile showing the same set of destinations.
 *
 * Drops an entry when its precondition isn't met: a `requiresTemplate`
 * entry whose template isn't installed, or an `hrefSource` entry whose
 * URL hasn't resolved (LLDAP not deployed).
 */
export function resolveNavigationEntries(
  ctx: NavigationContext,
  entries: NavigationEntry[] = NAVIGATION_ENTRIES,
): ResolvedNavigationEntry[] {
  const resolved: ResolvedNavigationEntry[] = [];
  for (const entry of entries) {
    if (entry.requiresTemplate && !ctx.installedTemplates?.includes(entry.requiresTemplate)) continue;
    const common = {
      id: entry.id,
      name: entry.name,
      shortLabel: entry.shortLabel,
      icon: entry.icon,
      hiddenOnMobileBottom: Boolean(entry.hiddenOnMobileBottom),
    };
    if (entry.external) {
      const href = entry.hrefSource === 'lldap' ? ctx.lldapUrl : entry.href;
      if (!href) continue;
      resolved.push({ ...common, href, path: null, external: true });
      continue;
    }
    resolved.push({
      ...common,
      href: `${entry.path}${ctx.node ? `?node=${ctx.node}` : ''}`,
      path: entry.path,
      external: false,
    });
  }
  return resolved;
}
