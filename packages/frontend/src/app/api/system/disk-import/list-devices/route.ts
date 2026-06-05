import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listImportDevices } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode } from '../wiring';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/**
 * GET — enumerate removable partitions (USB) the user can import from
 * (`lsblk -J` host-side, filtered to removable + has-filesystem). Read-only;
 * `tokenScope: 'mutate'` keeps it consistent with the rest of the flow's
 * scoped-token use.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query, tokenScope: 'mutate' },
  async ({ query }) => {
    try {
      const node = resolveNode(query.node);
      const devices = await listImportDevices(makeExec(node));
      return NextResponse.json({ ok: true, devices });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:list-devices', status: 400, exposeMessage: true });
    }
  },
);
