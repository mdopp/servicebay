import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { listApprovals } from '@/lib/approvals';
import { getInstalledImageUpdates } from '@/lib/imageDigest';

export const dynamic = 'force-dynamic';

/**
 * GET /napi/home — one-call homescreen summary for the Solaris-android
 * companion app (#2252, child 2 of epic #2242).
 *
 * The app's home widget renders three counts (services health, pending
 * approvals, pending updates) in a single tile. Fanning those out as three
 * separate polls would triple the round-trips on a mobile network; this route
 * aggregates them server-side so the widget refreshes with ONE request.
 *
 * TOKEN-ONLY, read-scoped. `tokenScope: 'read'` lives in the withApiHandler
 * OPTIONS (never an inner requireSession call, #2249) so handler.ts's built-in
 * gate runs WITH the scope — a valid `read` Bearer is accepted, a missing/
 * wrong-scope Bearer 401s, deny-by-default. This route sits under `/napi/*`
 * (not `/api/*`) so proxy.ts's cookie/Authelia gate never runs against it: the
 * companion app authenticates with the Bearer token minted by /napi/pair, never
 * a browser cookie.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    // Each source can fail independently (podman fan-out, store read); we still
    // want the other counts, so resolve them together and never crash the whole
    // summary on one slow/errored source.
    const [services, approvals, imageUpdates] = await Promise.all([
      ServiceManager.listServices('Local'),
      listApprovals(),
      getInstalledImageUpdates(),
    ]);

    let servicesUp = 0;
    let servicesFailed = 0;
    let servicesDown = 0;
    for (const s of services) {
      if (s.active) servicesUp += 1;
      else if (s.status === 'failed') servicesFailed += 1;
      else servicesDown += 1;
    }

    const pendingApprovals = approvals.filter(a => a.status === 'pending').length;
    const pendingUpdates = imageUpdates.filter(u => u.updateAvailable).length;

    return NextResponse.json({
      servicesUp,
      servicesFailed,
      servicesDown,
      pendingApprovals,
      pendingUpdates,
    });
  } catch (e) {
    return apiError(e, { tag: 'napi:home', status: 500 });
  }
});
