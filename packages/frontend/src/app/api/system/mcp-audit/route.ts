import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readRecentAudit } from '@/lib/mcp/audit';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
});

/**
 * Read recent MCP audit entries. Limited to the most recent 500
 * entries to keep payloads bounded — operators wanting deeper
 * history can read `mcp-audit.log` directly off the host (also
 * captured by system backups).
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    const entries = await readRecentAudit(query.limit);
    return NextResponse.json({ entries });
  },
);
