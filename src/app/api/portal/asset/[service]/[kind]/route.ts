import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getMode } from '@/lib/mode';
import { resolveSetupAsset } from '@/lib/portal/assets';
import type { SetupAssetKind } from '@/lib/portal/userGuide';

export const dynamic = 'force-dynamic';

const KIND_VALUES: SetupAssetKind[] = ['ios_calendar_profile', 'audiobookshelf_deeplink', 'syncthing_qr'];

/**
 * Public asset endpoint for the family portal (#242 follow-up).
 *
 * Lives under `/api/portal/asset` (note the `/portal/` segment) so
 * proxy.ts's existing apex-rewrite logic + this path-prefix together
 * mark it as portal-territory. Anonymous on the LAN; 404 in public
 * mode (mirrors the rest of the portal — exposing pre-config
 * artifacts publicly is something we'd revisit alongside #265).
 *
 * GET /api/portal/asset/[service]/[kind]
 *
 *   - kind=`ios_calendar_profile` → returns .mobileconfig with
 *     Content-Type `application/x-apple-aspen-config`. iOS treats it
 *     as an installable Configuration Profile.
 *   - kind=`audiobookshelf_deeplink` → returns JSON `{ url: "abs://..." }`
 *     so the client can decide what to do with it (most likely
 *     `window.location = url`).
 *
 * The service name and kind are validated against the templates
 * that actually ship the asset — random combos return 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ service: string; kind: string }> },
) {
  const { service, kind } = await params;

  // Mode gate: portal assets are LAN-only (same as /portal page).
  const config = await getConfig();
  if (getMode(config) === 'public') {
    return new NextResponse('Not found', { status: 404 });
  }

  if (!KIND_VALUES.includes(kind as SetupAssetKind)) {
    return new NextResponse('Unknown asset kind', { status: 404 });
  }

  // Sanity-check the service name — must be a known template
  // directory layout (no path traversal). Templates have lowercase
  // names with dashes per existing convention.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(service)) {
    return new NextResponse('Invalid service name', { status: 400 });
  }

  const url = new URL(request.url);
  const subdomainVarRaw = url.searchParams.get('subdomain_var');
  const subdomainVar = subdomainVarRaw && /^[A-Z][A-Z0-9_]*_SUBDOMAIN$/.test(subdomainVarRaw)
    ? subdomainVarRaw
    : undefined;
  const asset = await resolveSetupAsset(kind as SetupAssetKind, service, subdomainVar);
  if (!asset) {
    return new NextResponse('Asset not available — service may not be installed yet.', { status: 404 });
  }

  if (asset.kind === 'ios_calendar_profile') {
    return new NextResponse(asset.data, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': `attachment; filename="${service}.mobileconfig"`,
      },
    });
  }
  if (asset.kind === 'syncthing_qr') {
    // Return the device ID; the client renders the QR code itself.
    // Keeping QR generation client-side avoids shipping a server-
    // side QR library + lets the modal scale the QR responsively.
    return NextResponse.json({ deviceId: asset.data });
  }
  // audiobookshelf_deeplink — return JSON so the client controls
  // navigation (location.href = url, with a fallback message).
  return NextResponse.json({ url: asset.data });
}
