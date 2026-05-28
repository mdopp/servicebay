import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { resolveBasicSyncApkUrl, isBasicSyncAbi, DEFAULT_BASICSYNC_ABI } from '@/lib/downloads/basicSync';

export const dynamic = 'force-dynamic';

const Query = z.object({ abi: z.string().optional() });

/**
 * GET /api/system/downloads/basicsync?abi=<arm64-v8a|armeabi-v7a|x86_64|x86>
 *
 * 302-redirects to the latest BasicSync APK for the requested Android ABI
 * (default arm64-v8a). Linked from the family-facing portal user guide, so
 * it's public (see proxy.ts) — it only ever redirects to a public GitHub
 * release asset, never anything sensitive.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    const abi = isBasicSyncAbi(query.abi) ? query.abi : DEFAULT_BASICSYNC_ABI;
    const url = await resolveBasicSyncApkUrl(abi);
    if (!url) {
      return NextResponse.json(
        { error: 'Could not resolve the latest BasicSync APK from GitHub. Try again shortly.' },
        { status: 502 },
      );
    }
    return NextResponse.redirect(url, 302);
  },
);
