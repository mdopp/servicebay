import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getPendingTemplateUpgrades } from '@/lib/templateUpgrades';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/templates/upgrades-pending
 *
 * Aggregated answer to "which deployed services have a pending
 * template upgrade?" — the same comparison the per-template
 * `upgrade-preview` endpoint does, fanned out across every entry in
 * `config.installedTemplates`. The fan-out itself lives in
 * `@/lib/templateUpgrades` (shared with the companion app's
 * `/napi/upgrades`, #2252).
 *
 * Returned so the Services list can render a per-card badge without
 * firing N requests on every page load. The shape mirrors
 * `upgrade-preview` per item, minus the full section bodies (only
 * the headers — the operator opens the InstallerModal for the full
 * read-through).
 *
 * Filed as #510 alongside the SSO push that surfaced the gap:
 * three schema-version bumps (file-share, adguard, home-assistant)
 * would sit unnoticed for any operator who never opens the
 * Re-deploy modal.
 */
// tokenScope must live in the withApiHandler OPTIONS so handler.ts's built-in
// requireSession runs with it (#2249) — same pending-updates signal, template
// side. A scoped Bearer token may read it; cookie sessions are unaffected.
// (Previously the scope sat on an INNER requireSession call while the wrapper
// gate ran scopeless first → the Bearer path was skipped → 401; box-verify RED.)
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const summaries = await getPendingTemplateUpgrades();
    return NextResponse.json({
      pending: summaries,
      hasBreakingChange: summaries.some(s => s.hasBreakingChange),
    });
  } catch (e) {
    return apiError(e, { tag: 'api:system:templates:upgrades-pending', status: 500 });
  }
});
