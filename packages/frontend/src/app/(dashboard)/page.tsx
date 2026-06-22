'use client';

import OverviewDashboard from '@/dashboards/OverviewDashboard';

/**
 * Home — the lean, status-led landing (IA redesign, spec §4.3 spirit).
 *
 * Restored by operator request as the first thing you see: a clean answer to
 * "is my box OK?" (health headline + latest diagnose breakdown). The old
 * navigation-shortcut grid is gone (covered by the top nav), and the live
 * install-progress monitor stays folded into the Services list, so Home
 * carries no duplicate nav.
 */
export default function HomePage() {
  return <OverviewDashboard />;
}
