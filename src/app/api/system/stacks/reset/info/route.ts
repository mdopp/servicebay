import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { RESET_GROUPS, getChildExclusions, isAlwaysWipe, type ResetGroup } from '@/lib/install/resetGroups';

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

    return NextResponse.json({ node: nodeName, groups });
  } catch (error) {
    return apiError(error, { tag: 'api:system:stacks:reset:info', status: 500 });
  }
}
