import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getPendingTemplateUpgrades } from '@/lib/templateUpgrades';
import { getInstalledImageUpdates } from '@/lib/imageDigest';

export const dynamic = 'force-dynamic';

/**
 * GET /napi/upgrades — pending template + image upgrades for the companion
 * app (#2252, child 2 of epic #2242).
 *
 * Unifies the two "something newer is available" signals the browser exposes
 * separately (`/api/system/templates/upgrades-pending` for template
 * schema-version bumps, `/api/system/stacks/image-updates` for newer container
 * images) into ONE flat list the app's upgrades widget renders:
 *   { upgrades: [{ name, kind: 'template'|'image', current, available }] }
 * Reuses the exact same backend data sources (`getPendingTemplateUpgrades`,
 * `getInstalledImageUpdates`) — no duplicated comparison logic.
 *
 * TOKEN-ONLY, read-scoped. `tokenScope: 'read'` in the withApiHandler OPTIONS
 * (#2249) — accepted for a valid read Bearer, 401 for missing/wrong scope.
 */
interface NapiUpgrade {
  name: string;
  kind: 'template' | 'image';
  current: string;
  available: string;
}

export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const [templateUpgrades, imageUpdates] = await Promise.all([
      getPendingTemplateUpgrades(),
      getInstalledImageUpdates(),
    ]);

    const upgrades: NapiUpgrade[] = [];

    for (const t of templateUpgrades) {
      upgrades.push({
        name: t.name,
        kind: 'template',
        current: `v${t.installedVersion}`,
        available: `v${t.currentVersion}`,
      });
    }

    for (const u of imageUpdates) {
      if (!u.updateAvailable) continue;
      upgrades.push({
        name: u.service,
        kind: 'image',
        // Digests are the only version signal podman gives us here; short-form
        // them so the widget shows a recognizable stub, not a 71-char sha256.
        current: shortDigest(u.runningDigest),
        available: shortDigest(u.registryDigest),
      });
    }

    return NextResponse.json({ upgrades });
  } catch (e) {
    return apiError(e, { tag: 'napi:upgrades', status: 500 });
  }
});

/** `sha256:abcdef…` → `abcdef1` (7-char short id), or '' when unknown. */
function shortDigest(digest: string | null): string {
  if (!digest) return '';
  const hex = digest.includes(':') ? digest.split(':', 2)[1] : digest;
  return hex.slice(0, 7);
}
