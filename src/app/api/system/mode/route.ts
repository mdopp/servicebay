import { NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/config';
import { getMode, getActiveDomain, isLocalOnly } from '@/lib/mode';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/mode
 *
 * Updates the install mode classification by saving / clearing
 * `reverseProxy.publicDomain`. Body: `{ publicDomain: string | null }`.
 *
 * This is the form-only stub that D19-PR3 ships. The full migration
 * (NPM proxy host dual-server_name, AdGuard double-rewrite, Authelia
 * issuer swap, OIDC client re-registration, Let's Encrypt certs)
 * lands with D19-PR8 (#265). For now, the field is persisted and
 * the next install/redeploy uses the new value.
 */
export async function POST(request: Request) {
  let body: { publicDomain?: string | null } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const next = typeof body.publicDomain === 'string' ? body.publicDomain.trim() : '';
  // Basic validation — let the user clear the domain (empty string)
  // or set it to a hostname-shaped value. Reject obvious garbage.
  if (next && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(next)) {
    return NextResponse.json({ error: 'Domain must be a valid hostname (e.g. example.com).' }, { status: 400 });
  }
  const config = await getConfig();
  await updateConfig({
    reverseProxy: {
      ...config.reverseProxy,
      publicDomain: next || undefined,
    },
  });
  return NextResponse.json({ ok: true, mode: next ? 'public' : 'lan' });
}

/**
 * GET /api/system/mode
 *
 * Classifies the install mode for the dashboard header badge + UI
 * branching. Returns:
 *   - mode: 'lan' | 'public' — the design's two-mode classification
 *     (#249).
 *   - publicDomain / lanDomain: the raw config fields, for UI text.
 *   - activeDomain: the suffix services live on right now (public
 *     when set, lan-domain otherwise).
 *   - localOnly: legacy alias for `mode === 'lan'` — kept for
 *     LocalOnlyBadge.tsx until the badge migrates to ModeBadge.
 *
 * Cheap and cacheable (no agent calls). Read on every page load.
 */
export async function GET() {
  const config = await getConfig();
  return NextResponse.json({
    mode: getMode(config),
    activeDomain: getActiveDomain(config),
    publicDomain: config.reverseProxy?.publicDomain ?? null,
    lanDomain: config.reverseProxy?.lanDomain ?? null,
    localOnly: isLocalOnly(config),
  });
}
