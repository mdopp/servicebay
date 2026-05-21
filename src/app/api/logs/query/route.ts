import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger, LogFilter } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  date: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  // `tag` may repeat in the query string; preprocess to array.
  tag: z.preprocess(
    v => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.string()),
  ),
  search: z.string().optional(),
  limit: z.coerce.number().int().nonnegative().default(500),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    try {
      const filter: LogFilter = {
        date: query.date,
        level: query.level,
        tags: query.tag,
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      };
      const logs = logger.queryLogs(filter);
      return NextResponse.json({ success: true, logs });
    } catch (err) {
      logger.error('api:logs:query', 'Failed to query logs', err);
      return NextResponse.json({ success: false, logs: [] }, { status: 500 });
    }
  },
);
