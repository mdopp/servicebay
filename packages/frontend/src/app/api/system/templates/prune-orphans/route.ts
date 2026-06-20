import { NextResponse } from 'next/server';
import { AgentExecutor } from '@/lib/agent/executor';
import { getNodeIds } from '@/lib/store/repository';
import { findOrphanedTemplates, pruneOrphanedTemplates } from '@/lib/install/pruneOrphanedTemplates';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/** The live running-container name list from `podman ps` on the node. */
async function runningContainers(): Promise<string[]> {
  const node = getNodeIds()[0] || 'Local';
  const { stdout } = await new AgentExecutor(node).exec('podman ps --format "{{.Names}}"', { timeoutMs: 10_000 });
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * GET — PREVIEW orphaned installedTemplates entries (#health-hermes-ghost): entries
 * with no template manifest AND no running container (a removed/renamed service whose
 * config entry lingers and keeps probes like `hermes_chat` firing). Read-only.
 */
export const GET = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      return NextResponse.json({ ok: true, orphans: await findOrphanedTemplates(await runningContainers()) });
    } catch (e) {
      return apiError(e, { tag: 'api:system:templates:prune-orphans:preview', status: 400, exposeMessage: true });
    }
  },
);

/**
 * POST — PRUNE the orphaned entries (same double guard: manifest-less AND no running
 * container, so the live `solaris` family is never touched). Returns what was removed.
 */
export const POST = withApiHandler(
  { tokenScope: 'destroy' },
  async () => {
    try {
      return NextResponse.json({ ok: true, pruned: await pruneOrphanedTemplates(await runningContainers()) });
    } catch (e) {
      return apiError(e, { tag: 'api:system:templates:prune-orphans', status: 400, exposeMessage: true });
    }
  },
);
