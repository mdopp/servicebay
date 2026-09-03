import { exec } from 'node:child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import type { SystemUpdates } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

const execAsync = promisify(exec);

const Query = z.object({ node: z.string().optional() });

/**
 * GET /api/system/os-updates — pending host OS packages (#2745, was
 * `app/actions/system.ts:getSystemUpdates`). Distinct from
 * `/api/system/update`, which is ServiceBay's own updater.
 *
 * apt-specific and best-effort: a non-Debian host, a missing `apt`, or a
 * permission problem all report zero rather than surfacing an error, because
 * the dashboard tile is informational.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }): Promise<SystemUpdates> => {
    if (query.node && query.node !== 'Local') return { count: 0, list: [] };

    try {
      const { stdout } = await execAsync('apt list --upgradable 2>/dev/null | grep -v "Listing..." | wc -l');
      const count = parseInt(stdout.trim()) || 0;
      if (count === 0) return { count: 0, list: [] };

      const { stdout: listOut } = await execAsync('apt list --upgradable 2>/dev/null | grep -v "Listing..." | head -n 10');
      return { count, list: listOut.trim().split('\n') };
    } catch {
      return { count: 0, list: [] };
    }
  },
);
