import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { listAssists, ASSIST_KINDS } from '@/lib/assists/catalog';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Query = z
  .object({
    query: z.string().optional(),
    kind: z.enum(ASSIST_KINDS).optional(),
  })
  .partial();

// GET /api/assists — list catalog entries (built-in + local), Local overriding
// Built-in by id. The HTTP twin of the `list_assists` MCP tool (#2221).
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    try {
      const assists = await listAssists({ query: query?.query, kind: query?.kind });
      return NextResponse.json({ assists });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', 'list failed', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
