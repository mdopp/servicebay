import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { getMode } from '@/lib/mode';
import { resolveSetupAsset } from '@/lib/portal/assets';
import type { SetupAssetKind } from '@/lib/portal/userGuide';
import { withApiHandlerParams } from '@/lib/api/handler';
import { requireSession } from '@/lib/api/requireSession';

export const dynamic = 'force-dynamic';

const KIND_VALUES: SetupAssetKind[] = ['ios_calendar_profile', 'audiobookshelf_deeplink', 'syncthing_qr'];

const Query = z.object({
  subdomain_var: z.string().regex(/^[A-Z][A-Z0-9_]*_SUBDOMAIN$/).optional(),
});

type Params = { service: string; kind: string };

/**
 * Public asset endpoint for the family portal (#242 follow-up).
 *
 * Lives under `/api/portal/asset` (note the `/portal/` segment) so
 * proxy.ts's existing apex-rewrite logic + this path-prefix together
 * mark it as portal-territory. Anonymous on the LAN; 404 in public
 * mode (mirrors the rest of the portal — exposing pre-config
 * artifacts publicly is something we'd revisit alongside #265).
 *
 *   - kind=`ios_calendar_profile` → returns .mobileconfig with
 *     Content-Type `application/x-apple-aspen-config`.
 *   - kind=`audiobookshelf_deeplink` → returns JSON `{ url: "abs://…" }`.
 *   - kind=`syncthing_qr` → returns JSON `{ deviceId }`; client
 *     renders the QR locally.
 *
 * The service name and kind are validated against the templates that
 * actually ship the asset — random combos return 404.
 */
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, Params>(
  { query: Query },
  async ({ query, params, request }) => {
    const { service, kind } = params;

    // LAN-mode installs serve portal assets anonymously (the portal
    // page is open on the LAN). Public-mode installs require an
    // authenticated SB session — without that the dashboard's
    // "Pair device" / "Open in app" buttons would 404 even when an
    // operator is logged in. Pre-#1172 this used to hard-404 any
    // public-mode request, which surfaced as "Couldn't read the device
    // id (HTTP 404)" in the Syncthing pairing modal of every operator
    // running with a real publicDomain set.
    const config = await getConfig();
    if (getMode(config) === 'public') {
      const auth = await requireSession(request);
      if (auth instanceof NextResponse) return auth;
    }

    if (!KIND_VALUES.includes(kind as SetupAssetKind)) {
      return new NextResponse('Unknown asset kind', { status: 404 });
    }

    // Sanity-check the service name — must match the template
    // directory naming convention (lowercase + dashes, no traversal).
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(service)) {
      return new NextResponse('Invalid service name', { status: 400 });
    }

    const asset = await resolveSetupAsset(
      kind as SetupAssetKind,
      service,
      query.subdomain_var,
    );
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
      // Return the device ID; the client renders the QR locally.
      // Keeps the server free of a QR library and lets the modal
      // size the QR responsively.
      return NextResponse.json({ deviceId: asset.data });
    }
    // audiobookshelf_deeplink — JSON so the client controls
    // navigation (location.href = url, with a fallback message).
    return NextResponse.json({ url: asset.data });
  },
);
