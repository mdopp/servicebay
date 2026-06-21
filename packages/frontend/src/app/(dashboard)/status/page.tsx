'use client';

import HealthDashboard from '@/dashboards/HealthDashboard';

/**
 * Status — the box-wide health view (IA redesign slice 2, spec §4.3).
 *
 * The single "is the box OK?" screen: health checks, diagnose actions,
 * box-wide containers and system info. Renders the same HealthDashboard
 * as `/health` for parity — the dashboard reads its active tab from the
 * URL, so `/status?tab=containers` absorbs the old `/health?tab=containers`
 * surface. `/health` stays as a working alias; Status is the IA-canonical
 * entry going forward.
 */
export default function StatusPage() {
  return <HealthDashboard />;
}
