/**
 * GET /api/system/last-crash (#2159)
 *
 * The IN-BAND surface for the out-of-band crash breadcrumb. When
 * `servicebay.service` exit-loops (e.g. exit 126 from a broken `:Z` relabel
 * caused by a foreign-owned stray), the ExecStopPost hook on the host quadlet
 * writes `last-crash.json` into the data dir — a host path that survives the
 * container being down (see lib/health/crashBreadcrumb.ts and the
 * `servicebay-crash-breadcrumb.sh` writer in fedora-coreos.bu). Once the
 * container recovers, this endpoint reads + parses it so the UI (and sb-tui,
 * over a `read`-scoped token) can show the last crash with a recovery hint.
 *
 * Returns `{ breadcrumb: CrashBreadcrumb | null }`. `null` = never crashed, or
 * a box that predates the writer. Read-scoped: it's diagnostic, no secrets.
 *
 * NOTE: while the container is still DOWN this endpoint is unreachable (that is
 * the whole point of the breadcrumb). The out-of-band read path for that window
 * is sb-tui reading the same host file over SSH — a documented follow-up.
 */
import { NextResponse } from 'next/server';
import { readCrashBreadcrumb } from '@/lib/health/crashBreadcrumb';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  return NextResponse.json({ breadcrumb: readCrashBreadcrumb() });
});
