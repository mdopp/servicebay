import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listLocalMountCandidates } from '@/lib/backup/mounts';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * GET — Enumerate host filesystem mount candidates for the Backup Sync
 * Local/USB target picker (#1613). Optional `node` query overrides the
 * default (home) node. Always returns a list (possibly empty) so the
 * picker can fall back to the advanced free-text path on its own.
 */
const GetQuery = z.object({ node: z.string().min(1).optional() });

export const GET = withApiHandler<undefined, z.infer<typeof GetQuery>>(
  { query: GetQuery },
  async ({ query }) => {
    const mounts = await listLocalMountCandidates(query.node);
    return NextResponse.json({ mounts });
  },
);
