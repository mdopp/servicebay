/**
 * GET /api/system/stacks (#634)
 *
 * Returns every stack the local registry knows about with its parsed
 * manifest + aggregated health. Drives the stacks list UI and the
 * wizard's stack selection step (Phase 5B+).
 */
import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getStackManifest, getTemplates } from '@/lib/registry';
import { getStackHealth, type StackHealth } from '@/lib/install/stackHealth';
import type { StackManifest } from '@/lib/template/stackContract';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface StackSummary {
  name: string;
  manifest: StackManifest | null;
  health: StackHealth | null;
}

// `tokenScope: 'read'` (#1276) lets the sb-tui stack-install panel enumerate
// the installable stack catalog with a scoped `sb_` token; the handler gate
// also covers the web UI's session cookie.
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    // Enumerate stack names from the union of built-in + every external
    // registry. `getTemplates()` returns `Template[]` covering both
    // templates and stacks across all sources, with external entries
    // already overriding built-ins by name (`registry.ts:269`). Filter
    // to `type === 'stack'`, then per-name pull the parsed manifest +
    // aggregated health.
    //
    // History: this used to `fs.readdir(<cwd>/stacks)` directly, which
    // silently missed every stack shipped from an external registry —
    // surfaced after the OSCAR migration (#1159) moved `stacks/oscar/`
    // out to `mdopp/oscar`, leaving the wizard unable to see it.
    const all = await getTemplates();
    const names = Array.from(new Set(all.filter(t => t.type === 'stack').map(t => t.name)));

    const stacks: StackSummary[] = await Promise.all(names.map(async (name): Promise<StackSummary> => {
      try {
        const manifest = await getStackManifest(name);
        const health = manifest ? await getStackHealth(name) : null;
        return { name, manifest, health };
      } catch (e) {
        logger.warn('api:stacks', `Failed to load stack ${name}: ${e instanceof Error ? e.message : String(e)}`);
        return { name, manifest: null, health: null };
      }
    }));

    // Sort: core stacks first (so the UI groups them at the top), then
    // alphabetical within each tier.
    stacks.sort((a, b) => {
      const ta = a.manifest?.tier ?? 'feature';
      const tb = b.manifest?.tier ?? 'feature';
      if (ta !== tb) return ta === 'core' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ stacks });
  } catch (e) {
    return apiError(e, { tag: 'api:system:stacks:list', status: 500 });
  }
});
