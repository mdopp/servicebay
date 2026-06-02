import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getServicebayChannel, setServicebayChannel, CHANNELS } from '@/lib/servicebayChannel';

export const dynamic = 'force-dynamic';

/**
 * GET — which release channel the running ServiceBay container is pinned to.
 * POST { channel } — re-point it (`latest`/`dev`/`test`) and restart, so an
 * unreleased `:dev` build can be verified on the box without cutting a
 * release. `tokenScope: 'mutate'` lets the sb `channel` command drive it
 * with its scoped token; the restart is non-blocking so this returns first.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    return NextResponse.json({ channel: await getServicebayChannel() });
  } catch (error) {
    return apiError(error, { tag: 'api:system:channel:get', status: 500 });
  }
});

const PostBody = z.object({ channel: z.enum(CHANNELS) });

export const POST = withApiHandler<z.infer<typeof PostBody>>({ tokenScope: 'mutate', body: PostBody }, async ({ body }) => {
  try {
    await setServicebayChannel(body.channel);
    return NextResponse.json({
      ok: true,
      channel: body.channel,
      message: `Switching ServiceBay to '${body.channel}'. It will pull the image and restart — reconnect in ~1 minute.`,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:system:channel:post', status: 500 });
  }
});
