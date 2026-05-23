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
 *      `hiddenOnMobileBottom: true` — Settings does this so the
 *      bottom bar doesn't get cluttered (it's still in the top
 *      bar's icon row).
 */
import { LayoutDashboard, Box, Terminal, Activity, Settings, Network } from 'lucide-react';
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
  /** When true, the mobile bottom bar omits this entry. The desktop
   *  sidebar always renders every entry. Used today for Settings
   *  (already in the mobile top bar's icon row). */
  hiddenOnMobileBottom?: boolean;
}

export const NAVIGATION_ENTRIES: NavigationEntry[] = [
  { id: 'services', name: 'Services', shortLabel: 'Services', icon: Box, path: '/services' },
  { id: 'containers', name: 'Container Engine', shortLabel: 'Containers', icon: LayoutDashboard, path: '/containers' },
  { id: 'network', name: 'Network Map', shortLabel: 'Network', icon: Network, path: '/network' },
  { id: 'health', name: 'Health', shortLabel: 'Health', icon: Activity, path: '/health' },
  { id: 'terminal', name: 'SSH Terminal', shortLabel: 'Terminal', icon: Terminal, path: '/terminal' },
  { id: 'settings', name: 'Settings', shortLabel: 'Settings', icon: Settings, path: '/settings', hiddenOnMobileBottom: true },
];
