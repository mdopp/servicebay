import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getHistory, getSnapshotContent } from '@/lib/history';
import { listNodes } from '@/lib/nodes';
import { BackupFileName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

const TIMESTAMP_RE = /^[0-9_\-]{1,64}$/;

const Query = z.object({
  timestamp: z.string().regex(TIMESTAMP_RE, 'invalid timestamp').optional(),
  node: z.string().optional(),
});

type Params = { filename: string };

export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, Params>(
  { query: Query },
  async ({ query, params }) => {
    const nameCheck = BackupFileName.safeParse(decodeURIComponent(params.filename));
    if (!nameCheck.success) {
      return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
    }
    const filename = nameCheck.data;
    const { timestamp, node: nodeName } = query;

    let connection;
    if (nodeName && nodeName !== 'local') {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
    }

    if (timestamp) {
      try {
        const content = await getSnapshotContent(filename, timestamp, connection);
        return new NextResponse(content);
      } catch {
        return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
      }
    }

    const history = await getHistory(filename, connection);
    return NextResponse.json(history);
  },
);
