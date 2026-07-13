import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { ServiceManager } from '@/lib/services/ServiceManager';

export const dynamic = 'force-dynamic';

/**
 * GET /napi/services — service list + health for the companion app (#2252).
 *
 * A lean projection of `ServiceManager.listServices()` — just what the app's
 * service-list widget renders (name + state + a coarse health label), NOT the
 * full ServiceInfo (ports/volumes/kube paths) the browser dashboard needs. The
 * `/api/services` route stays the rich browser surface; this is the token-only,
 * proxy-bypassed twin.
 *
 * `health` is derived from the same active/status signal listServices returns:
 * `active` → healthy, `failed` status → failed, otherwise `stopped`. (Deep
 * probe health lives behind /api/services/[name]/status; the widget only needs
 * a traffic-light.)
 *
 * TOKEN-ONLY, read-scoped. `tokenScope: 'read'` in the withApiHandler OPTIONS
 * (#2249) — a valid read Bearer is accepted, missing/wrong-scope 401s.
 */
type NapiHealth = 'healthy' | 'failed' | 'stopped';

export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const services = await ServiceManager.listServices('Local');
    const projected = services.map(s => {
      const activeState = s.active ? 'active' : 'inactive';
      const subState = s.status;
      const health: NapiHealth = s.active ? 'healthy' : s.status === 'failed' ? 'failed' : 'stopped';
      return { name: s.name, activeState, subState, health };
    });
    return NextResponse.json({ services: projected });
  } catch (e) {
    return apiError(e, { tag: 'napi:services', status: 500 });
  }
});
