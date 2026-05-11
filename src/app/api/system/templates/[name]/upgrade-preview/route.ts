import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { getConfig } from '@/lib/config';
import { getTemplateYaml, getTemplateChangelog } from '@/lib/registry';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';
import { parseChangelog, filterUpgradeSections, hasBreakingChanges } from '@/lib/templateChangelog';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/templates/[name]/upgrade-preview?source=<reg>
 *
 * Compare the schema version of the template on disk (or in the
 * named registry) against what's currently deployed on this node.
 * Returns the filtered CHANGELOG sections the operator hasn't seen
 * yet — between their installed version and the template's current
 * version.
 *
 * Response:
 *   {
 *     installedVersion: number | null,
 *     currentVersion: number,
 *     hasUpgrade: boolean,
 *     hasBreakingChange: boolean,
 *     sections: [{ version, breaking, body }],
 *   }
 *
 * When the template carries no CHANGELOG.md, `sections` is empty
 * even if there's a version delta — the dashboard can still warn
 * "no changelog provided" if it wants. Phase 2 in #354 adds the
 * gate that blocks the actual deploy until the operator
 * acknowledges; this endpoint only feeds the diff.
 *
 * See #353 / #352.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { name } = await params;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      return NextResponse.json({ error: 'invalid template name' }, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') ?? undefined;

    const yaml = await getTemplateYaml(name, source);
    if (yaml === null) {
      return NextResponse.json({ error: 'template not found' }, { status: 404 });
    }
    const currentVersion = parseTemplateSchemaVersion(yaml);

    const config = await getConfig();
    const installed = config.installedTemplates?.[name];
    const installedVersion = installed?.schemaVersion ?? null;

    const hasUpgrade = installedVersion === null
      ? false  // never deployed — caller treats as fresh install, not upgrade
      : currentVersion > installedVersion;

    const changelog = await getTemplateChangelog(name, source);
    const allSections = parseChangelog(changelog ?? '');
    const sections = hasUpgrade
      ? filterUpgradeSections(allSections, installedVersion ?? undefined, currentVersion)
      : [];

    return NextResponse.json({
      installedVersion,
      currentVersion,
      hasUpgrade,
      hasBreakingChange: hasBreakingChanges(sections),
      sections,
    });
  } catch (e) {
    return apiError(e, { tag: 'api:system:templates:upgrade-preview', status: 500 });
  }
}
