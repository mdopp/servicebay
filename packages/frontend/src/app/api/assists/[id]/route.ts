import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getAssist } from '@/lib/assists/catalog';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// GET /api/assists/:id — full raw markdown (frontmatter + body) of one entry,
// Local overriding Built-in. 404 for an unknown or unsafe id (#2221).
// `tokenScope: 'read'` (#2906) — the HTTP twin of `get_assist`, reachable with a
// read-scoped token so a container can read an ADR without an MCP client.
export const GET = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'read' },
  async ({ params }) => {
    const id = decodeURIComponent(params.id);
    try {
      const content = await getAssist(id);
      if (content === null) {
        return NextResponse.json({ error: `assist not found: ${id}` }, { status: 404 });
      }
      return NextResponse.json({ id, content });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `get ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
