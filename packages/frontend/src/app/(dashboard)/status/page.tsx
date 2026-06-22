'use client';

import HealthDashboard from '@/dashboards/HealthDashboard';

/**
 * Status — the box-wide health view (IA redesign slice 2, spec §4.3).
 *
 * The single "is the box OK?" screen: health checks, diagnose actions,
 * box-wide containers and system info. The dashboard reads its active tab
 * from the URL, so `/status?tab=containers` is the box-wide containers view
 * — the ONLY place box-wide containers live (no per-container tab elsewhere;
 * per-service containers are on each Operate page). `/health` no longer
 * renders this directly — it redirects here (carrying its query), so Status
 * is the single canonical box-wide health surface (IA slice 2, #2030).
 */
export default function StatusPage() {
  return <HealthDashboard />;
}
