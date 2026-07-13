import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getConfig } from '@/lib/config';
import { getTemplateYaml, getTemplateChangelog } from '@/lib/registry';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';
import { parseChangelog, filterUpgradeSections, hasBreakingChanges } from '@/lib/templateChangelog';

export const dynamic = 'force-dynamic';

interface UpgradeSummary {
  name: string;
  installedVersion: number;
  currentVersion: number;
  hasBreakingChange: boolean;
  /** Section headers between the installed and current version, in
   *  ascending order. The dashboard uses these for the badge tooltip. */
  sectionHeaders: string[];
}

/**
 * GET /api/system/templates/upgrades-pending
 *
 * Aggregated answer to "which deployed services have a pending
 * template upgrade?" — the same comparison the per-template
 * `upgrade-preview` endpoint does, fanned out across every entry in
 * `config.installedTemplates`.
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
    const config = await getConfig();
    const installed = config.installedTemplates ?? {};

    const summaries: UpgradeSummary[] = [];
    for (const [name, record] of Object.entries(installed)) {
      // Skip names that wouldn't pass the per-template route's
      // validation — they can't have a CHANGELOG anyway.
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
      try {
        const yaml = await getTemplateYaml(name);
        if (yaml === null) continue;
        const currentVersion = parseTemplateSchemaVersion(yaml);
        if (currentVersion <= record.schemaVersion) continue;
        const changelog = await getTemplateChangelog(name);
        const allSections = parseChangelog(changelog ?? '');
        const sections = filterUpgradeSections(allSections, record.schemaVersion, currentVersion);
        if (sections.length === 0) {
          // Version moved forward but the template has no CHANGELOG to
          // explain why — still flag it, but with an empty header
          // list. The badge falls back to "Upgrade available" tooltip.
          summaries.push({
            name,
            installedVersion: record.schemaVersion,
            currentVersion,
            hasBreakingChange: false,
            sectionHeaders: [],
          });
          continue;
        }
        summaries.push({
          name,
          installedVersion: record.schemaVersion,
          currentVersion,
          hasBreakingChange: hasBreakingChanges(sections),
          // Reconstruct the headers from each section. parseChangelog
          // strips them from `body`, so we rebuild
          // "v<N>" or "v<N> (breaking)" so the UI tooltip stays
          // useful without re-walking the markdown.
          sectionHeaders: sections.map(s => `v${s.version}${s.breaking ? ' (breaking)' : ''}`),
        });
      } catch {
        // A single template failing yaml-read shouldn't take the
        // whole aggregate down — the wizard's modal will surface the
        // real error if the operator clicks Re-deploy on that card.
      }
    }

    return NextResponse.json({
      pending: summaries,
      hasBreakingChange: summaries.some(s => s.hasBreakingChange),
    });
  } catch (e) {
    return apiError(e, { tag: 'api:system:templates:upgrades-pending', status: 500 });
  }
});
