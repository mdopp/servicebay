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
import { Box, Terminal, Activity, HeartPulse, Settings, Network, Home, DatabaseBackup } from 'lucide-react';
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
 * Home goes first (#803): it's the operator's landing page after
 * login, answering "is anything broken?" at a glance. Container
 * Engine moved into Diagnostics (Health tab) per UX_DECISIONS.md
 * "Primary sidebar is a user-task list, not an infrastructure list"
 * — operators who need the raw podman view know to open Diagnostics.
 */
/**
 * Active-route test for a nav entry. The root entry (`/`) must match the
 * pathname EXACTLY — otherwise `startsWith('/')` is true on every page and
 * Home looks active alongside the real section (e.g. Home + Settings both
 * highlighted). Deeper entries match by path segment, so `/services/foo`
 * still highlights Services while `/servicesX` does not.
 */
export function isNavActive(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

export const NAVIGATION_ENTRIES: NavigationEntry[] = [
  { id: 'home', name: 'Home', shortLabel: 'Home', icon: Home, path: '/' },
  { id: 'services', name: 'Services', shortLabel: 'Services', icon: Box, path: '/services' },
  { id: 'network', name: 'Network Map', shortLabel: 'Network', icon: Network, path: '/network' },
  // Status is the box-wide health noun in the IA redesign (slice 2, spec §4.3):
  // the single "is the box OK?" screen (checks + diagnose actions + box-wide
  // containers/system info), absorbing the old /health?tab=containers surface.
  // hiddenOnMobileBottom keeps the phone bottom bar at 5 (it surfaces in the
  // mobile top-bar icon row instead, like Settings/Backup). /health remains a
  // working alias rendering the same dashboard.
  { id: 'status', name: 'Status', shortLabel: 'Status', icon: HeartPulse, path: '/status', hiddenOnMobileBottom: true },
  { id: 'health', name: 'Diagnostics', shortLabel: 'Health', icon: Activity, path: '/health' },
  { id: 'terminal', name: 'SSH Terminal', shortLabel: 'Terminal', icon: Terminal, path: '/terminal' },
  // Disk import is NOT a primary nav entry — it's a one-or-twice-ever maintenance
  // task, so it lives under Settings → Maintenance (a launch card) and the global
  // search, reachable at /disk-import. Keeping it out of the sidebar avoids giving
  // a rarely-used tool permanent prominence (#1958 follow-up).
  // Backup & restore is its own launch tile (#1949/#1958) — the heavy backup/
  // restore UI left Settings entirely; the actions run in the capped backup
  // worker (#1955), surfaced here rather than as an in-process Settings page.
  { id: 'backup', name: 'Backup & restore', shortLabel: 'Backup', icon: DatabaseBackup, path: '/backup', hiddenOnMobileBottom: true },
  { id: 'settings', name: 'Settings', shortLabel: 'Settings', icon: Settings, path: '/settings', hiddenOnMobileBottom: true },
];
