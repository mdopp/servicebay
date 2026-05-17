import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { RESET_GROUPS, type ResetGroup } from '@/lib/install/resetGroups';

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
 *       { id: "secrets",       label: "...", description: "...", paths: [...], bytes: 123, exists: true },
 *       { id: "certs",         ...,                                            bytes: 456 },
 *       { id: "identity",      ...,                                            bytes: 789 },
 *       { id: "service-data",  ...,                                            bytes: 12_345_678 }
 *     ]
 *   }
 *
 * Sizes are computed via `du -sb` on each path, summed across paths in
 * the group. Empty/missing paths report 0 + `exists: false` so the UI
 * can grey out groups that have nothing to wipe. Best-effort: a `du`
 * failure on one path doesn't kill the whole response — that group
 * reports `bytes: null` so the UI can fall back to "size unknown".
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const requestedNode = url.searchParams.get('node') || undefined;

    const twin = DigitalTwinStore.getInstance();
    const nodeName = requestedNode || Object.keys(twin.nodes)[0];
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
    };

    const groupIds = Object.keys(RESET_GROUPS) as ResetGroup[];
    const groups: GroupInfo[] = await Promise.all(groupIds.map(async (id): Promise<GroupInfo> => {
      const def = RESET_GROUPS[id];
      const paths = [...def.paths];
      // Compute du for each path; sum. service-data excludes the certs +
      // identity subdirs so the UI doesn't double-count.
      let total = 0;
      let anyExists = false;
      let anyFailed = false;
      for (const p of paths) {
        try {
          // `du -sb` reports bytes (Linux). exit=1 means path missing — treat as 0.
          // For the service-data path (= /mnt/data/stacks), subtract the certs +
          // identity subdirs so we don't double-count them. We compute via
          // `du -sb --exclude` instead of doing math, because excluding gets
          // the right answer even when the operator added more services.
          const exclusions = id === 'service-data'
            ? ['nginx-proxy-manager', 'auth'].map(n => `--exclude=${n}`).join(' ')
            : '';
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
      };
    }));

    return NextResponse.json({ node: nodeName, groups });
  } catch (error) {
    return apiError(error, { tag: 'api:system:stacks:reset:info', status: 500 });
  }
}
