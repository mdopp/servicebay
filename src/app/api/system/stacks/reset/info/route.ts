import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { getNodeTwins } from '@/lib/store/repository';
import { requireSession } from '@/lib/api/requireSession';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getConfig } from '@/lib/config';
import { RESET_GROUPS, getChildExclusions, isAlwaysWipe, type ResetGroup } from '@/lib/install/resetGroups';

/**
 * Map a service name to the reset group whose wipe would destroy its
 * on-disk data (#668 — S8 stale-route prediction).
 *
 * Mirrors the resetGroups.ts path table: nginx-proxy-manager lives
 * under `certs`, `auth` under `identity`, everything else under
 * `service-data`. ServiceBay-owned services (the kernel itself) sit in
 * `secrets` but they don't have proxy routes, so they don't matter
 * here.
 */
function resetGroupForService(service: string): ResetGroup {
  if (service === 'nginx-proxy-manager' || service === 'nginx') return 'certs';
  if (service === 'auth' || service === 'authelia' || service === 'lldap') return 'identity';
  return 'service-data';
}

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/stacks/reset/info?node=<name>
 *
 * Returns per-group disk usage so the wizard's "what will Clean
 * install wipe?" panel can show concrete sizes next to each
 * preserve/wipe checkbox — operators decide intentionally instead of
 * blind-clicking RESET (the #568 transparency rework).
 *
 * Response:
 *   {
 *     node: "atHome-Server",
 *     groups: [
 *       { id: "secrets",         ..., bytes: 123,        alwaysWipe: false },
 *       { id: "certs",           ..., bytes: 456,        alwaysWipe: false },
 *       { id: "identity",        ..., bytes: 789,        alwaysWipe: false },
 *       { id: "service-data",    ..., bytes: 12_345_678, alwaysWipe: false },
 *       { id: "quadlet-backup",  ..., bytes: 821_000_000, alwaysWipe: true }
 *     ]
 *   }
 *
 * Sizes are computed via `du -sb --exclude=...` on each path. Groups
 * whose path contains direct children of other groups (service-data
 * contains nginx-proxy-manager + auth; secrets contains quadlet-backup)
 * pass `--exclude` for those basenames so the per-group sizes don't
 * double-count. Empty/missing paths report 0 + `exists: false` so the
 * UI can grey out groups that have nothing to wipe. Best-effort: a
 * `du` failure on one path doesn't kill the whole response — that
 * group reports `bytes: null` so the UI can fall back to "size unknown".
 */
const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ request, query }) => {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const requestedNode = query.node || undefined;

    const nodeName = requestedNode || Object.keys(getNodeTwins())[0];
    if (!nodeName) {
      return NextResponse.json({ error: 'No nodes available' }, { status: 404 });
    }

    const agent = await agentManager.ensureAgent(nodeName);

    type GroupInfo = {
      id: ResetGroup;
      label: string;
      description: string;
      paths: string[];
      bytes: number | null;
      exists: boolean;
      alwaysWipe: boolean;
    };

    const groupIds = Object.keys(RESET_GROUPS) as ResetGroup[];
    const groups: GroupInfo[] = await Promise.all(groupIds.map(async (id): Promise<GroupInfo> => {
      const def = RESET_GROUPS[id];
      const paths = [...def.paths];
      // `du -sb` reports bytes (Linux). For groups whose paths contain
      // direct children belonging to other declared groups (service-data
      // contains nginx-proxy-manager + auth; secrets contains quadlet-backup)
      // pass `--exclude=<basename>` so the per-group sizes don't double-count
      // the parent's view of those subdirs.
      const childExclusions = getChildExclusions(id);
      const exclusions = childExclusions.map(n => `--exclude=${n}`).join(' ');
      let total = 0;
      let anyExists = false;
      let anyFailed = false;
      for (const p of paths) {
        try {
          const cmd = `if [ -e ${JSON.stringify(p)} ]; then du -sb ${exclusions} ${JSON.stringify(p)} 2>/dev/null | awk '{print $1}'; else echo "MISSING"; fi`;
          const res = await agent.sendCommand('exec', { command: cmd });
          const out = (res.stdout || '').trim();
          if (out === 'MISSING' || out === '') continue;
          const n = parseInt(out, 10);
          if (Number.isFinite(n)) {
            total += n;
            anyExists = true;
          } else {
            anyFailed = true;
          }
        } catch {
          anyFailed = true;
        }
      }
      return {
        id,
        label: def.label,
        description: def.description,
        paths,
        bytes: anyFailed && !anyExists ? null : total,
        exists: anyExists,
        alwaysWipe: isAlwaysWipe(id),
      };
    }));

    // Stale-route preview (#668 — S8). For every NPM proxy host the
    // operator currently has, annotate which reset-group's wipe would
    // strand it. The wizard panel filters this list by the operator's
    // checkbox state and renders an "after this install, N routes will
    // dangle" preview — so they can re-deploy or pre-delete those
    // services before clicking RESET, instead of finding the orphans
    // post-mortem in the diagnose page.
    let proxyHosts: Array<{ domain: string; service: string; group: ResetGroup }> = [];
    try {
      const cfg = await getConfig();
      const hosts = cfg.reverseProxy?.hosts ?? [];
      proxyHosts = hosts
        .filter(h => h.created && h.domain && h.service)
        .map(h => ({ domain: h.domain, service: h.service, group: resetGroupForService(h.service) }));
    } catch {
      // Best-effort — a config-load failure shouldn't break the
      // primary purpose of this endpoint (size info). Empty list means
      // "no preview" not "no routes".
    }

    return NextResponse.json({ node: nodeName, groups, proxyHosts });
  } catch (error) {
    return apiError(error, { tag: 'api:system:stacks:reset:info', status: 500 });
  }
});
