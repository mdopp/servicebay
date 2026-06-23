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
 */
import { Home, Box, HeartPulse, Settings, Network, DatabaseBackup, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavigationEntry {
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
  /** Route path. The `usePathname().startsWith(path)` test marks an
   *  entry active, so prefer "/X" over "/X/" or "/X/index". */
  path: string;
  /** When true, the mobile bottom bar omits this entry; instead it is
   *  rendered as an icon in the mobile top bar's right-hand row, so it
   *  stays reachable on a phone (#1992). The desktop sidebar always
   *  renders every entry. Used for Settings and Backup. */
  hiddenOnMobileBottom?: boolean;
}

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
];
