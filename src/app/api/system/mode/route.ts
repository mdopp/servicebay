import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { isLocalOnly } from '@/lib/mode';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/mode
 *
 * Classifies the install mode for the dashboard header badge.
 * Currently exposes:
 *   - localOnly: true when no `reverseProxy.publicDomain` is set —
 *     services run on local IP:port only; SSO + HTTPS proxy paths
 *     are skipped automatically.
 *
 * Cheap and cacheable (no agent calls). Read on every page load by
 * `LocalOnlyBadge`.
 */
export async function GET() {
  const config = await getConfig();
  return NextResponse.json({
    localOnly: isLocalOnly(config),
    publicDomain: config.reverseProxy?.publicDomain ?? null,
  });
}
